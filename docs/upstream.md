# Upstream workarounds

Code in this repository that exists **only** because something is missing or wrong in a dependency —
almost always [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js) or
[`@opensea/api-types`](https://www.npmjs.com/package/@opensea/api-types).

Each entry names what we wrote, why, and **what to delete when upstream fixes it**. Without this
file, a workaround quietly becomes architecture: nobody remembers it was temporary, and the upstream
fix lands with no one noticing it made our code redundant — or worse, actively wrong.

Findings were reported upstream on **2026-09-07**, and this file was last checked against
`@opensea/sdk@12.5.0`, `@opensea/api-types@0.10.0` and `@opensea/wallet-adapters@1.2.0`. Re-check this file whenever either package is bumped;
`scripts/check-versions.ts` does not check it, because "is this still needed" is a judgement call.

---

## 0. The live API answers in camelCase; the generated types declare snake_case

**Upstream problem.** `@opensea/api-types@0.9.3` declares these responses in snake_case, and
`api.opensea.io` answers in camelCase. Measured 2026-09-08 through the local service against a real
wallet:

| Declared in `api-types` | Actually returned |
|---|---|
| `total_value_usd`, `nft_value_usd`, `token_value_usd` | `totalValueUsd`, `nftValueUsd`, `tokenValueUsd` |
| `pnl_absolute`, `pnl_percentage` | `pnlAbsolute`, `pnlPercentage` |
| `token_balances[].usd_value`, `.usd_price`, `.image_url` | `tokenBalances[].usdValue`, `.usdPrice`, `.imageUrl` |
| `TokenBalanceResponse.status` (spam classification) | **absent entirely** |

`nfts[]` and `.collection` agree in both, so only some responses are affected.

This one is worth stating carefully, because it inverts the usual rule. Generated types are supposed
to turn a wrong field name into a compile error — here the generated types *are* the wrong field
name, and the code compiled cleanly while reading nothing. Only a real response revealed it. The
absent `status` is the sharper half: code that filters on a documented spam classification silently
filters out everything when the field never arrives.

**What we wrote.** `field(raw, ...names)` in `devices/src/state/anchor.ts`, accepting either
spelling at each site, and treating an absent `status` as `OK` rather than as spam. Tests pin both
shapes, so whichever side changes, the panel keeps working.

**What to delete when upstream fixes it.** The `field()` helper and its second argument at each call
site, once `api-types` and the API agree. Keep the tests: they document which spelling arrived.

**Report this.** Either the spec or the serializer is wrong, and a consumer cannot tell which from
the outside. The missing `status` field should be reported separately — it is documented in detail
in the schema and does not appear in responses.

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

**Still missing, and narrower than it was.** 12.5.0 added `sortBy` and `disableSpamFiltering` to
several arg types, but not to `GetTokensArgs`, which still carries only `limit`, `cursor`, `next` and
`chains`. `/tokens` still cannot sort.

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

**Status: fixed upstream and consumed** in `@opensea/wallet-adapters` 1.1.0. `PrivySvmAdapter` is
now `PrivySolanaSigner`'s transport. Deleted from `executor/src/privy-api.ts`: `sendSolanaTransaction`,
`SendSolanaTransactionArgs`, and their line on `PrivyWalletApi`.

The existing wire-level tests passed unchanged across the swap — same `signAndSendTransaction` body,
same base64, same documented CAIP-2 — which is the useful kind of evidence that the replacement is
faithful rather than merely compiling.

Two things the adapter does *not* close, and neither is a criticism of it:

- It takes an already-serialized transaction, so Anchor still cannot **compile** one — that needs
  associated token account derivation (ed25519 on-curve arithmetic) and a live blockhash.
- It deliberately excludes policy mutation ("do not add `setPolicy`, `rotateOwner`, `addSigner`"), so
  `getPolicy`, `replacePolicyRules`, `loadAuthorizationKey`, `signAuthorizationPayload` and
  `canonicalize` stay ours. That is the right split: the thing that signs and the thing that decides
  what may be signed should not be the same dependency.

`solana.ts` stays regardless. Refusing a delegation is a security property Anchor owns, not something
an adapter would provide.

**Upstream problem (as originally filed).** [`ProjectOpenSea/wallet-adapters`](https://github.com/ProjectOpenSea/wallet-adapters)
is the package Anchor would otherwise use for managed signing: adapters for Privy, Turnkey,
Fireblocks, Bankr and local keys, with bridges for ethers and viem. Every one of them was EVM. There
was no Solana adapter, no Solana bridge, and no non-EVM signing abstraction in the repository.

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

## 14. The token names wallets the SDK cannot reach

**Status: fixed upstream and consumed** in `@opensea/sdk` 12.5.0. `extractLinkedWallets(token)` is
now the source of the wallet set, beside `extractOpenSeaScopes` and `extractWalletAddress`.

Two things stayed ours, and both are stated in `walletsFromToken`: the **order**, because
`wallets[0]` is the primary and the two routes that cannot fan out read it, and the **chain filter**,
because the SDK deliberately applies no format validation and leaves that to the server. One thing
had to be added: `extractLinkedWallets` answers `[]` for a non-JWT while `decodeJwtPayload` throws,
and a startup path must degrade rather than crash.

The doc comment that shipped names the trap directly — *"Combining it with the `wallet` claim
double-counts the primary; using only the `wallet` claim under-reports every account that has linked
more than one."* Our implementation predates it and avoided the first half by deduping, which is
luck rather than design.

**Upstream problem (as originally filed).** A wallet PAT's JWT carried `linked_wallets` and neither
`@opensea/sdk` nor `@opensea/cli` mentioned the claim. The SDK issued a credential describing more
wallets than the SDK could spend, so a consumer either ignored them — silently under-reporting a
portfolio, which is what happened here — or decoded the JWT itself.

## 15. No `fetchImpl` on `PrivyConfig`

**Status: fixed upstream and consumed** in `@opensea/wallet-adapters` 1.2.0. The executor's Privy
tests inject a stub rather than replacing `globalThis.fetch` and restoring it afterwards. A test that
reaches for a global is a test that can leak into the one after it.

**Upstream problem (as originally filed).** `PrivyConfig` took `appId`, `appSecret`, `walletId`,
`baseUrl` and `authSigningKey`. `baseUrl` lets a test point at a local server; it does not let one
assert on a request without running one, and `onRequest` observes a request rather than substituting
the transport.

## 12. `PrivySvmAdapter` cannot send an idempotency key

**Status: fixed upstream and consumed** in `@opensea/wallet-adapters` 1.1.0, and fixed more
thoroughly than reported. `idempotencyKey` is on both the EVM and SVM request types and reaches
Privy as `privy-idempotency-key`. Beyond that:

- `capabilities.idempotentSend` says whether a provider honours it.
- `IdempotencyUnsupportedError` and `requireIdempotencySupport` make a provider that cannot honour a
  key **throw rather than drop it**, so protection can never be silently absent.
- `BlankIdempotencyKeyError`, because a blank key protects nothing.

The last two are the part worth calling out: the bug that was reported was one adapter missing a
header, and what shipped closes the whole class — a caller that asks for idempotency and does not
get it now finds out.

`PrivySolanaSigner` checks `idempotentSend` **at construction**. Discovering it while holding an
approved action is discovering it too late.

**Upstream problem (as originally filed).** 1.0.0 sent exactly two Privy headers — `privy-app-id`
and `privy-authorization-signature`. There was no `privy-idempotency-key`, no way to add one, and
`onRequest` observes a request rather than amending it. Privy caches a key's outcome for 24 hours,
which is what makes a resubmitted approval a no-op instead of a second on-chain spend.

## 13. No per-collection holdings value

**Upstream problem.** Anchor can show what a portfolio is worth by type, by wallet, by asset and by
chain. It cannot show it **by collection**, which is the split an NFT holder asks for first.

What the API offers is a floor price per collection (`/collections/{slug}/stats`) and a paginated
NFT list per account. Value per collection would have to be *count × floor* — an estimate, and one
that would sit in a column beside figures that are not estimates. `/account/{address}/portfolio`
returns `nftValueUsd` as a single number; nothing breaks it down.

**What we wrote.** Nothing, deliberately. The breakdown tabs are `type`, `wallets`, `assets`,
`chains`, and a `collections` tab is absent rather than approximated. `docs/tokens.md` sets out the
same rule for chain splits of NFT value: inventing a plausible number from what is available is
exactly what this widget exists not to do.

**When it's fixed.** A per-collection value in the portfolio response — or a documented
`group_by=collection` on it — becomes a fifth tab and about thirty lines of model code. The rendering
is already there; only the number is missing.

## 16. A portfolio is per-address, so a multi-wallet account costs N requests

**Upstream problem.** `/account/{address}/portfolio` answers for one address. An account whose token
resolves nine wallets — which is what `linked_wallets` gives, see entry 14 — needs nine requests
through one rate limiter, and the **caller** sums the money.

**What we wrote.** `service/src/aggregate.ts`, about 120 lines: fan out sequentially so a portfolio
refresh cannot starve the health check behind it, sum with BigInt at a common scale because these
are dollars, and label a partial answer with an `incomplete` list rather than trimming a wallet that
failed. Plus `service/src/wallets.test.ts`, which walks `WALLET_ROUTES` so a route added later cannot
quietly read only the first wallet again.

**Attempted upstream and withdrawn.** An `addresses[]` parameter was started and reverted: taking a
list of addresses raises an authorization question a single-address route does not, since the route
is otherwise reading public data one address at a time.

That constraint may be pointing somewhere better. The request already carries a token, and the token
already knows which wallets belong to the account — so the shape with no authorization question is
**not** `addresses[]` at all but an address-less "my portfolio", summed server-side over exactly the
wallets the token names. Nothing to authorize, nothing to enumerate, and no cap to negotiate against
the size of `linked_wallets`.

**When it's fixed.** `aggregate.ts` mostly deletes itself. Whatever the shape, two properties are
worth keeping from having built it client-side: **per-address rows beside the sum**, or callers go
straight back to N requests for the breakdown; and **a partial answer that says which addresses are
missing**, because a `200` carrying a quietly short total is the original bug moved server-side.

## Reporting

The full write-up handed to OpenSea on 2026-09-07 covers eight findings, of which findings 1-6 above
affect this repository. Two others — the four wallet-scoped operations that 401 while declaring only
`ApiKeyAuth`, and the absent `POST /api/v2/auth/tokens/exchange` — are documented in
`service/src/auth.ts` instead, because they shaped that module's whole design rather than leaving a
removable workaround.

When you hit a new one: fix it locally if you must, then **add it here and tell Ryan**. He works on
these packages. An upstream fix helps everyone; a local workaround helps once and then drifts.
