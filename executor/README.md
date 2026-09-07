# executor

The **policy-bound execution seam** — roadmap step 6.

Anchor's agent is meant to act while holding real value. The safety property is not "the agent cannot
transact"; it is that **the agent never holds unbounded authority** (docs/security.md). This
workspace is the abstraction that makes that true by construction, and makes the enforcement backend
— a vendor policy engine (Privy, Turnkey) or an onchain module (a Safe allowance module, ERC-4337
session keys) — a configuration choice rather than an architectural one.

> **The reference parts here sign nothing.** The `PolicyEngine`, `DeclaredIntentSimulator` and
> `InertSigner` in this package document the intended semantics in a form that runs and can be
> tested. They hold no key, reach no network, and provide **no security property**, because they run
> in the same process as the thing they judge. Real enforcement lives where the agent cannot reach
> it — which, as of the Privy backend below, is somewhere that actually exists.

## The pipeline

```
  request   →   simulate   →   decide    →   submit   →   result
  (agent)       Simulator      Policy-       Signer       ExecutionResult
                               Authority
```

Four parties, four interfaces, split along exactly those lines so that holding one does not get you
the next.

| Interface | Who implements it | Who holds it |
|---|---|---|
| `Executor` | `PolicyBoundExecutor` (composition) | the agent |
| `Simulator` | Tenderly, an `eth_call` fork, a bundler | the executor |
| `PolicyAuthority` | Privy (`privy.ts`) / Turnkey / Safe module — `PolicyEngine` for reference | the executor, remotely |
| `Signer` | the enclave or the smart account — `PrivySigner` (`privy.ts`) | the executor, remotely |

## Why the agent cannot approve its own request

AGENTS.md invariant 1: *the thing that requests cannot be the thing that decides.* That is easy to
say and easy to lose to a refactor, so it is encoded three independent ways.

**1 · Decisions flow outward only.** `PolicyDecision` appears in every *return* type on `Executor`
and in no *parameter* type. There is no method that accepts a decision, an approval, a policy, or a
"trusted" flag. "Here is my own approval, please submit it" is not a sentence the API can express.

**2 · `ApprovedAction` is unforgeable at compile time.** It carries a property keyed by a
`unique symbol` that `decision.ts` declares and deliberately does not export. A `unique symbol` is
nominally typed and a key that cannot be named cannot appear in an object literal, so this fails to
compile anywhere in the codebase:

```ts
const forged: ApprovedAction = { approvalId: "mine", request, simulation, ceiling, /* … */ };
//    ~~~~~~ Property '[POLICY_WITNESS]' is missing in type '{ … }'
```

**3 · `ApprovedAction` is unforgeable at run time.** TypeScript is defeatable with a cast, so the
brand is backed by identity: `mintApproval` is the only function that adds an object to a
module-private `WeakSet`, and `Signer.submit` checks membership before doing anything. The witness
property has no runtime representation at all — there is nothing on the object to copy — so a spread,
a `structuredClone`, or a trip through JSON all produce something the signer refuses. **Authority
does not survive being written down.**

`Signer.submit` takes an `ApprovedAction` and nothing else. A compromised agent holding a `Signer`
reference still has nothing it can pass to it.

What none of this defends against is a caller that constructs its own `PolicyEngine` and evaluates
against limits it wrote. That is not a type problem — it is why real enforcement runs *outside the
agent's process*. The types make the seam impossible to cross by accident; process and key custody
make it impossible to cross on purpose.

## Controls implemented by the reference engine

Straight from docs/autonomy.md:

- **Per-transaction cap**, and **rolling 24h / 7d caps**. The cumulative ones matter more — a hundred
  small transfers is the obvious way around a single-transaction limit, and there is a test that
  fires a hundred of them.
- **Contract allowlist.** Including against a freshly deployed "helpful" contract.
- **Action allowlist.** `buy`, `accept-offer`, `cancel-own-listing`, `transfer`.
- **Withdrawal destination allowlist.** Only pre-registered addresses. The list is constructor state;
  nothing on any interface can widen it at run time.
- **Mandatory simulation.** A request is the agent's claim; the simulation is the evidence. Where
  they disagree the answer is always to deny — never to prefer the claim.
- **Kill switch.** `revoke()` denies everything afterwards, ahead of every other check.

Two accounting decisions worth knowing about:

- **Caps charge gross outflow, not net.** Netting would let an attacker send real value out and book
  something they valued themselves coming in, arriving at a charge of zero. A wash trade is the
  standard way to drain a wallet that counts net flow.
- **Budget is reserved at approval, not at settlement.** Otherwise an agent that simply never settles
  would hold unlimited live approvals — the many-small-transactions evasion wearing a different hat.
  `settle(approval, "failed")` releases the reservation.

## `setApprovalForAll`

A human-only action class, never delegated (docs/security.md). It is enforced at three levels:

- **Type level.** `PolicyLimits.allowedActions` is typed `DelegableActionKind`, which is
  `Exclude<ActionKind, "set-approval-for-all">`. It cannot be configured onto an allowlist — the
  compiler refuses.
- **Run time.** `PolicyEngine` throws at construction if limits loaded from JSON contain it anyway.
- **Decision.** It is denied with its own reason code, `"human-only-action"`, checked before the
  action allowlist so the refusal is countable rather than lost among ordinary denials.

It is *representable* in `ActionRequest` on purpose. An agent that cannot name the action it wants
will encode it as something else, and the denial becomes an accident of parsing rather than a rule.
There is no fixture for it: the request is built inline in the tests that prove it is refused, so it
cannot be lifted into working code.

## Kill switch

`Executor.revoke(reason)` is one-way from the agent's side. There is no `reinstate` on `Executor` or
on `PolicyAuthority` — restoring authority is a human action, lives only on the concrete backend, and
in a real deployment belongs behind the same time-lock as a withdrawal-allowlist change.

In a real backend `revoke` is a session-key revocation or a policy set to zero, and it must work from
the user's phone without the desktop being reachable.

## Not implemented yet

Named so the gap is visible rather than assumed: velocity limits and cooldowns, auto-pause on a
cluster of policy rejections, time-locks above a threshold, human co-sign at tier 3+, and persistence
of the spend ledger (it is in memory, so a restart currently forgets the day's spend — which a real
backend must not do). The Privy backend below adds its own list, including the one that matters
most: Privy cannot express the rolling caps.

## The Privy backend

`privy.ts` and `privy-api.ts` are the first backend in this repository where the enforcement is
**not** in this process. Privy holds the key — reconstituted only inside their enclave, never on this
machine — and checks every signing request against a policy stored with them. That check is what
makes the model real; everything Anchor does around it is scaffolding.

Zero runtime dependencies, as everywhere else here: `fetch` and `node:crypto`, no `@privy-io/*`.

### Who enforces what

| Control | Enforced by | Holds against a compromised desktop? |
|---|---|---|
| Contract allowlist | Privy policy (`to` condition) | **Yes** |
| Per-transaction value cap | Privy policy (`value` condition) | **Yes** |
| Withdrawal destination allowlist | Privy policy (`ethereum_calldata` condition on the decoded `to`) | **Yes**, once you add that condition |
| `setApprovalForAll` refusal | Type system, local mirror, signer, *and* the startup audit of the remote policy | **Yes** |
| Kill switch | Privy policy emptied over the API | **Yes** |
| Rolling 24h / 7d caps | Local mirror only | **No** — see below |
| Mandatory simulation | Local mirror only | No |
| Replay refusal (duplicate request id) | Local mirror only | No |

The local mirror is a `PolicyEngine` running in the agent's process. It exists to produce
machine-readable `DenyReason`s, to keep the rolling ledger, and to refuse the obvious cases without a
network round trip. **It is not the enforcement.** If it were removed entirely, Privy would still
refuse everything outside the policy — which is the property that matters.

`connectPrivyAuthority` refuses to start when the local mirror claims more than the remote policy
grants: a contract the policy does not allow, a withdrawal address it does not allow, a per-tx cap
above its ceiling, a rule with no conditions, or an `ALLOW` on a method Anchor does not send. A
status screen that describes limits which are not the limits in force is worse than no status screen.

The audit reports its own weak spot in `audit.unverified` rather than hiding it: with more than one
`ALLOW` rule it unions their allowlists instead of correlating them per rule, so it describes a
slightly *wider* policy than Privy enforces. That direction is the safe one — it can flag a problem
Privy would have caught anyway, never miss one Privy would allow — and a single `ALLOW` rule makes
the two descriptions identical.

### The gap you should know about

**Privy cannot express Anchor's cumulative caps.** Their spend-limit primitive (*aggregations*) has a
rolling window capped at 72 hours, so the 7-day cap in [autonomy.md](../docs/autonomy.md) has no
remote equivalent at all. Aggregations also only observe `eth_signTransaction` and
`eth_signUserOperation` — Privy's own docs note that `eth_sendTransaction` spend is invisible to
them — and this signer uses `eth_sendTransaction`. So the rolling caps are enforced locally and
**only** locally. Against an attacker who owns this machine, the per-transaction cap, the allowlists
and the approval refusal hold; the daily and weekly totals do not.

That is a real limit of the vendor stepping stone, not a shortcut taken here. Closing it means either
moving to `eth_signTransaction` plus self-broadcast with an aggregation for the 24h window (and
accepting that Privy calls aggregation "disaster prevention rather than strict real-time
enforcement", since values update *after* signing and concurrent requests can all pass), or moving to
the onchain enforcement that autonomy.md points at.

### What you have to do yourself

Nothing below can be done from this repository, and none of it has been done for you.

1. **Create a Privy app** at `dashboard.privy.io`. Note the **app ID** and generate an **app
   secret**. Anchor never puts either in a file.

2. **Create a server wallet**, `chain_type: "ethereum"`. Note its **wallet ID** (not its address —
   the API is addressed by id).

3. **Write a policy and attach it.** One policy per wallet; Privy's API accepts at most one. There is
   no `default_action` field — Privy denies anything no rule resolves for, *including any RPC method
   the policy does not mention*, which is exactly the behaviour you want. A policy Anchor's audit
   accepts looks like this (substitute your own addresses; values are hex quantities in wei):

   ```json
   {
     "version": "1.0",
     "name": "anchor tier 1",
     "chain_type": "ethereum",
     "rules": [
       {
         "name": "allowlisted collections only",
         "method": "eth_sendTransaction",
         "action": "ALLOW",
         "conditions": [
           { "field_source": "ethereum_transaction", "field": "to",
             "operator": "in", "value": ["0xYourCollection"] },
           { "field_source": "ethereum_transaction", "field": "value",
             "operator": "lte", "value": "0x2386f26fc10000" },
           { "field_source": "ethereum_calldata", "field": "safeTransferFrom.to",
             "operator": "in", "value": ["0xYourColdVault"],
             "abi": [ { "name": "safeTransferFrom", "type": "function",
                        "inputs": [ { "name": "from", "type": "address" },
                                    { "name": "to", "type": "address" },
                                    { "name": "tokenId", "type": "uint256" } ] } ] }
         ]
       }
     ]
   }
   ```

   The last condition is the one that makes the withdrawal allowlist real. Without it the destination
   is enforced only by the local mirror, and `connectPrivyAuthority` will refuse to start and tell
   you so. **Verify the policy in Privy's dashboard after creating it** — a policy bug is now the
   vulnerability class that a key leak used to be (autonomy.md, "named risks").

4. **Optionally set an owner** on the wallet or the policy, and generate a P-256 authorization key.
   With an owner, Privy requires a `privy-authorization-signature` on every write, so the app secret
   alone stops being enough to move funds or to widen the policy. Anchor implements that signing
   (RFC 8785 canonical JSON, ECDSA P-256/SHA-256, base64 DER) — pass the key as `authorization-key`.
   Without an owner, the app secret is sufficient, which means anything that reads it can sign.

5. **Store the credentials in the OS keyring.** They never go in a config file, in argv, or in a log:

   ```bash
   node executor/src/cli.ts --set-key app-id
   node executor/src/cli.ts --set-key app-secret
   node executor/src/cli.ts --set-key authorization-key   # only if you set an owner
   node executor/src/cli.ts --list-keys                   # presence only; never prints a value
   ```

   Requires `libsecret` (`secret-tool`), the same dependency the data service has. There is
   deliberately **no environment-variable fallback** here: the data service has one for CI, and a
   process environment is readable at `/proc/<pid>/environ`, which is not a trade worth making for a
   credential that can move funds.

6. **Fund the wallet**, starting at tier 1 of the value ladder. Nothing here has been run against a
   wallet with real value in it.

### Wiring it up

```ts
const api = new PrivyClient(await loadCredentials());
const { authority, audit } = await connectPrivyAuthority({
  api,
  policyId: "<your policy id>",
  limits: tierLimits(1, { contractAllowlist, withdrawalAllowlist }),
});
console.error(audit.unverified.join("\n")); // read this; it is the honest part
const executor = new PolicyBoundExecutor({
  simulator: /* a real simulator — see below */,
  policy: authority,
  signer: new PrivySigner({
    api,
    walletId: "<your wallet id>",
    builder: new Erc721TransferBuilder(1),
    chainId: 1,
  }),
});
```

### Implemented, and not

**Implemented and tested** (with a stubbed `fetch` — the suite needs no Privy account and touches no
network): startup audit of the remote policy; local pre-filtering with reasons; ERC-721 withdrawals
end to end, from request through `safeTransferFrom` calldata to `eth_sendTransaction`; the kill
switch, including the case where Privy does not confirm it; authorization-signature signing; and the
guarantee that no error carries the app secret.

**Not implemented.**

- **Marketplace actions.** `buy`, `accept-offer` and `cancel-own-listing` are approved by policy and
  then refused by `Erc721TransferBuilder`, because `ActionRequest` models *intent* — a contract, a
  token, a ceiling — and not the signed Seaport order payload a fulfilment needs. That payload has to
  come from the marketplace API, and wiring it in is the next piece of work, not a missing line.
- **A real simulator.** `DeclaredIntentSimulator` believes the request. Everything policy concludes
  about value is therefore only as good as what the agent claimed, until a real simulator lands.
- **Wallet and policy creation.** Anchor reads a policy and empties it. It never creates or widens
  one — that is a human action, in Privy's dashboard, on purpose.
- **Persistence of the spend ledger.** In memory, so a restart forgets the day's spend.

### API details: verified versus assumed

Every request shape was read off Privy's published documentation, including their machine-readable
`llms-full.txt` corpus and the OpenAPI fragments embedded in each API-reference page.

**Verified**: base URL and `v1` segment; Basic auth plus the mandatory `privy-app-id` header;
`POST /v1/wallets/{id}/rpc` with `{ method, caip2, params: { transaction } }` and the hash at
`data.hash`; `GET`/`PATCH /v1/policies/{id}` and the fields a patch accepts; the policy, rule and
condition schemas, including that `ethereum_transaction` exposes exactly `to`, `value` and
`chain_id`, and that calldata conditions require an `abi`; the absence of `default_action`; the
authorization-signature payload and algorithm; `privy-idempotency-key` and its 24-hour caching of
4xx and 5xx on `/rpc`; and that a policy refusal is HTTP 400 with code `policy_violation`.

**Not verified**: the exact JSON envelope of an error body — Privy document error *codes* but publish
no error schema, so `readErrorCode` reads several plausible shapes and treats "no recognisable code"
as a plain API error rather than guessing. Numeric rate limits are undocumented; only the 429 is
confirmed. And nothing here has been run against the live API — the suite proves the client sends
what the documentation says to send, not that Privy accepts it.

## Development

Zero runtime dependencies, native Node TypeScript execution, no build step.

```bash
npm install        # dev only: @types/node + typescript
npm run typecheck
npm test           # node --test
```

Some tests are compile-time assertions written as `@ts-expect-error`. A `@ts-expect-error` on a line
that stops being an error is itself a compile error, so if someone removes the witness from
`ApprovedAction` — making self-approval possible again — `npm run typecheck` fails. The invariant is
enforced by CI rather than by a comment asking nicely.
