# Upstream workarounds

Code in this repository that exists **only** because something is missing or wrong in a dependency —
almost always [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js) or
[`@opensea/api-types`](https://www.npmjs.com/package/@opensea/api-types).

Each entry names what we wrote, why, and **what to delete when upstream fixes it**. Without this
file, a workaround quietly becomes architecture: nobody remembers it was temporary, and the upstream
fix lands with no one noticing it made our code redundant — or worse, actively wrong.

Findings were reported upstream on **2026-09-07**, and this file was last checked against
`@opensea/sdk@12.4.1` and `@opensea/api-types@0.9.3`. Re-check this file whenever either package is bumped;
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

**Status: fixed upstream and consumed.** Landed in `@opensea/sdk` 12.1.1 / `@opensea/api-types` 0.9.2. OpenSea exported `segment()` from `apiPaths.ts` and applied
it to all 100 interpolation sites (61 of 88 builders took a parameter), and dropped the duplicate
helper in `walletAuth.ts` plus the now-double-encoding wrapper at the one call site in `accounts.ts`.
It reaches npm on the next SDK release. **Do not bump and delete in separate commits** — see below.

**Encoding alone was not enough, on either side.** `encodeURIComponent` leaves `.` and `..` untouched,
so they survive encoding and still traverse, and percent-encoding them does not help because the
WHATWG URL parser strips escapes *before* removing dot segments. Both `segment()` implementations now
reject the two bare forms rather than encoding them. Rejection is sufficient as well as necessary:
after encoding, nothing else is still a dot segment. Ours is in `service/src/opensea.ts` with tests
covering both the refusal and the near-misses (`"..."`, `"%2e%2e"`, `".%2e"`).

**Done, and the trap was real.** Bumping without removing our encoding produced exactly the
double-encode this entry warned about, and `opensea.test.ts` caught it — the traversal test failed
with `%252F` where it expected `%2F`. The bump and the removal were one commit. `segment()` still
exists and still **rejects** `.` and `..`; it just no longer encodes.

Historical note on why deletion had to be atomic: do **not** simply delete `segment()` the moment the
SDK starts encoding. We would then encode twice, and a slug containing a space would go out as `%2520`
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

**Partly fixed upstream and verified.** The `exports` half landed in `@opensea/api-types` 0.9.2:
`require("@opensea/api-types/opensea-api.json")` now resolves (128 paths), and `./package.json` is
exported alongside it. The runtime chain list is still absent, so `ChainsAgree` stays.

**Upstream problem.** `ChainIdentifier` is type-only. There is no runtime array of the 29 slugs, and
`opensea-api.json` was listed in the package's `files` but absent from its `exports`, so
`require("@opensea/api-types/opensea-api.json")` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` — the
spec shipped but could not be imported.

**What we wrote.** `CHANGELOG`-worthy only because of how it's built: `CHAINS` in
`service/src/chains.ts` is `Object.values(Chain)` from the SDK enum, with a compile-time proof
(`ChainsAgree`) that the enum and the generated union still describe the same set. A chain added
upstream surfaces as a typecheck failure rather than a slug we silently reject.

**When it's fixed.** If `api-types` exports a runtime `CHAINS` array, use it and delete
`ChainsAgree`. This is the mildest entry here — the current approach is defensible on its own merits.

## 5. Missing query parameters on SDK arg types

**Status: mostly fixed upstream and consumed** in `@opensea/sdk` 12.4.1. `PortfolioArgs.chains` and
`GetTokensArgs.chains` now exist, and `GetEventsArgs.eventType` takes an array. Three casts are gone
from `service/src/opensea.ts` — `{ chains } as object` twice and `{ eventType } as { eventType?:
string }` once — and the code now says what it means.

12.4.1 also deprecated `GetTokensArgs.next` in favour of `cursor`, because those endpoints never
read a `next` query parameter: passing it alone returned the first page every time. **We were never
affected** — `tokenBalances` already sent `cursor`, and `GetEventsArgs.next` is a real parameter
rather than the deprecated one. Checked rather than assumed, because the two names sit next to each
other and only one of them is a no-op.

**Still missing.** `sort_by`, `sort_direction` and `disable_spam_filtering` on the token listings.
`/tokens` still cannot sort.

**What we wrote.** Nothing — we do not expose the options that remain unreachable.

**When it's fixed.** Surface them. This is the only entry that is a *missing feature* rather than
compensating code, which is why there is nothing to delete.

## 6. No status code on SDK errors

**Status: fixed upstream and consumed** in `@opensea/sdk` 12.1.1. All four throw sites now go through one
builder, so `statusCode` is set on every non-OK response and `responseBody` comes along whenever a
body parsed. The type is `OpenSeaApiError`; `OpenSeaRateLimitError` remains as an alias with the
identical shape, so existing rate-limit handling compiles unchanged.

The retry ladder now exists in `ReadOnlyOpenSeaAPI.get()`: 502/503/504 and status-less transport
errors are retried twice with jittered exponential backoff, outside the shared rate limiter so a
sleeping request cannot hold a slot. **500 is deliberately excluded** — entry 7 below is a measured
counter-example of a deterministic one, and retrying it only delays the stale-cache fallback. 429 is
left to the SDK's own `Retry-After` ladder.

**Upstream problem.** Only `_createRateLimitError` attached `statusCode` (429 and 599). Every other
failure threw a bare `Error` whose message was built from a remote-controlled response body —
`api.js:1013` carried no status at all, `api.js:1015` put it in prose only.

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

**Status: fixed upstream, and we still cannot adopt it — see entry 12.** `@opensea/wallet-adapters`
1.0.0 ships `PrivySvmAdapter`, which is exactly the transport half of what we wrote. Its `signTransaction`
path is adoptable; its `sendTransaction` path is not, because it cannot send an idempotency key and
ours must. Entry 12 has the detail.

Two things the adapter does *not* close, and neither is a criticism of it:

- It takes an already-serialized transaction, so Anchor still cannot **compile** one — that needs
  associated token account derivation (ed25519 on-curve arithmetic) and a live blockhash.
- It deliberately excludes policy mutation ("do not add `setPolicy`, `rotateOwner`, `addSigner`"), so
  `getPolicy`, `replacePolicyRules`, `loadAuthorizationKey`, `signAuthorizationPayload` and
  `canonicalize` stay ours regardless.

`solana.ts` stays either way. Refusing a delegation is a security property Anchor owns, not something
an adapter would provide.

**Upstream problem (as originally filed).** [`ProjectOpenSea/wallet-adapters`](https://github.com/ProjectOpenSea/wallet-adapters)
is the package Anchor would otherwise use for managed signing: adapters for Privy, Turnkey,
Fireblocks, Bankr and local keys, with bridges for ethers and viem. Every one of them was EVM. There
was no Solana adapter, no Solana bridge, and no non-EVM signing abstraction in the repository.

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

## 11. No supported way for a third-party client to obtain a wallet token

**Upstream problem.** `@opensea/sdk` exposes two routes to a wallet token, and neither is open to us.

`OpenSeaAuth.getValidToken()` throws unless `authenticate()` ran in the same process with a signer,
and `exchangeScopedToken` — the PAT-to-JWT call that needs no signer — is **private**. The other
route, `OpenSeaOAuth`, has exactly the right shape for a headless desktop client: a device
authorization flow (`requestDeviceAuthorization` + `pollDeviceToken`), plus `refresh` and the useful
`extractOpenSeaScopes` / `decodeJwtPayload` helpers.

**But OpenSea has confirmed that third-party clients cannot use OAuth yet.** There is no client ID
for an application like Anchor. So the device flow is visible in the public API surface and
unavailable in practice.

**What we wrote.** `service/src/auth.ts` — a hand-rolled reimplementation of
`exchangeScopedToken`, built by reading the SDK's compiled output because the method is private and
the endpoint was absent from the spec at the time.

**Why this entry matters more than it looks.** Every other item in this file is a workaround for
something awkward. This one is a workaround for something with **no supported alternative**: a
third-party headless client that wants a wallet token today has to reimplement a private method.
Anchor does not currently need one — no route it calls requires it — but it will for writes, and for
the fifty wallet-scoped paths in the spec.

**When it's fixed.** Either is sufficient, and either lets us delete the module: make
`exchangeScopedToken` public, or open OAuth to third-party clients so the device flow becomes usable.
The second is better, because a device flow is the right shape for a desktop app and the PAT is a
long-lived secret sitting in a keyring.

---

## 12. `PrivySvmAdapter` cannot send an idempotency key

**Upstream problem.** `@opensea/wallet-adapters` 1.0.0 sends exactly two Privy headers —
`privy-app-id` and `privy-authorization-signature`. There is no `privy-idempotency-key`, no way to
add one (`PrivyConfig` takes `appId`, `appSecret`, `walletId`, `baseUrl`, `authSigningKey` and
nothing else), and `onRequest` observes a request rather than amending it.

Privy's own semantics are what make this matter. From their idempotency documentation, quoted in
`executor/src/privy-api.ts`: the same key with a *different* body is a 400, and for `/rpc` both 4xx
and 5xx responses are cached for 24 hours. That is the property that makes a resubmitted approval a
no-op instead of a second on-chain spend, and it is why nothing in our client retries a POST.

So `PrivySvmAdapter.sendTransaction` broadcasts without a double-spend guard. For an interactive
wallet that is a reasonable default; for an agent that may retry, it is the whole problem.

**What we wrote.** `PrivyClient.sendSolanaTransaction`, which sends
`privy-idempotency-key: anchor-<approvalId>`. It stays until this is fixed. Adopting the adapter for
this path would silently remove a safety property from a signing path, which is not a trade to make
for a smaller diff.

**When it's fixed.** An optional `idempotencyKey` on `SvmTransactionRequest` (and the EVM request)
forwarded as the header would close it, and `PrivySolanaSigner` becomes a thin wrapper over the
adapter. `signTransaction` needs nothing — it does not broadcast, so it has nothing to make idempotent.

## Reporting

The full write-up handed to OpenSea on 2026-09-07 covers eight findings, of which findings 1-6 above
affect this repository. Two others — the four wallet-scoped operations that 401 while declaring only
`ApiKeyAuth`, and the absent `POST /api/v2/auth/tokens/exchange` — are documented in
`service/src/auth.ts` instead, because they shaped that module's whole design rather than leaving a
removable workaround.

When you hit a new one: fix it locally if you must, then **add it here and tell Ryan**. He works on
these packages. An upstream fix helps everyone; a local workaround helps once and then drifts.
