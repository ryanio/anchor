/**
 * The assembled pipeline: request → simulate → decide → submit → result.
 *
 * These test the seam rather than the rules — that a denial never reaches the signer, that the
 * signer refuses anything policy did not mint, that budget is released when submission fails, and
 * that the `Executor` an agent holds has no vocabulary for approving itself.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PolicyBoundExecutor, type Executor, type Signer } from "./executor.ts";
import { PolicyEngine } from "./policy.ts";
import { DeclaredIntentSimulator, FailingSigner, InertSigner } from "./inert.ts";
import { isMintedApproval, type ApprovedAction } from "./decision.ts";
import type { ActionRequest } from "./types.ts";
import {
  ACCOUNT,
  ATTACKER,
  COLD_VAULT,
  COLLECTION,
  buy,
  clock,
  limits,
  transfer,
  usd,
} from "./fixtures.ts";

/**
 * A full pipeline on one controllable clock.
 *
 * The clock is shared deliberately: the signer checks approval expiry, so a signer reading a
 * different clock from the policy would reject everything — which is a real deployment hazard worth
 * having the test harness mirror.
 */
function harness(): {
  executor: Executor;
  policy: PolicyEngine;
  signer: InertSigner;
  clock: ReturnType<typeof clock>;
} {
  const c = clock();
  const signer = new InertSigner(c.now);
  return { ...wire(c, signer), signer };
}

/** Same, with a signer of the caller's choosing. */
function harnessWith(makeSigner: (now: () => number) => Signer) {
  const c = clock();
  return wire(c, makeSigner(c.now));
}

function wire(c: ReturnType<typeof clock>, signer: Signer) {
  const policy = new PolicyEngine({ limits: limits(), now: c.now, policyVersion: "test/1" });
  const executor = new PolicyBoundExecutor({
    simulator: new DeclaredIntentSimulator(c.now),
    policy,
    signer,
    now: c.now,
  });
  return { executor, policy, clock: c };
}

describe("the happy path", () => {
  test("an in-policy buy reaches the signer and reports a receipt", async () => {
    const { executor, signer } = harness();
    const result = await executor.execute(buy("r1", 1_000n));

    assert.equal(result.status, "submitted");
    if (result.status !== "submitted") return;
    assert.equal(result.receipt.requestId, "r1");
    assert.equal(signer.submitted.length, 1);

    // The reference signer broadcasts nothing, and says so rather than pretending.
    assert.equal(result.receipt.broadcast, false);
    assert.equal(result.receipt.transactionHash, null);
    assert.match(result.receipt.signer, /inert/);
  });

  test("the approval handed to the signer carries a ceiling, not just a request", async () => {
    const { executor, signer } = harness();
    await executor.execute(buy("r1", 1_000n));
    const approval = signer.submitted[0];
    assert.ok(approval);
    assert.equal(approval.ceiling.amount, 1_000n);
    assert.equal(approval.request.id, "r1");
    assert.equal(isMintedApproval(approval), true);
  });

  test("a committed submission consumes rolling budget", async () => {
    const { executor, policy } = harness();
    await executor.execute(buy("r1", 2_000n));
    assert.equal((await policy.status()).rolling24hSpent.amount, 2_000n);
  });
});

describe("a denial never reaches the signer", () => {
  test("an over-cap request is rejected before submission", async () => {
    const { executor, signer } = harness();
    const result = await executor.execute(buy("r1", 99_999n));

    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "per-transaction-cap");
    assert.equal(signer.submitted.length, 0, "nothing was handed to the signer");
  });

  test("a transfer to an unregistered address never reaches the signer", async () => {
    const { executor, signer } = harness();
    const result = await executor.execute(transfer("r1", 100n, ATTACKER));
    assert.equal(result.status, "rejected");
    assert.equal(signer.submitted.length, 0);
  });

  test("setApprovalForAll never reaches the signer", async () => {
    const { executor, signer } = harness();
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
    const result = await executor.execute(request);
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "human-only-action");
    assert.equal(signer.submitted.length, 0);
  });

  test("a rejection still carries the simulation, so the log shows what was refused", async () => {
    const { executor } = harness();
    const result = await executor.execute(buy("r1", 99_999n));
    if (result.status !== "rejected") throw new Error("expected a rejection");
    assert.equal(result.simulation?.requestId, "r1");
  });
});

describe("the signer fails closed", () => {
  test("it refuses an approval no policy authority minted", async () => {
    // The cast is the attack: TypeScript alone would not stop a determined caller, so the signer
    // checks identity rather than shape.
    const forged = {
      approvalId: "forged",
      request: buy("r1", 1n),
      simulation: { requestId: "r1", ok: true, deltas: [], simulatedAt: 0, source: "x" },
      ceiling: usd(100_000_000n),
      expiresAt: Number.MAX_SAFE_INTEGER,
      decidedAt: 0,
      policyVersion: "self-approved",
    } as unknown as ApprovedAction;

    const signer = new InertSigner();
    await assert.rejects(() => signer.submit(forged), /not minted by a policy authority/);
    assert.equal(signer.submitted.length, 0);
  });

  test("it refuses an expired approval", async () => {
    const c = clock();
    const policy = new PolicyEngine({ limits: limits(), now: c.now });
    const simulator = new DeclaredIntentSimulator(c.now);
    const signer = new InertSigner(c.now);

    const request = buy("r1", 100n);
    const decision = await policy.evaluate(request, await simulator.simulate(request));
    if (decision.outcome !== "allow") throw new Error("expected allow");

    c.advance(60_001); // approvalTtlMs is 60_000
    await assert.rejects(() => signer.submit(decision.approval), /expired/);
  });

  test("a simulator that throws becomes a denial, not an exception", async () => {
    const c = clock();
    const policy = new PolicyEngine({ limits: limits(), now: c.now });
    const executor = new PolicyBoundExecutor({
      simulator: {
        simulate: () => Promise.reject(new Error("rpc unreachable")),
      },
      policy,
      signer: new InertSigner(c.now),
      now: c.now,
    });

    const result = await executor.execute(buy("r1", 100n));
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "simulation-failed");
    assert.match(result.decision.detail, /rpc unreachable/);
  });
});

describe("settlement", () => {
  test("a failed submission releases the reserved budget", async () => {
    const { executor, policy } = harnessWith(() => new FailingSigner("nonce too low"));
    const result = await executor.execute(buy("r1", 2_500n));

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.error, /nonce too low/);
    assert.equal(
      (await policy.status()).rolling24hSpent.amount,
      0n,
      "a submission that never happened must not consume the day's budget",
    );
  });

  test("preflight does not consume budget", async () => {
    const { executor, policy } = harness();
    const decision = await executor.preflight(buy("r1", 2_500n));
    assert.equal(decision.outcome, "allow");
    assert.equal((await policy.status()).rolling24hSpent.amount, 0n);
  });

  test("a preflight approval is not a permit — the request id is spent", async () => {
    // Preflight answers "would this be allowed", not "here is a token you may redeem later".
    const { executor, signer } = harness();
    await executor.preflight(buy("r1", 100n));
    const result = await executor.execute(buy("r1", 100n));
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "duplicate-request");
    assert.equal(signer.submitted.length, 0, "a preflight must never reach the signer");
  });
});

describe("the kill switch, through the Executor an agent holds", () => {
  test("revoke stops execution and the signer sees nothing more", async () => {
    const { executor, signer } = harness();
    assert.equal((await executor.execute(buy("r1", 100n))).status, "submitted");

    const receipt = await executor.revoke("user pulled it from their phone");
    assert.equal(receipt.revoked, true);

    const after = await executor.execute(buy("r2", 100n));
    assert.equal(after.status, "rejected");
    if (after.status !== "rejected") return;
    assert.equal(after.decision.reason, "revoked");
    assert.equal(signer.submitted.length, 1, "no further approvals reached the signer");
  });

  test("status is readable after revocation", async () => {
    const { executor } = harness();
    await executor.revoke("anomaly");
    const status = await executor.status();
    assert.equal(status.revoked, true);
    assert.equal(status.revokedReason, "anomaly");
  });

  test("the Executor interface offers no way to undo a revocation", async () => {
    const { executor } = harness();
    const asInterface: Executor = executor;
    // @ts-expect-error Reinstatement is a human action; it is not on the agent's interface.
    assert.equal(asInterface.reinstateByHuman, undefined);
  });
});

describe("the Executor interface cannot be used to self-approve", () => {
  test("no method accepts a decision, an approval, or a policy", () => {
    // A structural statement of the invariant: every verb the agent holds takes a *request* and
    // returns a *decision*. Decisions travel outward only. If a future method were added that took
    // an approval, this test would need editing — which is the point of writing it down.
    const { executor } = harness();
    const asInterface: Executor = executor;

    assert.deepEqual(
      ["execute", "preflight", "revoke", "status"].filter(
        (m) => typeof (asInterface as unknown as Record<string, unknown>)[m] === "function",
      ).sort(),
      ["execute", "preflight", "revoke", "status"],
    );

    const forged = { outcome: "allow" } as unknown as never;
    // @ts-expect-error execute() takes a request. There is no overload that takes a decision.
    void executor.execute(buy("r1", 1n), forged);
  });

  test("holding the signer without a policy authority gets you nothing", async () => {
    // The signer is the only thing that can act, and its single parameter is unconstructable.
    const signer = new InertSigner();
    // @ts-expect-error submit() takes an ApprovedAction, never a raw request.
    await assert.rejects(() => signer.submit(buy("r1", 1n)));
    assert.equal(signer.submitted.length, 0);
  });

  test("the withdrawal allowlist cannot be widened through the interface at run time", async () => {
    const { executor, policy } = harness();
    const before = (await policy.status()).withdrawalAllowlistSize;
    // There is no method for it — the closest an agent can do is ask, and be denied.
    const result = await executor.execute(transfer("r1", 100n, ATTACKER));
    assert.equal(result.status, "rejected");
    assert.equal((await policy.status()).withdrawalAllowlistSize, before);
    // And the pre-registered destination still works, so the control is a filter, not a wall.
    assert.equal((await executor.execute(transfer("r2", 100n, COLD_VAULT))).status, "submitted");
  });
});
