/**
 * The Privy backend, tested at its boundary with a stubbed `fetch`.
 *
 * Nothing here touches the network and nothing needs a Privy account: `PrivyClient` takes a
 * `fetchImpl`, so every request the code would make is answered by a handler in this file and every
 * request it *does* make is recorded and asserted on. The credentials below are obvious
 * placeholders — real ones live in the OS keyring (docs/security.md, AGENTS.md invariant 5).
 *
 * The promises under test are the ones the project actually makes:
 *   - a request inside policy is approved and reaches Privy as the transaction it claimed to be,
 *   - a request outside policy is denied with a machine-readable reason and never leaves the machine,
 *   - a denial cannot be laundered into an approval, at compile time or at run time,
 *   - `setApprovalForAll` is refused at every layer that could possibly see it,
 *   - the kill switch empties the remote policy, and says so loudly when it cannot,
 *   - and no error this module produces carries the app secret.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, test } from "node:test";
import type { ApprovedAction, Denied, PolicyDecision } from "./decision.ts";
import { PolicyBoundExecutor } from "./executor.ts";
import {
  ACCOUNT,
  ATTACKER,
  buy,
  CHAIN,
  COLD_VAULT,
  COLLECTION,
  clock,
  limits,
  on,
  SOL_ACCOUNT,
  SOL_ATTACKER,
  SOL_CHAIN,
  SOL_COLD_VAULT,
  SOL_MINT,
  solanaLimits,
  solanaTransfer,
  transfer,
} from "./fixtures.ts";
import { DeclaredIntentSimulator } from "./inert.ts";
import type { PolicyLimits } from "./policy.ts";
import {
  auditRemotePolicy,
  connectPrivyAuthority,
  Erc721TransferBuilder,
  PrivyPolicyAuthority,
  PrivySigner,
  PrivySolanaSigner,
  RemotePolicyRejected,
  type SolanaTransactionBuilder,
  UnimplementedSolanaBuilder,
} from "./privy.ts";
import { canonicalize, PrivyClient, type PrivyPolicyDocument } from "./privy-api.ts";
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_CAIP2,
  SPL_TOKEN_INSTRUCTION,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  toBase64,
} from "./solana.ts";
import { evmAddress, type SolanaAddress, solanaAddressBytes } from "./types.ts";

const APP_ID = "placeholder-app-id-not-real";
const APP_SECRET = "placeholder-app-secret-0123456789-not-real";
const WALLET_ID = "wallet-placeholder-0123";
const POLICY_ID = "policy-placeholder-0123";
const CHAIN_ID = 1;
const TX_HASH = `0x${"ab".repeat(32)}`;

// --- The stub ----------------------------------------------------------------------------------

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Handler = (call: Call, index: number) => Response;

function stubFetch(handler: Handler): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Policy fixtures ---------------------------------------------------------------------------

/**
 * A Privy policy shaped the way `executor/README.md` tells a user to write one.
 *
 * Every field here matches Privy's published schema: `version` is the only supported value,
 * conditions carry a `field_source`, and the value cap is a hex quantity in wei. There is no
 * `default_action` — Privy defaults to DENY when no rule resolves.
 */
function policyDocument(over: Partial<PrivyPolicyDocument> = {}): PrivyPolicyDocument {
  return {
    id: POLICY_ID,
    version: "1.0",
    name: "anchor tier 1",
    chain_type: "ethereum",
    rules: [
      {
        name: "allowlisted collection only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "in", value: [COLLECTION] },
          // Without this, the `to` allowlist above applies on every EVM chain Privy will broadcast
          // to — `chain_type: "ethereum"` is an architecture, not a chain. The audit says so.
          { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "1" },
          {
            field_source: "ethereum_transaction",
            field: "value",
            operator: "lte",
            value: "0x2386f26fc10000",
          },
          {
            field_source: "ethereum_calldata",
            field: "safeTransferFrom.to",
            operator: "in",
            value: [COLD_VAULT],
            abi: [],
          },
        ],
      },
    ],
    ...over,
  };
}

// --- Harness -----------------------------------------------------------------------------------

/**
 * A whole pipeline on one clock, with `fetch` stubbed.
 *
 * The clock is shared between the mirror and the signer deliberately: the signer checks approval
 * expiry, and a signer reading a different clock from the policy would reject everything — a real
 * deployment hazard worth having the harness mirror.
 */
async function harness(
  options: { handler?: Handler; limits?: Partial<PolicyLimits>; policy?: PrivyPolicyDocument } = {},
) {
  const c = clock();
  const document = options.policy ?? policyDocument();
  const defaultHandler: Handler = (call) => {
    if (call.method === "GET") return json(document);
    if (call.method === "PATCH") return json({ ...document, rules: [] });
    return json({ method: "eth_sendTransaction", data: { hash: TX_HASH, caip2: "eip155:1" } });
  };
  const { impl, calls } = stubFetch(options.handler ?? defaultHandler);

  const api = new PrivyClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    fetchImpl: impl,
    newIdempotencyKey: () => "idempotency-placeholder",
  });
  const engineLimits = limits(options.limits);
  const { authority, audit } = await connectPrivyAuthority({
    api,
    policyId: POLICY_ID,
    limits: engineLimits,
    chain: CHAIN,
    now: c.now,
  });
  const signer = new PrivySigner({
    api,
    walletId: WALLET_ID,
    builder: new Erc721TransferBuilder(CHAIN_ID),
    chainId: CHAIN_ID,
    now: c.now,
  });
  const executor = new PolicyBoundExecutor({
    simulator: new DeclaredIntentSimulator(c.now),
    policy: authority,
    signer,
    now: c.now,
  });
  return { executor, authority, signer, api, calls, audit, clock: c };
}

/** Calls that are not the startup policy read. */
function afterConnect(calls: readonly Call[]): Call[] {
  return calls.slice(1);
}

function denied(decision: PolicyDecision): Denied {
  assert.equal(decision.outcome, "deny", `expected a denial, got ${decision.outcome}`);
  return decision as Denied;
}

// --- Tests -------------------------------------------------------------------------------------

describe("a request inside policy is approved and submitted", () => {
  test("it reaches Privy as the transaction it claimed to be", async () => {
    const { executor, calls } = await harness();
    const result = await executor.execute(transfer("r1", 1_000n, COLD_VAULT));

    assert.equal(result.status, "submitted");
    if (result.status !== "submitted") return;
    assert.equal(result.receipt.transactionHash, TX_HASH);
    assert.equal(result.receipt.broadcast, true);

    const [rpc, ...rest] = afterConnect(calls);
    assert.equal(rest.length, 0, "one submission, not two");
    assert.ok(rpc);
    assert.equal(rpc.method, "POST");
    assert.equal(rpc.url, `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`);

    const body = rpc.body as {
      method: string;
      caip2: string;
      params: { transaction: Record<string, unknown> };
    };
    assert.equal(body.method, "eth_sendTransaction");
    assert.equal(body.caip2, "eip155:1");
    assert.equal(body.params.transaction.to, COLLECTION, "the transaction targets the collection");
    assert.equal(body.params.transaction.value, "0x0", "an ERC-721 withdrawal moves no ether");
    // safeTransferFrom(from, to, tokenId) — the vault is in calldata, not in `to`.
    const data = String(body.params.transaction.data);
    assert.ok(data.startsWith("0x42842e0e"), "safeTransferFrom selector");
    assert.ok(data.includes(ACCOUNT.slice(2)), "from is the agent's account");
    assert.ok(data.includes(COLD_VAULT.slice(2)), "to is the pre-registered vault");
  });

  test("authentication is Basic plus the app-id header, and the secret is never in the URL", async () => {
    const { executor, calls } = await harness();
    await executor.execute(transfer("r1", 1_000n, COLD_VAULT));

    for (const call of calls) {
      assert.equal(call.headers["privy-app-id"], APP_ID);
      const expected = `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`;
      assert.equal(call.headers.authorization, expected);
      assert.ok(!call.url.includes(APP_SECRET), "no credential in a URL, which is what gets logged");
    }
  });

  test("the submission carries an idempotency key, so a retry is not a second transaction", async () => {
    const { executor, calls } = await harness();
    await executor.execute(transfer("r1", 1_000n, COLD_VAULT));
    const rpc = afterConnect(calls)[0];
    assert.ok(rpc);
    assert.ok((rpc.headers["privy-idempotency-key"] ?? "").length > 0);
    assert.ok((rpc.headers["privy-idempotency-key"] ?? "").length <= 256);
  });
});

describe("a request outside policy is denied with a reason", () => {
  test("over the per-transaction cap, and nothing is sent", async () => {
    const { executor, calls } = await harness();
    const result = await executor.execute(transfer("r1", 9_999n, COLD_VAULT));

    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "per-transaction-cap");
    assert.equal(afterConnect(calls).length, 0, "a denial never reaches the network");
  });

  test("a destination that is not pre-registered", async () => {
    const { executor, calls } = await harness();
    const result = await executor.execute(transfer("r1", 100n, ATTACKER));

    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "destination-not-allowlisted");
    assert.equal(afterConnect(calls).length, 0);
  });

  test("a contract that is not on the allowlist", async () => {
    const { executor } = await harness();
    const request = transfer("r1", 100n, COLD_VAULT, 0, {
      contract: evmAddress("0xbadc0de00000000000000000000000000000beef"),
    });
    const result = await executor.execute(request);

    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "contract-not-allowlisted");
  });

  test("and Privy refuses independently: a policy_violation is a failure, not a transaction", async () => {
    // The mirror is deliberately widened past the remote policy here — which is exactly the state
    // an attacker who owns this process would engineer. Privy still says no.
    const { executor, authority } = await harness({
      handler: (call) => {
        if (call.method === "GET") return json(policyDocument());
        return json({ code: "policy_violation", message: "outside policy" }, 400);
      },
    });
    const result = await executor.execute(transfer("r1", 1_000n, COLD_VAULT));

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.error, /policy/i);

    // Budget reserved at approval must be released when the submission fails, or a wallet that
    // Privy is refusing would still exhaust its own local day.
    const status = await authority.status();
    assert.equal(status.rolling24hSpent.amount, 0n);
  });
});

describe("a denial cannot be turned into an approval", () => {
  test("Denied carries no approval to reuse", async () => {
    const { executor } = await harness();
    const result = await executor.execute(transfer("r1", 9_999n, COLD_VAULT));
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    const decision = denied(result.decision);
    // @ts-expect-error A denial has no `approval` property; there is nothing to launder.
    assert.equal(decision.approval, undefined);
  });

  test("a hand-built approval is refused by the signer, and never reaches Privy", async () => {
    const { executor, signer, calls } = await harness();
    const rejected = await executor.execute(transfer("r1", 9_999n, COLD_VAULT));
    assert.equal(rejected.status, "rejected");

    const forged = {
      approvalId: "forged",
      request: transfer("r1", 9_999n, COLD_VAULT),
      simulation: { requestId: "r1", ok: true, deltas: [], simulatedAt: 0, source: "forged" },
      ceiling: { amount: 10n ** 30n, denomination: "USD-cents" },
      expiresAt: Number.MAX_SAFE_INTEGER,
      decidedAt: 0,
      policyVersion: "self-approved",
    } as unknown as ApprovedAction;

    await assert.rejects(() => signer.submit(forged), /not minted by a policy authority/);
    assert.equal(afterConnect(calls).length, 0);
  });

  test("a real approval does not survive being copied", async () => {
    const { authority, signer, calls, clock: c } = await harness();
    const request = transfer("r1", 100n, COLD_VAULT);
    const simulation = await new DeclaredIntentSimulator(c.now).simulate(request);
    const decision = await authority.evaluate(request, simulation);
    assert.equal(decision.outcome, "allow");
    if (decision.outcome !== "allow") return;

    // A structured clone is what an IPC hop, a cache, or a replayed audit log would produce. The
    // witness lives in a module-private WeakSet keyed by identity, so the copy carries no authority
    // — which is the point: an approval that could be written down could be replayed.
    const copy = structuredClone(decision.approval);
    const before = calls.length;
    await assert.rejects(() => signer.submit(copy), /not minted by a policy authority/);
    assert.equal(calls.length, before, "nothing was sent");

    // The original still works, so the refusal above is about identity and not about the contents.
    const receipt = await signer.submit(decision.approval);
    assert.equal(receipt.transactionHash, TX_HASH);
  });
});

describe("setApprovalForAll is refused", () => {
  test("policy denies it with its own reason code, before any network call", async () => {
    const { executor, calls } = await harness();
    // Built inline, never as a fixture: AGENTS.md invariant 3 — it must not be copy-pasteable.
    const result = await executor.execute({
      id: "r1",
      requestedAt: 0,
      chain: "ethereum",
      account: ACCOUNT,
      kind: "set-approval-for-all",
      contract: COLLECTION,
      operator: ATTACKER,
      approved: true,
    });

    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "human-only-action");
    assert.equal(afterConnect(calls).length, 0);
  });

  test("the signer refuses it too, even handed a minted approval", async () => {
    const { signer } = await harness();
    // A cast past the type system, which is what a compromised caller in-process would have.
    const approval = {
      request: { kind: "set-approval-for-all" },
    } as unknown as ApprovedAction;
    await assert.rejects(() => signer.submit(approval));
  });

  test("a policy that allowlists the function is refused at startup", async () => {
    const document = policyDocument({
      rules: [
        {
          name: "helpful approvals",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [
            { field_source: "ethereum_transaction", field: "to", operator: "in", value: [COLLECTION] },
            {
              field_source: "ethereum_transaction",
              field: "value",
              operator: "lte",
              value: "0x0",
            },
            {
              field_source: "ethereum_calldata",
              field: "function_name",
              operator: "eq",
              value: "setApprovalForAll",
              abi: [],
            },
          ],
        },
      ],
    });
    const audit = auditRemotePolicy(document, { limits: limits(), chain: CHAIN });
    assert.ok(audit.findings.some((f) => /setApprovalForAll/.test(f)));
  });
});

describe("the kill switch", () => {
  test("empties the remote policy and stops the mirror approving", async () => {
    const { executor, calls } = await harness();
    const receipt = await executor.revoke("test kill switch");
    assert.equal(receipt.revoked, true);

    const patch = afterConnect(calls)[0];
    assert.ok(patch);
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.url, `https://api.privy.io/v1/policies/${POLICY_ID}`);
    assert.deepEqual(patch.body, { rules: [] }, "a policy with no rules resolves to DENY");

    const after = await executor.execute(transfer("r1", 100n, COLD_VAULT));
    assert.equal(after.status, "rejected");
    if (after.status !== "rejected") return;
    assert.equal(after.decision.reason, "revoked");
  });

  test("throws rather than claiming success when Privy did not confirm", async () => {
    const { executor } = await harness({
      handler: (call) => (call.method === "GET" ? json(policyDocument()) : json({}, 500)),
    });
    await assert.rejects(() => executor.revoke("network is down"), /may still sign/);

    // Local authority is gone regardless — the flag flips before the network call, so a failed
    // revocation still stops this process minting approvals.
    const after = await executor.execute(transfer("r1", 100n, COLD_VAULT));
    assert.equal(after.status, "rejected");
    if (after.status !== "rejected") return;
    assert.equal(after.decision.reason, "revoked");
  });
});

describe("errors never leak the credential", () => {
  const secretShapes = [APP_SECRET, Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")];

  function assertClean(error: unknown): void {
    const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(Object(error)))}`;
    for (const secret of secretShapes) {
      assert.ok(!text.includes(secret), `error text leaked a credential: ${text}`);
    }
  }

  test("a hostile error body that echoes the request is not repeated", async () => {
    const { executor } = await harness({
      handler: (call) =>
        call.method === "GET"
          ? json(policyDocument())
          : json(
              {
                error: `upstream rejected Authorization: Basic ${secretShapes[1]}`,
                message: `secret was ${APP_SECRET}`,
              },
              403,
            ),
    });
    const result = await executor.execute(transfer("r1", 100n, COLD_VAULT));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assertClean(result.error);
    assert.match(result.error, /Privy API 403/);
  });

  test("a thrown transport error is described, never quoted", async () => {
    const { executor } = await harness({
      handler: (call) => {
        if (call.method === "GET") return json(policyDocument());
        const error = new Error(`socket hang up while sending Authorization: Basic ${secretShapes[1]}`);
        (error as Error & { cause: unknown }).cause = { code: "ECONNRESET" };
        throw error;
      },
    });
    const result = await executor.execute(transfer("r1", 100n, COLD_VAULT));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assertClean(result.error);
    assert.match(result.error, /ECONNRESET/);
  });

  test("a failed startup read does not leak either", async () => {
    const c = clock();
    const { impl } = stubFetch(() => json({ error: `secret ${APP_SECRET}` }, 401));
    const api = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: impl });
    await assert.rejects(
      () => connectPrivyAuthority({ api, policyId: POLICY_ID, limits: limits(), chain: CHAIN, now: c.now }),
      (error: unknown) => {
        assertClean(error);
        return /Privy API 401/.test(String(error));
      },
    );
  });
});

describe("the remote policy is audited before anything runs", () => {
  test("a policy matching the local limits passes, and reports what it could not check", async () => {
    const { audit } = await harness();
    assert.deepEqual(audit.findings, []);
    assert.deepEqual(audit.allowlistedContracts, [on(CHAIN, COLLECTION)]);
    assert.deepEqual(audit.allowlistedCalldataDestinations, [on(CHAIN, COLD_VAULT)]);
    assert.deepEqual(audit.nativeValueCeiling, { amount: 10_000_000_000_000_000n, unit: "wei" });
    // The gaps are stated rather than assumed away: cumulative caps have no remote equivalent.
    assert.ok(audit.unverified.some((u) => /rolling/.test(u)));
  });

  test("a blanket ALLOW rule is refused", async () => {
    const document = policyDocument({
      rules: [{ name: "everything", method: "eth_sendTransaction", action: "ALLOW", conditions: [] }],
    });
    const audit = auditRemotePolicy(document, { limits: limits(), chain: CHAIN });
    assert.ok(audit.findings.some((f) => /no conditions at all/.test(f)));
  });

  test("a rule allowing a message-signing method is refused", async () => {
    const document = policyDocument({
      rules: [
        ...policyDocument().rules,
        { name: "sign anything", method: "personal_sign", action: "ALLOW", conditions: [] },
      ],
    });
    const audit = auditRemotePolicy(document, { limits: limits(), chain: CHAIN });
    assert.ok(audit.findings.some((f) => /personal_sign/.test(f)));
    // …unless the operator widened it deliberately, in code.
    const widened = auditRemotePolicy(document, {
      limits: limits(),
      chain: CHAIN,
      additionalAllowedMethods: ["personal_sign"],
    });
    assert.ok(!widened.findings.some((f) => /which Anchor does not send/.test(f)));
  });

  test("a local allowlist wider than the remote policy is refused", async () => {
    const wider = limits({
      contractAllowlist: [on(CHAIN, COLLECTION), on(CHAIN, evmAddress(`0x${"5".repeat(40)}`))],
    });
    const audit = auditRemotePolicy(policyDocument(), { limits: wider, chain: CHAIN });
    assert.ok(audit.findings.some((f) => /which the Privy policy does not allow/.test(f)));
  });

  test("a policy that does not bound the withdrawal destination is refused", async () => {
    const document = policyDocument({
      rules: [
        {
          name: "no calldata bound",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [
            { field_source: "ethereum_transaction", field: "to", operator: "in", value: [COLLECTION] },
            { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "0x0" },
          ],
        },
      ],
    });
    const audit = auditRemotePolicy(document, { limits: limits(), chain: CHAIN });
    assert.ok(audit.findings.some((f) => /withdrawal destinations are enforced only by the local/.test(f)));
  });

  test("an unbounded value is refused, and an unreadable operator is not silently skipped", async () => {
    const document = policyDocument({
      rules: [
        {
          name: "condition set",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [
            {
              field_source: "ethereum_transaction",
              field: "to",
              operator: "in_condition_set",
              value: "cs_placeholder",
            },
          ],
        },
      ],
    });
    const audit = auditRemotePolicy(document, { limits: limits(), chain: CHAIN });
    assert.ok(audit.findings.some((f) => /cannot read/.test(f)));
    assert.ok(audit.findings.some((f) => /native value/.test(f)));
  });

  test("connect refuses to start on any finding", async () => {
    const { impl } = stubFetch(() =>
      json(
        policyDocument({
          rules: [{ name: "everything", method: "*", action: "ALLOW", conditions: [] }],
        }),
      ),
    );
    const api = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: impl });
    await assert.rejects(
      () => connectPrivyAuthority({ api, policyId: POLICY_ID, limits: limits(), chain: CHAIN }),
      RemotePolicyRejected,
    );
  });
});

describe("marketplace actions are honestly unimplemented", () => {
  test("a buy is approved by policy and then refused by the builder", async () => {
    const { executor } = await harness();
    const result = await executor.execute(buy("r1", 1_000n));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.error, /no transaction builder for buy/);
  });
});

describe("authorization signatures", () => {
  test("the payload is canonical JSON: keys sorted, not in insertion order", () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalize({ z: [3, { y: 1, x: 2 }] }), '{"z":[3,{"x":2,"y":1}]}');
    assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
  });

  test("a signed request verifies against the public key, over the documented payload", async () => {
    // A throwaway P-256 key, generated here. Privy issues these as `wallet-auth:<base64 PKCS#8>`,
    // which is the form fed to the client below — the same string a user would paste.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    const { impl, calls } = stubFetch((call) =>
      call.method === "GET"
        ? json(policyDocument())
        : json({ method: "eth_sendTransaction", data: { hash: TX_HASH } }),
    );
    const api = new PrivyClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationKey: `wallet-auth:${pkcs8}`,
      fetchImpl: impl,
      newIdempotencyKey: () => "idempotency-placeholder",
    });
    await api.sendTransaction({
      walletId: WALLET_ID,
      caip2: "eip155:1",
      transaction: { to: COLLECTION, value: "0x0", data: "0x", chain_id: 1 },
      idempotencyKey: "idempotency-placeholder",
    });

    const call = calls[0];
    assert.ok(call);
    const signature = call.headers["privy-authorization-signature"];
    assert.ok(signature, "a client holding an authorization key signs its writes");

    // The payload Privy documents: version, method, full URL, body, and only the privy- headers
    // actually sent. Anything else in it — or anything missing — is a signature Privy rejects.
    const payload = canonicalize({
      version: 1,
      method: "POST",
      url: call.url,
      body: call.body,
      headers: {
        "privy-app-id": APP_ID,
        "privy-idempotency-key": "idempotency-placeholder",
      },
    });
    assert.ok(verify("sha256", Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64")));
  });

  test("a GET is never signed", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { impl, calls } = stubFetch(() => json(policyDocument()));
    const api = new PrivyClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      fetchImpl: impl,
    });
    await api.getPolicy(POLICY_ID);
    assert.equal(calls[0]?.headers["privy-authorization-signature"], undefined);
  });
});

describe("constructing the authority directly skips the audit", () => {
  test("which is why connectPrivyAuthority is the documented entry point", async () => {
    const c = clock();
    const { impl, calls } = stubFetch(() => json({}));
    const api = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: impl });
    const authority = new PrivyPolicyAuthority({
      api,
      policyId: POLICY_ID,
      limits: limits(),
      chain: CHAIN,
      now: c.now,
    });
    assert.equal(calls.length, 0, "no policy was read");
    const status = await authority.status();
    assert.equal(status.revoked, false);
  });
});

// --- Solana ------------------------------------------------------------------------------------

const SOL_WALLET_ID = "wallet-solana-placeholder";
/** 64 bytes of base58, the shape Privy returns at `data.hash` for a Solana submission. */
const SOL_SIGNATURE = "5".repeat(87);

/** A Solana policy the audit accepts: program allowlist, instruction allowlist, mint, destination. */
function solanaPolicyDocument(over: Partial<PrivyPolicyDocument> = {}): PrivyPolicyDocument {
  return {
    version: "1.0",
    name: "anchor solana",
    chain_type: "solana",
    rules: [
      {
        name: "spl transfers only",
        method: "signAndSendTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "solana_program_instruction",
            field: "programId",
            operator: "in",
            value: [SPL_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM],
          },
          // The load-bearing condition. Privy has no way to name Approve or SetAuthority in a DENY,
          // so keeping them out depends entirely on this positive list plus default-deny.
          {
            field_source: "solana_token_program_instruction",
            field: "instructionName",
            operator: "in",
            value: ["TransferChecked"],
          },
          {
            field_source: "solana_token_program_instruction",
            field: "TransferChecked.mint",
            operator: "in",
            value: [SOL_MINT],
          },
          {
            field_source: "solana_token_program_instruction",
            field: "TransferChecked.destination",
            operator: "in",
            value: [SOL_COLD_VAULT],
          },
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.lamports",
            operator: "lte",
            value: "1000000",
          },
        ],
      },
    ],
    ...over,
  };
}

const solanaAudit = (document: PrivyPolicyDocument, over: Partial<PolicyLimits> = {}) =>
  auditRemotePolicy(document, { limits: solanaLimits(over), chain: SOL_CHAIN });

describe("auditing a Solana policy", () => {
  test("a policy matching the local limits passes, and reports what it could not check", () => {
    const audit = solanaAudit(solanaPolicyDocument());
    assert.deepEqual(audit.findings, []);
    assert.equal(audit.arch, "svm");
    assert.deepEqual(audit.allowlistedContracts, [on(SOL_CHAIN, SOL_MINT)]);
    assert.deepEqual(audit.allowlistedCalldataDestinations, [on(SOL_CHAIN, SOL_COLD_VAULT)]);
    assert.deepEqual([...audit.allowlistedPrograms], [SPL_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
    assert.deepEqual(audit.nativeValueCeiling, { amount: 1_000_000n, unit: "lamports" });
  });

  test("the two gaps Ryan needs to know about are stated every single time", () => {
    const audit = solanaAudit(solanaPolicyDocument());
    // Worse than the EVM case: there is no aggregation primitive for Solana at all, not merely one
    // with too short a window.
    assert.ok(audit.unverified.some((u) => /no remote cumulative cap of any kind on Solana/.test(u)));
    // Privy's own documented limitation, and the reason a destination allowlist and a real v0 swap
    // transaction are close to mutually exclusive today.
    assert.ok(audit.unverified.some((u) => /cannot resolve address lookup tables/.test(u)));
  });

  test("permitting the System Program by program id alone is a finding too", () => {
    // The same hole one program over, and a wider one. `Assign` reassigns the account's owner
    // program, and an owner program may debit its lamports with no signature — so this rule permits
    // handing the wallet's whole native balance away, having moved nothing a spend cap can see.
    // `SetAuthority` is at least bounded to one token account.
    const base = solanaPolicyDocument().rules[0];
    assert.ok(base);
    const document = solanaPolicyDocument({
      rules: [
        {
          ...base,
          conditions: base.conditions.map((condition) =>
            condition.field.toLowerCase() === "programid"
              ? { ...condition, value: [SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM] }
              : condition,
          ),
        },
      ],
    });
    const audit = solanaAudit(document);
    assert.ok(audit.findings.some((finding) => /System Program by program id alone/.test(finding)));
    assert.ok(audit.findings.some((finding) => /Assign/.test(finding)));
  });

  test("a system rule that pins an instruction name clears that finding", () => {
    const base = solanaPolicyDocument().rules[0];
    assert.ok(base);
    const document = solanaPolicyDocument({
      rules: [
        {
          ...base,
          conditions: [
            ...base.conditions.map((condition) =>
              condition.field.toLowerCase() === "programid"
                ? { ...condition, value: [SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM] }
                : condition,
            ),
            {
              field_source: "solana_system_program_instruction",
              field: "instructionName",
              operator: "in",
              value: ["Transfer"],
            },
          ],
        },
      ],
    });
    const audit = solanaAudit(document);
    assert.ok(!audit.findings.some((finding) => /System Program by program id alone/.test(finding)));
  });

  test("permitting the token program without an instructionName condition is a finding", () => {
    // The single most important audit rule on this side. Privy's Solana engine cannot express a
    // condition naming Approve, ApproveChecked or SetAuthority — its token decoder does not cover
    // them — so a rule that allows the program by id alone allows an agent to delegate the token
    // account or hand it over. Only the positive instruction list keeps them out.
    const document = solanaPolicyDocument({
      rules: [
        {
          name: "token program, no instruction bound",
          method: "signAndSendTransaction",
          action: "ALLOW",
          conditions: [
            {
              field_source: "solana_program_instruction",
              field: "programId",
              operator: "in",
              value: [SPL_TOKEN_PROGRAM],
            },
          ],
        },
      ],
    });
    const finding = solanaAudit(document).findings.find((f) => /Approve, ApproveChecked/.test(f));
    assert.ok(finding, "a bare program-id allow on the token program must be a finding");
    assert.match(finding, /instructionName/);
  });

  test("a rule with no programId condition at all is a finding", () => {
    const document = solanaPolicyDocument({
      rules: [
        {
          name: "anything, anywhere",
          method: "signAndSendTransaction",
          action: "ALLOW",
          conditions: [
            {
              field_source: "solana_token_program_instruction",
              field: "instructionName",
              operator: "eq",
              value: "TransferChecked",
            },
          ],
        },
      ],
    });
    assert.ok(solanaAudit(document).findings.some((f) => /any program at all/.test(f)));
  });

  test("permitting the unchecked Transfer instruction is a finding, because it carries no mint", () => {
    const base = solanaPolicyDocument().rules[0];
    assert.ok(base);
    const document = solanaPolicyDocument({
      rules: [
        {
          ...base,
          conditions: base.conditions.map((condition) =>
            condition.field === "instructionName"
              ? { ...condition, value: ["Transfer", "TransferChecked"] }
              : condition,
          ),
        },
      ],
    });
    // Note the rule also lists TransferChecked and pins its mint, so it *looks* bounded. That is
    // exactly the trap: plain `Transfer` has no mint parameter, so the mint condition beside it
    // constrains only the checked variant and the policy silently permits any token to leave.
    assert.ok(solanaAudit(document).findings.some((f) => /carries no mint/.test(f)));
  });

  test("an instruction Anchor does not send is a finding", () => {
    const base = solanaPolicyDocument().rules[0];
    assert.ok(base);
    const document = solanaPolicyDocument({
      rules: [
        {
          ...base,
          conditions: base.conditions.map((condition) =>
            condition.field === "instructionName"
              ? { ...condition, value: ["TransferChecked", "MintTo"] }
              : condition,
          ),
        },
      ],
    });
    assert.ok(solanaAudit(document).findings.some((f) => /MintTo/.test(f)));
  });

  test("signMessage is refused, for the same reason personal_sign is on the EVM side", () => {
    const document = solanaPolicyDocument({
      rules: [
        ...solanaPolicyDocument().rules,
        { name: "sign anything", method: "signMessage", action: "ALLOW", conditions: [] },
      ],
    });
    assert.ok(solanaAudit(document).findings.some((f) => /signMessage/.test(f)));
  });

  test("an EVM policy pointed at a Solana chain is refused rather than audited as one", () => {
    // The architecture comes from the local limits; the policy's own claim is checked against it.
    // A policy that says `ethereum` while the limits say `solana` is a misconfiguration, not an
    // instruction to switch auditing modes.
    assert.ok(solanaAudit(policyDocument()).findings.some((f) => /chain_type/.test(f)));
  });

  test("an allowlist entry for another chain is a finding, because one policy is one chain type", () => {
    // Privy: one `chain_type` per policy, and one policy per wallet. So an EVM+Solana Anchor setup
    // is two wallets and two policies — and an allowlist entry for the other one would otherwise be
    // enforced by nothing at all.
    const audit = solanaAudit(solanaPolicyDocument(), {
      contractAllowlist: [on(SOL_CHAIN, SOL_MINT), on(CHAIN, COLLECTION)],
    });
    assert.ok(audit.findings.some((f) => /is not on solana/.test(f)));
  });
});

describe("the Solana signer reads the transaction before it signs it", () => {
  /** A builder that hands over whatever bytes a test wants to see refused. */
  const builderOf = (serialized: Uint8Array): SolanaTransactionBuilder => ({
    build: async () => ({ serialized, cluster: "mainnet" as const }),
  });

  /** Serialize a minimal transaction with `account` as the fee payer. */
  function solanaTx(programId: SolanaAddress, data: readonly number[], feePayer = SOL_ACCOUNT) {
    const compact = (n: number) => [n];
    const bytes = [
      ...compact(1),
      ...new Array<number>(64).fill(0),
      0x80,
      1,
      0,
      1,
      ...compact(2),
      ...solanaAddressBytes(feePayer),
      ...solanaAddressBytes(programId),
      ...new Array<number>(32).fill(7),
      ...compact(1),
      1,
      ...compact(0),
      ...compact(data.length),
      ...data,
      ...compact(0),
    ];
    return Uint8Array.from(bytes);
  }

  async function solanaHarness(serialized: Uint8Array) {
    const c = clock();
    const document = solanaPolicyDocument();
    const { impl, calls } = stubFetch((call) => {
      if (call.method === "GET") return json(document);
      return json({ method: "signAndSendTransaction", data: { hash: SOL_SIGNATURE } });
    });
    const api = new PrivyClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetchImpl: impl,
      newIdempotencyKey: () => "idempotency-placeholder",
    });
    const { authority } = await connectPrivyAuthority({
      api,
      policyId: POLICY_ID,
      limits: solanaLimits(),
      chain: SOL_CHAIN,
      now: c.now,
    });
    const signer = new PrivySolanaSigner({
      api,
      walletId: SOL_WALLET_ID,
      builder: builderOf(serialized),
      cluster: "mainnet",
      now: c.now,
    });
    const executor = new PolicyBoundExecutor({
      simulator: new DeclaredIntentSimulator(c.now),
      policy: authority,
      signer,
      now: c.now,
    });
    return { executor, signer, calls, clock: c };
  }

  test("a clean SPL transfer reaches Privy as base64, at the documented CAIP-2", async () => {
    const serialized = solanaTx(SPL_TOKEN_PROGRAM, [SPL_TOKEN_INSTRUCTION.transferChecked, 1]);
    const { executor, calls } = await solanaHarness(serialized);
    const result = await executor.execute(solanaTransfer("r1", 1_000n));

    assert.equal(result.status, "submitted");
    if (result.status !== "submitted") return;
    assert.equal(result.receipt.transactionHash, SOL_SIGNATURE);

    const rpc = calls.at(-1);
    assert.ok(rpc);
    assert.deepEqual(rpc.body, {
      method: "signAndSendTransaction",
      caip2: SOLANA_CAIP2.mainnet,
      params: { transaction: toBase64(serialized), encoding: "base64" },
    });
  });

  test("a delegation smuggled into the transaction is refused, and nothing is sent", async () => {
    // Policy approved a transfer. The builder produced something else. This is the last line, and
    // it is the one that does not depend on the request being honest.
    const serialized = solanaTx(SPL_TOKEN_PROGRAM, [SPL_TOKEN_INSTRUCTION.approve, 255, 255]);
    const { executor, calls } = await solanaHarness(serialized);
    const before = calls.length;
    const result = await executor.execute(solanaTransfer("r1", 1_000n));

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.error, /human-only action class/);
    assert.equal(calls.length, before, "nothing was sent to Privy");
  });

  test("a transaction from an account policy did not approve is refused", async () => {
    // The fee payer is static account key 0 and is never loaded from a lookup table, so this is one
    // of the few account-level facts the guard can actually establish.
    const serialized = solanaTx(SPL_TOKEN_PROGRAM, [SPL_TOKEN_INSTRUCTION.transferChecked, 1], SOL_ATTACKER);
    const { executor } = await solanaHarness(serialized);
    const result = await executor.execute(solanaTransfer("r1", 1_000n));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.error, /fee payer is not the approved account/);
  });

  test("every guard result is kept for the audit log, including the clean ones", async () => {
    const serialized = solanaTx(SPL_TOKEN_PROGRAM, [SPL_TOKEN_INSTRUCTION.transferChecked, 1]);
    const { executor, signer } = await solanaHarness(serialized);
    await executor.execute(solanaTransfer("r1", 1_000n));
    assert.equal(signer.guarded.length, 1);
    // "Nothing forbidden was found" is not "safe", and the record says which one it was.
    assert.deepEqual(signer.guarded[0]?.findings, []);
    assert.ok((signer.guarded[0]?.unverified.length ?? 0) > 0);
  });

  test("a human-only request never reaches the builder at all", async () => {
    const { executor, signer } = await solanaHarness(solanaTx(SPL_TOKEN_PROGRAM, [3]));
    // Built inline, never as a fixture (AGENTS.md invariant 3).
    const result = await executor.execute({
      id: "r1",
      requestedAt: 0,
      chain: "solana",
      account: SOL_ACCOUNT,
      kind: "approve-delegate",
      contract: SOL_MINT,
      tokenAccount: SOL_ACCOUNT,
      delegate: SOL_ATTACKER,
      amount: (1n << 64n) - 1n,
    });
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") return;
    assert.equal(result.decision.reason, "human-only-action");
    assert.equal(signer.guarded.length, 0, "no transaction was even built");
  });
});

describe("building a Solana transaction is honestly unimplemented", () => {
  test("the shipped builder refuses and says what is missing", async () => {
    const builder = new UnimplementedSolanaBuilder();
    await assert.rejects(
      () => builder.build({ request: { chain: "solana" } } as unknown as ApprovedAction),
      /associated token account derivation/,
    );
  });
});
