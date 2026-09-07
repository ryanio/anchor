# Upstream workarounds

Code in this repository that exists **only** because something is missing or wrong in a dependency —
almost always [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js) or
[`@opensea/api-types`](https://www.npmjs.com/package/@opensea/api-types).

Each entry names what we wrote, why, and **what to delete when upstream fixes it**. Without this
file, a workaround quietly becomes architecture: nobody remembers it was temporary, and the upstream
fix lands with no one noticing it made our code redundant — or worse, actively wrong.

Findings were reported upstream on **2026-09-07**, verified against `@opensea/sdk@12.1.0` and
`@opensea/api-types@0.9.1`. Re-check this file whenever either package is bumped;
`scripts/check-versions.ts` does not check it, because "is this still needed" is a judgement call.

---

## 1. Percent-encoding path segments before the SDK sees them

**Upstream problem.** `lib/api/apiPaths.js` builds every path with a bare template literal. Sixty-one
builders take a parameter and none encode it, so a collection slug of `../../events/accounts/0xdead`
retargets the request at a different endpoint and collides that endpoint's cache key. The helper
already exists in the same package — `lib/api/walletAuth.js:4` defines
`segment = (value) => encodeURIComponent(String(value))` — and `lib/api/accounts.js:42` uses
`encodeURIComponent` at exactly one call site.

**What we wrote.** `segment()` in `service/src/opensea.ts:166`, applied at eleven call sites before
any value is handed to the SDK.

**When it's fixed — read this carefully.** Do **not** simply delete `segment()` the moment the SDK
starts encoding. We would then encode twice, and a slug containing a space would go out as `%2520`
rather than `%20`. In practice this is narrow: for ordinary slugs and for hex or base58 addresses
`encodeURIComponent` is the identity, so double-encoding is a no-op — it bites only on exactly the
inputs the upstream fix exists to protect.

So the removal has to be atomic with the upgrade: bump the SDK and drop the `segment()` calls in the
same commit, and keep `service/src/opensea.test.ts`'s traversal case, which asserts the *behaviour*
(a `../` slug does not reach another endpoint) rather than the mechanism. That test should pass
before and after.

## 2. Subclassing `OpenSeaAPI` to get a transport seam

**Upstream problem.** `OpenSeaAPI` builds its `Fetcher` internally from `this.get`/`post`/`request`
bound in the constructor. There is no fetch injection, no cache hook and no rate-limit hook, so any
consumer needing a cache must subclass and override the public `get()`.

**What we wrote.** `ReadOnlyOpenSeaAPI` in `service/src/opensea.ts`, overriding `get()` — which is
also where the read-only guarantee is enforced, since `post()` and `request()` throw. Because
`get()`'s signature belongs to the SDK and cannot carry our per-call TTL or return freshness
metadata, both travel through an `AsyncLocalStorage` scope (`callScope`, `service/src/opensea.ts:175`).

**When it's fixed.** If the constructor accepts a `fetch` or a `Fetcher`, the `AsyncLocalStorage`
plumbing goes away entirely — TTL and freshness become ordinary arguments and return values.
**Keep the subclass regardless**: `post()`/`request()` throwing `ReadOnlyViolationError` is a
security property of this service, not a workaround, and it is asserted by twelve tests.

## 3. Hand-rolled base58 address validation

**Upstream problem.** No address validator for non-EVM chains. `checksumAddress` is EVM-only and
throws on anything else; the `SolanaAddress` and `EvmAddress` schemas in the OpenAPI spec carry no
`pattern`.

**What we wrote.** `decodeBase58` and `isSolanaAddress` in `service/src/chains.ts`. A length check
alone is not sufficient — base58 is not fixed-width, so a 44-character string can decode to 33 bytes
— which is why this is a decoder rather than a regex.

**When it's fixed.** Replace with the upstream validator if one ships. Keep the cross-chain
confusion tests either way; they assert that an allowlist entry for one chain never matches an
address on another, which is our property, not the SDK's.

## 4. No runtime chain list

**Upstream problem.** `ChainIdentifier` is type-only. There is no runtime array of the 29 slugs, and
`opensea-api.json` is listed in the package's `files` but absent from its `exports`, so
`require("@opensea/api-types/opensea-api.json")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` — the
spec ships but cannot be imported.

**What we wrote.** `CHANGELOG`-worthy only because of how it's built: `CHAINS` in
`service/src/chains.ts` is `Object.values(Chain)` from the SDK enum, with a compile-time proof
(`ChainsAgree`) that the enum and the generated union still describe the same set. A chain added
upstream surfaces as a typecheck failure rather than a slug we silently reject.

**When it's fixed.** If `api-types` exports a runtime `CHAINS` array, use it and delete
`ChainsAgree`. This is the mildest entry here — the current approach is defensible on its own merits.

## 5. Missing query parameters on SDK arg types

**Upstream problem.** Documented parameters absent from the hand-written arg interfaces, so they are
unreachable through the SDK: `GetTokensArgs` is missing `chains`, `sort_by`, `sort_direction` and
`disable_spam_filtering`; `PortfolioArgs` is missing `chains`; `GetEventsArgs.eventType` is scalar
where the spec documents an array.

**What we wrote.** Nothing — we simply do not expose those options. `/tokens` cannot sort, and
events cannot filter on more than one type.

**When it's fixed.** Surface the options. This is the only entry that is a *missing feature* rather
than compensating code, which is why there is nothing to delete.

## 6. No status code on SDK errors

**Upstream problem.** Only `_createRateLimitError` attaches `statusCode` (429 and 599). Every other
failure throws a bare `Error` whose message is built from a remote-controlled response body —
`api.js:1013` carries no status at all, `api.js:1015` puts it in prose only.

**What we wrote.** Nothing that recovers the status, because there is nothing to recover it from.
The consequence is a **missing capability**: the service has no 5xx retry ladder, since it cannot
distinguish a retryable failure from a permanent one. Errors are scrubbed to a status-derived
message before they leave the service (a remote body must never be echoed), so the SDK's message
text is discarded.

**When it's fixed.** Add the retry ladder. Note that this is the one entry where the workaround is an
absence — easy to forget precisely because there is no code to find.

## 7. `/account/{address}/portfolio` 500s on the obvious call

**Upstream problem.** A live server bug, not a package one. The bare route returns
`500 {"errors":["Internal Server Error"]}` for a large account, and `200` for that same account the
moment any query parameter is supplied, and `200` for a smaller account with no parameters. Fine
when filtered, fine when small, fails when large and unfiltered.

**What we wrote.** Nothing yet. Note that finding 5 compounds it: `PortfolioArgs` does not expose
`chains`, so an SDK consumer cannot easily send the parameter that makes the call succeed.

**When it's fixed.** Nothing to delete. If it persists, the workaround is to always send a
parameter, and that belongs here as its own entry when we write it.

## 8. No Solana adapter in `@opensea/wallet-adapters`

**Upstream problem.** [`ProjectOpenSea/wallet-adapters`](https://github.com/ProjectOpenSea/wallet-adapters)
is the package Anchor would otherwise use for managed signing: adapters for Privy, Turnkey,
Fireblocks, Bankr and local keys, with bridges for ethers and viem. Every one of them is EVM. There
is no Solana adapter, no Solana bridge, and no non-EVM signing abstraction in the repository.

**What we wrote.** `PrivySolanaSigner` and the Solana half of `privy-api.ts` in
`executor/src/`, plus a hand-rolled transaction parser in `executor/src/solana.ts`. The parser is
*not* really a workaround for this gap — it exists because refusing a delegation is a security
property Anchor owns rather than something an adapter would provide — but the Privy plumbing around
it is exactly what an adapter would have supplied.

**When it's fixed.** Replace the transport half with the adapter and keep the guard. Note that an
adapter shipping does not close the *other* gap: Anchor still cannot **compile** a Solana
transaction, which needs associated token account derivation (ed25519 on-curve arithmetic) and a
live blockhash. If `wallet-adapters` grows a Solana adapter that also builds transactions, both go.

## 9. Privy's Solana policy engine cannot express an approval refusal

Not an OpenSea gap, but it belongs in the same register because it is the same failure mode: a
capability that exists on one chain and silently does not on another.

**Upstream problem.** Privy's Solana condition sources are `solana_program_instruction` (`programId`
only), `solana_system_program_instruction`, and `solana_token_program_instruction` — whose decoder
covers `Transfer`, `TransferChecked`, `Burn`, `MintTo`, `CloseAccount` and `InitializeAccount3`.
`Approve`, `ApproveChecked` and `SetAuthority` are reachable by no condition at all, so a policy
*cannot* refuse the two instructions Anchor treats as human-only. There is also no aggregation
(cumulative spend) support for any Solana method, and a condition needing an address loaded from an
address lookup table causes evaluation to fail.

**What we wrote.** `auditSolanaRule` in `executor/src/privy.ts` treats a rule that permits a token
program by `programId` alone as a finding and refuses to start, because the only remote control is an
`instructionName` allowlist plus default-deny — a control that vanishes silently when that one
condition is omitted. `guardSolanaTransaction` in `executor/src/solana.ts` adds a local refusal that
does not depend on Privy at all.

**When it's fixed.** If Privy add `Approve`/`SetAuthority` to their token decoder, the audit can
check for an explicit DENY rule instead of relying on inverted default-deny, and the finding becomes
a weaker note. Keep the local guard regardless: it is the layer that holds when the vendor is
compromised or compelled.

**One correction to an earlier draft of this entry.** `solana_system_program_instruction` *does*
support an `instructionName` field — verified against Privy's Solana policy examples on 2026-09-07,
where it appears with values `Create` and `Transfer`. An in-flight comment in `privy.ts` said this
was not established while the code already relied on it; the code was right and the comment was
stale. So the System Program hole, unlike the token program one, can be closed remotely as well as
locally.

## 10. Privy has no Compute Budget condition source, so a priority fee cannot be bounded

Same vendor, and the starkest of the set: entry 9 is a control weaker than its EVM counterpart, and
this is a control with **no remote expression at all**.

**Upstream problem.** Privy's only condition that reaches the Compute Budget program is
`solana_program_instruction`'s `programId`, which says the program may be invoked and nothing about
what it is invoked with. There is no `solana_compute_budget_instruction` source, and no example
bounds a priority fee. `SetComputeUnitPrice` names a price in micro-lamports *per compute unit* as a
`u64`; multiplied by the unit limit (up to 1,400,000) that is the payer's entire native balance,
paid to a validator as a tip. A Solana policy therefore cannot refuse a transaction that drains the
account through fees — and because a fee produces no asset delta, no value condition sees it either.
The EVM side does not have this problem in the same way: a gas price is denominated in the asset the
value cap counts.

**What we wrote.** A priority-fee ceiling in `guardSolanaTransaction` (`executor/src/solana.ts`),
default 0.01 SOL and overridable per call, which reads both operands out of the instruction data.
This is one of the few checks in that module that is *exact* — the operands are inline `u32`/`u64`
literals, so no address lookup table can move the answer. `auditSolanaRule` states the gap in
`unverified` on every startup where a policy permits the program, and deliberately **not** as a
finding: a finding means "fix this in Privy", and there is nothing to fix.

**When it's fixed.** If Privy add a Compute Budget condition source, move the ceiling into the remote
policy and downgrade the local one to defence in depth. Keep the local check regardless, for the same
reason as entry 9.

---

## Reporting

The full write-up handed to OpenSea on 2026-09-07 covers eight findings, of which findings 1-6 above
affect this repository. Two others — the four wallet-scoped operations that 401 while declaring only
`ApiKeyAuth`, and the absent `POST /api/v2/auth/tokens/exchange` — are documented in
`service/src/auth.ts` instead, because they shaped that module's whole design rather than leaving a
removable workaround.

When you hit a new one: fix it locally if you must, then **add it here and tell Ryan**. He works on
these packages. An upstream fix helps everyone; a local workaround helps once and then drifts.
