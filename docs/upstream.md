# Upstream

Code in this repository that exists **only** because something is missing or wrong in a dependency —
almost always [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js),
[`@opensea/api-types`](https://www.npmjs.com/package/@opensea/api-types) or
[`@opensea/wallet-adapters`](https://github.com/ProjectOpenSea/wallet-adapters).

Each open entry names what we wrote, why, and **what to delete when upstream fixes it**. Without this
file a workaround quietly becomes architecture: nobody remembers it was temporary, and the upstream
fix lands with no one noticing it made our code redundant — or worse, actively wrong.

Checked against `@opensea/sdk@12.5.0`, `@opensea/api-types@0.10.0`, `@opensea/wallet-adapters@1.2.0`.

**Numbers are permanent.** Entries are referenced by number from code comments and commit messages,
so they are never renumbered and never reused — only regrouped.

## Reported so far

Everything below, open and closed, has been **sent upstream as of 2026-09-09**. A new finding goes
under *Unreported* first, so the next message is only what is new; nobody wants the same list twice.
Move it down here once it has been sent.

## Unreported

*Nothing pending.* Add new findings here as its own `## N.` entry, continuing the numbering.

## Open

Live workarounds. Each one is code that deletes itself when the entry closes.

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

## 7. `/account/{address}/portfolio` 500s on the obvious call

**Upstream problem.** A live server bug, not a package one. The bare route returns
`500 {"errors":["Internal Server Error"]}` for a large account, and `200` for that same account the
moment any query parameter is supplied, and `200` for a smaller account with no parameters. Fine
when filtered, fine when small, fails when large and unfiltered.

**What we wrote.** Nothing yet. Note that finding 5 compounds it: `PortfolioArgs` does not expose
`chains`, so an SDK consumer cannot easily send the parameter that makes the call succeed.

**When it's fixed.** Nothing to delete. If it persists, the workaround is to always send a
parameter, and that belongs here as its own entry when we write it.

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

## Closed

Fixed upstream and consumed. Kept as a record of what shipped and what it let us delete — the
"what to delete when fixed" instruction is spent, so the entry is one line.

**1. Percent-encoding path segments before the SDK sees them** — `@opensea/sdk` 12.1.1 — `apiPaths` encodes every segment and refuses a bare `.` or `..`. **Deleted here:** the local `segment()` guard and its twelve call sites in `service/src/opensea.ts`. The behavioural test stays, asserting the refusal rather than our old wording.

**6. No status code on SDK errors** — `@opensea/sdk` 12.1.1 — `statusCode` on every non-OK response, via one `OpenSeaApiError` builder. **Built on it:** the retry ladder in `ReadOnlyOpenSeaAPI.get()`. 500 is deliberately excluded; see entry 7.

**8. No Solana adapter in `@opensea/wallet-adapters`** — `@opensea/wallet-adapters` 1.1.0 — `PrivySvmAdapter`. **Deleted here:** `sendSolanaTransaction`, `SendSolanaTransactionArgs` and their line on `PrivyWalletApi`. The policy half stays ours, correctly: the adapter excludes policy mutation by design.

**12. `PrivySvmAdapter` cannot send an idempotency key** — `@opensea/wallet-adapters` 1.1.0 — `idempotencyKey` on both request types, plus `capabilities.idempotentSend`, `IdempotencyUnsupportedError` and `BlankIdempotencyKeyError`. Shipped broader than reported: a caller that asks for idempotency and cannot have it now finds out. `PrivySolanaSigner` checks the capability at construction.

**14. The token names wallets the SDK cannot reach** — `@opensea/sdk` 12.5.0 — `extractLinkedWallets`. **Deleted here:** this service reading the `linked_wallets` claim itself. Order and the chain filter stayed ours, for reasons `walletsFromToken` states.

**15. No `fetchImpl` on `PrivyConfig`** — `@opensea/wallet-adapters` 1.2.0. **Deleted here:** the executor's Privy tests replacing `globalThis.fetch` and restoring it afterwards.

## Reporting

**Sent so far.** The first write-up went to OpenSea on 2026-09-07, and a second on 2026-09-09 raised
what became entries 14, 15 and 16 alongside three asks that are not workarounds — money as a decimal
string, `sortBy` on `GetTokensArgs`, and per-collection value.

Two findings never became entries here: the four wallet-scoped operations that 401 while declaring
only `ApiKeyAuth`, and the absent `POST /api/v2/auth/tokens/exchange`. Both are documented in
`service/src/auth.ts` instead, because they shaped that module's whole design rather than leaving a
removable workaround.

**When you hit a new one:** fix it locally if you must, add it under *Unreported* above, and tell
Ryan — he works on these packages. An upstream fix helps everyone; a local workaround helps once and
then drifts.

**When one closes:** delete the workaround the entry names, and check that it really is dead rather
than merely unused. Entry 1 sat "fixed and consumed" for a week with its guard still in the tree and
twelve live call sites, because the entry recorded the fix and nobody re-read the instruction under
it.
