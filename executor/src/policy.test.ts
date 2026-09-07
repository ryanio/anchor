/**
 * The reference policy engine's rules, tested as promises the project makes:
 * caps hold, cumulative caps hold *especially* against many small transactions, withdrawals only go
 * to pre-registered addresses, token approvals are refused as their own class, and the kill switch
 * stops everything.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Denied, PolicyDecision } from "./decision.ts";
import {
  ACCOUNT,
  ATTACKER,
  acceptOffer,
  buy,
  COLD_VAULT,
  COLLECTION,
  cancelOwnListing,
  clock,
  DENOM,
  limits,
  MARKETPLACE,
  OTHER_COLLECTION,
  transfer,
  usd,
} from "./fixtures.ts";
import { DeclaredIntentSimulator } from "./inert.ts";
import { PolicyEngine, type PolicyLimits, tierLimits } from "./policy.ts";
import { type ActionRequest, address, money, type Simulation } from "./types.ts";

/** Build an engine plus a cooperative simulator sharing one controllable clock. */
function engine(over: Partial<PolicyLimits> = {}) {
  const c = clock();
  const policy = new PolicyEngine({ limits: limits(over), now: c.now, policyVersion: "test/1" });
  const simulator = new DeclaredIntentSimulator(c.now);
  const decide = async (request: ActionRequest, sim?: Simulation): Promise<PolicyDecision> =>
    policy.evaluate(request, sim ?? (await simulator.simulate(request)));
  return { policy, simulator, decide, clock: c };
}

function denied(decision: PolicyDecision): Denied {
  assert.equal(decision.outcome, "deny", `expected a denial, got ${decision.outcome}`);
  return decision as Denied;
}

describe("per-transaction cap", () => {
  test("allows a buy at exactly the cap", async () => {
    const { decide } = engine();
    const decision = await decide(buy("r1", 2_500n));
    assert.equal(decision.outcome, "allow");
  });

  test("denies a buy one unit over the cap", async () => {
    const { decide } = engine();
    assert.equal(denied(await decide(buy("r1", 2_501n))).reason, "per-transaction-cap");
  });

  test("a transfer is charged at its valuation, not waved through as 'not a purchase'", async () => {
    const { decide } = engine();
    assert.equal(denied(await decide(transfer("r1", 9_999n, COLD_VAULT))).reason, "per-transaction-cap");
  });
});

describe("cumulative caps — the many-small-transactions evasion", () => {
  test("a hundred transactions each under the per-tx cap still hit the 24h cap", async () => {
    // Every one of these is legal on its own. That is the point: a per-transaction limit alone is
    // not a spend limit, and this is the shape the attack actually takes.
    const { decide, policy } = engine();
    const outcomes: string[] = [];
    for (let i = 0; i < 100; i++) {
      outcomes.push((await decide(buy(`r${i}`, 100n))).outcome);
    }

    const allowed = outcomes.filter((o) => o === "allow").length;
    assert.equal(allowed, 50, "5,000 cents of 24h budget at 100 cents each");
    assert.equal(outcomes.filter((o) => o === "deny").length, 50);

    const status = await policy.status();
    assert.equal(status.rolling24hSpent.amount, 5_000n);
    assert.equal(status.rolling24hSpent.amount <= status.rolling24hCap.amount, true);
  });

  test("the 24h window rolls: budget returns after 24 hours, not at midnight", async () => {
    const { decide, clock: c } = engine();
    assert.equal((await decide(buy("a", 2_500n))).outcome, "allow");
    assert.equal((await decide(buy("b", 2_500n))).outcome, "allow");
    assert.equal(denied(await decide(buy("c", 100n))).reason, "rolling-24h-cap");

    c.advance(23 * 3_600_000);
    assert.equal(denied(await decide(buy("d", 100n))).reason, "rolling-24h-cap");

    c.advance(2 * 3_600_000); // now 25h after the first pair
    assert.equal((await decide(buy("e", 2_500n))).outcome, "allow");
  });

  test("the 7d cap binds even when each day is within the daily cap", async () => {
    // 20,000 cents a week against 5,000 a day: the week runs out on day five.
    const { decide, clock: c } = engine();
    const allowedPerDay: number[] = [];
    for (let day = 0; day < 6; day++) {
      let allowed = 0;
      for (let i = 0; i < 2; i++) {
        if ((await decide(buy(`d${day}-${i}`, 2_500n))).outcome === "allow") allowed++;
      }
      allowedPerDay.push(allowed);
      c.advance(24 * 3_600_000 + 1);
    }
    assert.deepEqual(allowedPerDay, [2, 2, 2, 2, 0, 0], "week exhausted after four full days");
  });

  test("a reserved-but-unsettled approval still consumes budget", async () => {
    // Otherwise an agent could hold approvals open and mint unlimited headroom.
    const { decide, policy } = engine();
    assert.equal((await decide(buy("a", 2_500n))).outcome, "allow");
    assert.equal((await decide(buy("b", 2_500n))).outcome, "allow");
    assert.equal((await policy.status()).rolling24hSpent.amount, 5_000n);
    // Nothing was settled, yet the day's budget is gone. Each of these is well under the
    // per-transaction cap, so only the cumulative accounting can catch the third.
    assert.equal(denied(await decide(buy("c", 1n))).reason, "rolling-24h-cap");
  });

  test("a failed submission releases its reservation", async () => {
    const { decide, policy } = engine();
    const first = await decide(buy("a", 2_500n));
    assert.equal(first.outcome, "allow");
    if (first.outcome !== "allow") return;
    await policy.settle(first.approval, "failed");
    assert.equal((await policy.status()).rolling24hSpent.amount, 0n);
    assert.equal((await decide(buy("b", 2_500n))).outcome, "allow");
  });

  test("settling twice does not release budget twice", async () => {
    const { decide, policy } = engine();
    const first = await decide(buy("a", 2_500n));
    if (first.outcome !== "allow") throw new Error("expected allow");
    await policy.settle(first.approval, "committed");
    await policy.settle(first.approval, "failed");
    assert.equal((await policy.status()).rolling24hSpent.amount, 2_500n);
  });
});

describe("contract allowlist", () => {
  test("denies a contract that is not on the list", async () => {
    const { decide } = engine();
    const request = buy("r1", 100n, 0, { contract: OTHER_COLLECTION });
    assert.equal(denied(await decide(request)).reason, "contract-not-allowlisted");
  });

  test("a freshly deployed 'helpful' contract is not special", async () => {
    const { decide } = engine();
    const fresh = address(`0xfeed${"0".repeat(36)}`);
    assert.equal(
      denied(await decide(buy("r1", 1n, 0, { contract: fresh }))).reason,
      "contract-not-allowlisted",
    );
  });

  test("allowlist matching is case-insensitive on the address", async () => {
    const { decide } = engine();
    // `address()` normalises, so a checksummed string reaches policy as the same value.
    const checksummed = address(COLLECTION.toUpperCase().replace("0X", "0x"));
    assert.equal((await decide(buy("r1", 100n, 0, { contract: checksummed }))).outcome, "allow");
  });
});

describe("action allowlist", () => {
  test("denies an action that is not delegated", async () => {
    const { decide } = engine({ allowedActions: ["buy"] });
    assert.equal(denied(await decide(cancelOwnListing("r1"))).reason, "action-not-allowed");
  });

  test("cancelling its own listing is allowed and moves no value", async () => {
    const { decide, policy } = engine();
    assert.equal((await decide(cancelOwnListing("r1"))).outcome, "allow");
    assert.equal((await policy.status()).rolling24hSpent.amount, 0n);
  });

  test("accepting an offer below the configured floor is denied", async () => {
    const { decide } = engine({ minAcceptOfferProceeds: 10_000n });
    assert.equal(denied(await decide(acceptOffer("r1", 500n))).reason, "below-minimum-proceeds");
  });
});

describe("setApprovalForAll is a human-only action class", () => {
  test("it is refused, with its own reason code, before any cap is consulted", async () => {
    const { decide, policy } = engine();
    // Built inline and nowhere else. This request exists to be refused; there is no fixture for it
    // precisely so it cannot be lifted into working code (AGENTS.md invariant 3).
    const request: ActionRequest = {
      kind: "set-approval-for-all",
      id: "r1",
      requestedAt: 0,
      chain: "ethereum",
      account: ACCOUNT,
      contract: COLLECTION,
      operator: ATTACKER,
      approved: true,
    };

    const decision = await decide(request);
    assert.equal(denied(decision).reason, "human-only-action");
    // It moves no value, so it must not be judged on value — nothing was charged.
    assert.equal((await policy.status()).rolling24hSpent.amount, 0n);
  });

  test("it is refused even when the contract and operator are fully allowlisted", async () => {
    // The usual reason a control fails: everything about the request looks legitimate.
    const { decide } = engine({
      contractAllowlist: [COLLECTION],
      withdrawalAllowlist: [COLD_VAULT],
    });
    const request: ActionRequest = {
      kind: "set-approval-for-all",
      id: "r1",
      requestedAt: 0,
      chain: "ethereum",
      account: ACCOUNT,
      contract: COLLECTION,
      operator: COLD_VAULT,
      approved: true,
    };
    assert.equal(denied(await decide(request)).reason, "human-only-action");
  });

  test("revoking an approval is equally not delegable", async () => {
    // Even `approved: false` stays human-only: an agent that can toggle operator rights can toggle
    // them back on, and the safe rule is that it never holds the switch at all.
    const { decide } = engine();
    const request: ActionRequest = {
      kind: "set-approval-for-all",
      id: "r1",
      requestedAt: 0,
      chain: "ethereum",
      account: ACCOUNT,
      contract: COLLECTION,
      operator: ATTACKER,
      approved: false,
    };
    assert.equal(denied(await decide(request)).reason, "human-only-action");
  });

  test("it cannot be configured onto an action allowlist, at compile time or run time", () => {
    assert.throws(
      () =>
        new PolicyEngine({
          limits: limits({
            // @ts-expect-error `set-approval-for-all` is excluded from DelegableActionKind.
            allowedActions: ["buy", "set-approval-for-all"],
          }),
        }),
      /human-only action class/,
    );
  });
});

describe("withdrawal destination allowlist", () => {
  test("allows a transfer to a pre-registered address", async () => {
    const { decide } = engine();
    assert.equal((await decide(transfer("r1", 1_000n, COLD_VAULT))).outcome, "allow");
  });

  test("denies a transfer to an address the user never registered", async () => {
    const { decide } = engine();
    assert.equal(
      denied(await decide(transfer("r1", 1_000n, ATTACKER))).reason,
      "destination-not-allowlisted",
    );
  });

  test("denies a transfer whose simulation lands somewhere the request did not declare", async () => {
    // The declared destination is allowlisted; the actual effect is not. Believing the request
    // rather than the simulation is exactly the bug this check exists for.
    const { policy } = engine();
    const request = transfer("r1", 1_000n, COLD_VAULT);
    const lying: Simulation = {
      requestId: "r1",
      ok: true,
      deltas: [{ direction: "out", value: usd(1_000n), counterparty: ATTACKER, assetType: "erc721" }],
      simulatedAt: 0,
      source: "test",
    };
    assert.equal(denied(await policy.evaluate(request, lying)).reason, "simulation-mismatch");
  });

  test("an empty withdrawal allowlist means no transfers at all", async () => {
    const { decide } = engine({ withdrawalAllowlist: [] });
    assert.equal(denied(await decide(transfer("r1", 1n, COLD_VAULT))).reason, "destination-not-allowlisted");
  });

  test("the allowlist is not consulted for a marketplace purchase", async () => {
    // A buy sends value to a marketplace, which is not a withdrawal. Conflating the two would make
    // the agent useless; keeping them apart is why the check is per-action-kind.
    const { decide } = engine();
    assert.equal((await decide(buy("r1", 1_000n))).outcome, "allow");
  });
});

describe("simulation is mandatory", () => {
  test("a failed simulation is a denial", async () => {
    const { policy } = engine();
    const decision = await policy.evaluate(buy("r1", 100n), {
      requestId: "r1",
      ok: false,
      failure: "revert: insufficient balance",
      deltas: [],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "simulation-failed");
  });

  test("a simulation for a different request is a denial", async () => {
    const { policy } = engine();
    const decision = await policy.evaluate(buy("r1", 100n), {
      requestId: "someone-elses-request",
      ok: true,
      deltas: [],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "simulation-mismatch");
  });

  test("a buy that spends more than it declared is a denial", async () => {
    const { policy } = engine();
    const decision = await policy.evaluate(buy("r1", 100n), {
      requestId: "r1",
      ok: true,
      deltas: [
        { direction: "out", value: usd(2_000n), counterparty: MARKETPLACE, assetType: "erc20" },
        { direction: "in", value: usd(0n), counterparty: MARKETPLACE, assetType: "erc721" },
      ],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "simulation-mismatch");
  });

  test("a 'cancel' that quietly moves value is a denial", async () => {
    const { policy } = engine();
    const decision = await policy.evaluate(cancelOwnListing("r1"), {
      requestId: "r1",
      ok: true,
      deltas: [{ direction: "out", value: usd(500n), counterparty: ATTACKER, assetType: "erc20" }],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "simulation-mismatch");
  });

  test("caps are charged on gross outflow, so an incoming asset cannot net them away", async () => {
    // A wash trade — send real value out, book something worthless coming in — is how a net-flow
    // cap gets drained. Gross is the only safe accounting.
    const { policy } = engine();
    const decision = await policy.evaluate(buy("r1", 3_000n), {
      requestId: "r1",
      ok: true,
      deltas: [
        { direction: "out", value: usd(3_000n), counterparty: MARKETPLACE, assetType: "erc20" },
        { direction: "in", value: usd(3_000n), counterparty: MARKETPLACE, assetType: "erc721" },
      ],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "per-transaction-cap");
  });
});

describe("denominations are never converted", () => {
  test("a request in another unit is denied rather than converted", async () => {
    const { decide } = engine();
    const request = buy("r1", 1n, 0, { maxPrice: money(1n, "ETH-wei") });
    assert.equal(denied(await decide(request)).reason, "denomination-mismatch");
  });

  test("a simulation that moves an unjudgeable unit is denied", async () => {
    const { policy } = engine();
    const decision = await policy.evaluate(buy("r1", 100n), {
      requestId: "r1",
      ok: true,
      deltas: [
        { direction: "out", value: money(5n, "ETH-wei"), counterparty: MARKETPLACE, assetType: "native" },
        { direction: "in", value: usd(0n), counterparty: MARKETPLACE, assetType: "erc721" },
      ],
      simulatedAt: 0,
      source: "test",
    });
    assert.equal(denied(decision).reason, "denomination-mismatch");
  });
});

describe("replay", () => {
  test("a request id can only be decided once", async () => {
    const { decide } = engine();
    assert.equal((await decide(buy("r1", 100n))).outcome, "allow");
    assert.equal(denied(await decide(buy("r1", 100n))).reason, "duplicate-request");
  });

  test("a denied request id is spent too", async () => {
    const { decide } = engine();
    assert.equal(denied(await decide(buy("r1", 999_999n))).reason, "per-transaction-cap");
    assert.equal(denied(await decide(buy("r1", 1n))).reason, "duplicate-request");
  });
});

describe("kill switch", () => {
  test("revoke denies everything afterwards, ahead of every other check", async () => {
    const { decide, policy } = engine();
    assert.equal((await decide(buy("r1", 100n))).outcome, "allow");

    const receipt = await policy.revoke("phone kill switch");
    assert.equal(receipt.revoked, true);
    assert.equal(receipt.reason, "phone kill switch");

    // Even a request that would otherwise sail through.
    assert.equal(denied(await decide(buy("r2", 1n))).reason, "revoked");
    assert.equal(denied(await decide(cancelOwnListing("r3"))).reason, "revoked");
    assert.equal(denied(await decide(transfer("r4", 1n, COLD_VAULT))).reason, "revoked");
  });

  test("revoke is idempotent and keeps the first reason", async () => {
    const { policy } = engine();
    await policy.revoke("first");
    const second = await policy.revoke("second");
    assert.equal(second.reason, "first");
    assert.equal((await policy.status()).revokedReason, "first");
  });

  test("status reports revocation, so the UI can show it without asking permission first", async () => {
    const { policy } = engine();
    assert.equal((await policy.status()).revoked, false);
    await policy.revoke("anomaly");
    assert.equal((await policy.status()).revoked, true);
  });

  test("reinstatement is not reachable through the PolicyAuthority interface", async () => {
    const { policy } = engine();
    await policy.revoke("test");
    const asAuthority: import("./executor.ts").PolicyAuthority = policy;
    // @ts-expect-error Reinstating is a human action and is not on the interface an agent holds.
    assert.equal(typeof asAuthority.reinstateByHuman, "function");

    // On the concrete backend it exists, and it demands an audit note.
    assert.throws(() => policy.reinstateByHuman("  "), /operator note/);
    policy.reinstateByHuman("human confirmed the anomaly was a false positive");
    assert.equal((await policy.status()).revoked, false);
  });
});

describe("status and tiers", () => {
  test("status reports remaining authority without disclosing the allowlists themselves", async () => {
    const { policy } = engine();
    const status = await policy.status();
    assert.equal(status.denomination, DENOM);
    assert.equal(status.perTransactionCap.amount, 2_500n);
    assert.equal(status.contractAllowlistSize, 1);
    assert.equal(status.withdrawalAllowlistSize, 1);
  });

  test("tierLimits tracks the value ladder in docs/autonomy.md", () => {
    const lists = { contractAllowlist: [COLLECTION], withdrawalAllowlist: [COLD_VAULT] };
    assert.equal(tierLimits(1, lists).perTransaction, 2_500n);
    assert.equal(tierLimits(2, lists).rolling24h, 30_000n);
    assert.equal(tierLimits(3, lists).perTransaction, 100_000n);
    for (const tier of [1, 2, 3] as const) {
      assert.equal(
        (tierLimits(tier, lists).allowedActions as readonly string[]).includes("set-approval-for-all"),
        false,
      );
    }
  });

  test("negative caps are rejected at construction", () => {
    assert.throws(() => new PolicyEngine({ limits: limits({ perTransaction: -1n }) }), /negative/);
  });
});
