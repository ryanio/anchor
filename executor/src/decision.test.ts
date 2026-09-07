/**
 * Tests for the property the whole workspace exists to hold: the thing that requests cannot be the
 * thing that decides.
 *
 * Several of these are *compile-time* assertions written as `@ts-expect-error`. That is deliberate:
 * a `@ts-expect-error` on a line that stops being an error is itself a compile error, so if someone
 * removes the witness from `ApprovedAction` — making self-approval possible again — `npm run
 * typecheck` fails. The invariant is enforced by CI rather than by a comment asking nicely.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type ApprovedAction,
  allow,
  deny,
  isMintedApproval,
  isUsableApproval,
  mintApproval,
} from "./decision.ts";
import { buy, usd } from "./fixtures.ts";

const request = buy("req-1", 1_000n);
const simulation = {
  requestId: "req-1",
  ok: true as const,
  deltas: [],
  simulatedAt: 0,
  source: "test",
};

function mint(over: Partial<Parameters<typeof mintApproval>[0]> = {}): ApprovedAction {
  return mintApproval({
    approvalId: "a-1",
    request,
    simulation,
    ceiling: usd(1_000n),
    expiresAt: 60_000,
    decidedAt: 0,
    policyVersion: "test/1",
    ...over,
  });
}

describe("ApprovedAction cannot be forged", () => {
  test("an object literal with every visible field is not an ApprovedAction", () => {
    // The witness property is keyed by a `unique symbol` that decision.ts does not export, so it
    // cannot be named here — which is what makes the literal below un-writable.
    // @ts-expect-error Property '[POLICY_WITNESS]' is missing.
    const forged: ApprovedAction = {
      approvalId: "forged",
      request,
      simulation,
      ceiling: usd(100_000_000n),
      expiresAt: Number.MAX_SAFE_INTEGER,
      decidedAt: 0,
      policyVersion: "self-approved",
    };
    // The runtime layer catches it too, so a cast would not have helped.
    assert.equal(isMintedApproval(forged), false);
  });

  test("spreading a real approval produces something the signer rejects", () => {
    const real = mint();
    // Every *runtime* property of a real approval, copied. The witness has no runtime
    // representation at all, so there is nothing on the object to copy — and identity is not
    // copyable by construction.
    const copy = { ...real, ceiling: usd(999_999n) } as ApprovedAction;
    assert.equal(isMintedApproval(real), true);
    assert.equal(isMintedApproval(copy), false);
  });

  test("authority does not survive serialisation or cloning", () => {
    const real = mint();
    assert.equal(isMintedApproval(structuredClone(real)), false);
    const asJson = JSON.stringify(real, (_key, value) =>
      typeof value === "bigint" ? value.toString() : (value as unknown),
    );
    assert.equal(isMintedApproval(JSON.parse(asJson)), false);
  });

  test("non-objects are never approvals", () => {
    for (const value of [null, undefined, 0, "a-1", true, Symbol("a")]) {
      assert.equal(isMintedApproval(value), false);
    }
  });

  test("an approval past its expiry is no longer usable", () => {
    const real = mint({ expiresAt: 1_000 });
    assert.equal(isUsableApproval(real, 999), true);
    assert.equal(isUsableApproval(real, 1_000), false, "expiry is exclusive");
    assert.equal(isUsableApproval(real, 5_000), false);
  });
});

describe("decisions", () => {
  test("allow() carries the approval and echoes its provenance", () => {
    const decision = allow(mint({ approvalId: "a-9" }));
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.requestId, "req-1");
    assert.equal(decision.approval.approvalId, "a-9");
    assert.equal(decision.policyVersion, "test/1");
  });

  test("deny() carries a machine-readable reason, not just prose", () => {
    const decision = deny("per-transaction-cap", "too big", {
      requestId: "req-1",
      decidedAt: 5,
      policyVersion: "test/1",
    });
    assert.equal(decision.outcome, "deny");
    assert.equal(decision.reason, "per-transaction-cap");
    assert.equal(decision.detail, "too big");
  });

  test("narrowing a decision to `deny` gives no access to an approval", () => {
    const decision = deny("revoked", "off", {
      requestId: "req-1",
      decidedAt: 0,
      policyVersion: "test/1",
    });
    if (decision.outcome === "deny") {
      // @ts-expect-error A denial has no approval to reach for.
      assert.equal(decision.approval, undefined);
    }
  });
});
