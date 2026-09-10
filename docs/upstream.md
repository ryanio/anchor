# Upstream

Code in this repository that exists **only** because something is missing or wrong in a dependency —
almost always [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js),
[`@opensea/api-types`](https://www.npmjs.com/package/@opensea/api-types) or
[`@opensea/wallet-adapters`](https://github.com/ProjectOpenSea/wallet-adapters).

Each open entry names what we wrote, why, and **what to delete when upstream fixes it**. Without this
file a workaround quietly becomes architecture: nobody remembers it was temporary, and the upstream
fix lands with no one noticing it made our code redundant — or worse, actively wrong.

Checked against `@opensea/sdk@12.7.0`, `@opensea/api-types@0.11.1`, `@opensea/wallet-adapters@1.2.1`,
installed fresh rather than only tagged.

**Numbers are permanent.** Entries are referenced by number from code comments and commit messages,
so they are never renumbered and never reused — only regrouped.

## Reported so far

Everything below, open and closed, has been **sent upstream as of 2026-09-09**, and answered
**2026-09-10** — the reply that closed entries 0, 2, 4 and 5, corrected entry 16, rebutted entry 3,
and added entry 17. A new finding goes under *Unreported* first, so the next message is only what is
new; nobody wants the same list twice. Move it down here once it has been sent.

## Unreported

*Nothing pending.* Add new findings here as its own `## N.` entry, continuing the numbering.

## Open

Live workarounds. Each one is code that deletes itself when the entry closes.

## 3. Hand-rolled base58 address validation

**Rebutted — no pattern is coming, and the decoder stays permanently.** There are no `SolanaAddress`
or `EvmAddress` schemas in the spec to begin with: `OpenApiConfig` deliberately replaces
`BlockchainAddress` with one string schema whose description lists all three chains' formats, and the
SDK's own kdoc says why no `pattern` is published. A regex works for EVM. It cannot work for Solana,
where validity is length 32–44 *and* a decoded size of exactly 32 bytes — a 44-character base58
string decoding to 33 bytes has to be rejected, and Bitcoin needs a checksum on top. Any pattern
OpenSea published would be a three-way union that still leaves the caller decoding, which is worse
than no pattern because it looks like validation. This entry does not close; it stops expecting one.

**Upstream problem.** No address validator for non-EVM chains. `checksumAddress` is EVM-only and
throws on anything else, and — see above — no schema-level pattern will fill the gap.

**What we wrote.** `decodeBase58` and `isSolanaAddress` in `service/src/chains.ts`. A length check
alone is not sufficient — base58 is not fixed-width, so a 44-character string can decode to 33 bytes
— which is why this is a decoder rather than a regex.

**When it's fixed.** It is not going to be, by design. Keep the decoder and the cross-chain confusion
tests permanently; they assert that an allowlist entry for one chain never matches an address on
another, which is our property, not the SDK's.

## 7. `/account/{address}/portfolio` 500s on the obvious call

**Upstream problem.** A live server bug, not a package one. The bare route returns
`500 {"errors":["Internal Server Error"]}` for a large account, and `200` for that same account the
moment any query parameter is supplied, and `200` for a smaller account with no parameters. Fine
when filtered, fine when small, fails when large and unfiltered. `portfolioStats` already sends
`chains` (entry 5 closed that gap in `PortfolioArgs`), so the parameter this needs is one we send.

**What we wrote.** Nothing yet. **As of 2026-09-10, instrumented and tagged by gRPC status on
OpenSea's side**, so it will be sized from data rather than one report. A related bug is fixed there
too: the portfolio value cache was keyed on address but not the chain filter, so a chain-filtered
request could be served an all-chain total for up to thirty minutes.

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

**As of 2026-09-10:** confirmed still open, and confirmed to be a product decision rather than an
engineering one — not something the person answering these reports can decide alone.

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

**Attempted upstream and withdrawn.** An `addresses[]` parameter was started and reverted.

**Correction, 2026-09-10: it was not reverted over the authorization question.** That question was
solvable, and was solved, by restricting the list to the caller's own linked wallets. It was reverted
because it shipped non-functional: the handler had no `@WalletIdentity` annotation, and the
interceptor that populates the wallet context returns early without one, so every request using it
returned 403. Nothing here to un-plan on our side; `aggregate.ts` was never at risk of a fix that
does not work.

That constraint may still be pointing somewhere better. The request already carries a token, and the
token already knows which wallets belong to the account — so the shape with no authorization question
is **not** `addresses[]` at all but an address-less "my portfolio", summed server-side over exactly
the wallets the token names. Nothing to authorize, nothing to enumerate, and no cap to negotiate
against the size of `linked_wallets`. **But it needs the same `@WalletIdentity` annotation, and once
the response depends on who is asking it collides with a 60-second shared cache keyed on URL — the
two have to move together, and as of 2026-09-10 OpenSea has decided not to build either for now.**

**So `aggregate.ts` stays**, and that is a real, named cost of the decision rather than an implied
one. Two requirements are recorded against whatever ships later: **partial failure with an explicit
`incomplete` list**, and **per-address rows beside the sum**, or callers go straight back to N
requests for the breakdown.

**When it's fixed.** `aggregate.ts` mostly deletes itself. Both properties above have to survive the
move, or the replacement is a regression wearing a smaller diff.

## 17. `collection` is documented on the account NFTs endpoint; the SDK still does not send it

**Found by OpenSea, not by us — confirmed 2026-09-10.** The endpoint documents a `collection` query
parameter; `OpenSeaAPI.getNFTsByAccount` has no `collection` field on `GetNFTsByAccountOptions` to
carry it. Now guarded by a test on their side, so the gap will not quietly grow a sibling. The
`includeAutoHidden` option added in `@opensea/sdk` 12.7.0 shipped on the same options type,
confirming the parameter itself is reachable — the SDK's argument surface for this endpoint has just
never included `collection`.

**What we wrote.** `nftsByAccount` in `service/src/opensea.ts` already routes a collection-scoped
request through `getNFTsByCollection` instead — the same data, filtered server-side by collection
rather than by owner — so the missing parameter never blocked a feature here. This entry exists so
the workaround has a number rather than living only as a comment at the call site.

**When it's fixed.** If `GetNFTsByAccountOptions` gains `collection`, switch back to
`getNFTsByAccount(address, ..., { collection })` and delete the branch in `nftsByAccount`.

## Closed

Fixed upstream and consumed. Kept as a record of what shipped and what it let us delete — the
"what to delete when fixed" instruction is spent, so the entry is one line.

**0. The live API answers in camelCase; the generated types declare snake_case** — **false alarm, not a fix.** The mismatch was `@opensea/sdk`'s own `camelizeResponse` (default `true`) rewriting every response before this codebase saw it — both `api-types` (snake_case, matching the wire) and the SDK (camelCase, matching what it hands back) were correct and describing different views, and it only showed up because SDK results were being typed against raw `api-types` types. `status` is also confirmed non-nullable, populated on every balance from a SQL projection — the "absent entirely" row in the original table was wrong. **Deleted here:** the `field(raw, ...names)` helper in `devices/src/state/anchor.ts` and its second argument at every call site; every read now names the one camelCase field that actually arrives. Kept, as a defensive fallback rather than a documented gap: treating an absent `status` as `OK`. Kept, unrelated to the mismatch: `balances` vs. `tokenBalances` in `readTokens`/`readChains`, which is genuinely two different response shapes (the aggregating service's wrapper vs. a single wallet's), not a casing difference. `@opensea/sdk` 12.7.0 also exports `Camelize`, `Snakeize`, `camelizeKeysDeep` and `snakeizeKeysDeep` from its root and documents the casing contract in its README, with every documented example type-checked in CI against the shipped declarations.

**1. Percent-encoding path segments before the SDK sees them** — `@opensea/sdk` 12.1.1 — `apiPaths` encodes every segment and refuses a bare `.` or `..`. **Deleted here:** the local `segment()` guard and its twelve call sites in `service/src/opensea.ts`. The behavioural test stays, asserting the refusal rather than our old wording.

**2. Subclassing `OpenSeaAPI` to get a transport seam** — `@opensea/sdk` 12.7.0 — `OpenSeaAPIConfig.fetch`, a transport hook at the URL/init level, documented with exactly the cache pattern this codebase needed. Went further than asked: `OpenSeaAuth` (seven request sites), `OpenSeaOAuth`, `requestSiwxNonce`, `linkWalletWithSiwx` and the static `requestInstantApiKey` all read the global `fetch` before this and now take an optional one too, and 12.7.0 separately fixes `OpenSeaSDK.requestInstantApiKey` not forwarding it. **Kept regardless:** the `ReadOnlyOpenSeaAPI` subclass — `post()`/`request()` throwing `ReadOnlyViolationError` is a security property of this service, not a workaround, and is asserted by twelve tests. **Not changed:** the `AsyncLocalStorage` scope carrying per-call TTL and freshness metadata (`callScope`, `service/src/opensea.ts`). The new `fetch` hook is instance-wide, and `OpenSeaClient` reuses one `ReadOnlyOpenSeaAPI` instance across calls with different TTLs, so moving the cache down to that hook would still need a scoping mechanism to get a per-call TTL into a fixed `(url, init) => Promise<Response>` signature — a real simplification candidate, not a drop-in deletion, and out of scope for this pass.

**6. No status code on SDK errors** — `@opensea/sdk` 12.1.1 — `statusCode` on every non-OK response, via one `OpenSeaApiError` builder. **Built on it:** the retry ladder in `ReadOnlyOpenSeaAPI.get()`. 500 is deliberately excluded; see entry 7.

**4. No runtime chain list** — `@opensea/api-types` 0.11.1 — `CHAIN_IDENTIFIERS` and `isChainIdentifier`, generated from the spec's chain enum and wired into OpenSea's weekly sync; 29 chains, verified by installing the package fresh. **Deleted here:** `ChainsAgree`, the compile-time proof that the SDK's `Chain` enum and the api-types union described the same set — the two are still separately generated (the SDK's chain-scoped methods take `Chain`, not `ChainIdentifier`), but agreement between them is now the thing OpenSea verifies weekly rather than something this repo's typecheck caught. `CHAINS` in `service/src/chains.ts` now aliases `CHAIN_IDENTIFIERS` directly. Worth knowing this only catches drift in one direction — the enum and the union are equal today rather than provably kept that way here.

**5. Missing query parameters on SDK arg types** — `@opensea/sdk` 12.7.0 — `GetTokensArgs.sortBy` (typed `TokenRankingSortBy`, lowercase, derived from the spec) and `.sortDirection`. `/tokens/top` and `/tokens/trending` both take `sort_by`/`sort_direction`; the API parses case-insensitively but the published enum and the type are lowercase. Defaults are unchanged — sending neither keeps each endpoint's original ordering. `PortfolioArgs.chains` and `GetTokensArgs.chains` closed earlier, in 12.4.1; this was the one param this entry tracked that stayed missing until now. **Surfaced here:** `TOKEN_SORT_BY` and `TokenSort` in `service/src/opensea.ts`, `trendingTokens`/`topTokens` taking a `sort` argument, and `sort_by`/`sort_direction` query params on `/tokens/trending` and `/tokens/top` in `service/src/server.ts`, validated against `TOKEN_SORT_BY` before reaching the SDK.

**8. No Solana adapter in `@opensea/wallet-adapters`** — `@opensea/wallet-adapters` 1.1.0 — `PrivySvmAdapter`. **Deleted here:** `sendSolanaTransaction`, `SendSolanaTransactionArgs` and their line on `PrivyWalletApi`. The policy half stays ours, correctly: the adapter excludes policy mutation by design.

**12. `PrivySvmAdapter` cannot send an idempotency key** — `@opensea/wallet-adapters` 1.1.0 — `idempotencyKey` on both request types, plus `capabilities.idempotentSend`, `IdempotencyUnsupportedError` and `BlankIdempotencyKeyError`. Shipped broader than reported: a caller that asks for idempotency and cannot have it now finds out. `PrivySolanaSigner` checks the capability at construction.

**14. The token names wallets the SDK cannot reach** — `@opensea/sdk` 12.5.0 — `extractLinkedWallets`. **Deleted here:** this service reading the `linked_wallets` claim itself. Order and the chain filter stayed ours, for reasons `walletsFromToken` states. **Follow-on, 12.7.0:** `tryDecodeJwtPayload`, the non-throwing form of `decodeJwtPayload`, now the documented way to tell "not a JWT" apart from "JWT, empty claim" — reported because a note here about `extractLinkedWallets` returning `[]` where `decodeJwtPayload` throws surfaced a sharper bug: `decodeJwtPayload` ended in `JSON.parse(json) as Record<string, unknown>`, so a payload of `123` or `[1,2]` parsed fine, the assertion was a lie, and every claim read `undefined` while the token looked readable. It now rejects a non-object payload, which makes `tryDecodeJwtPayload(token) === null` a complete check. **Deleted here:** the `try`/`catch` around `decodeJwtPayload` in `walletFromToken`, `describeTokenShape` and `walletsFromToken` (`service/src/wallet-token.ts`), all three now calling `tryDecodeJwtPayload` directly.

**15. No `fetchImpl` on `PrivyConfig`** — `@opensea/wallet-adapters` 1.2.0. **Deleted here:** the executor's Privy tests replacing `globalThis.fetch` and restoring it afterwards.

## Reporting

**Sent so far.** The first write-up went to OpenSea on 2026-09-07, and a second on 2026-09-09 raised
what became entries 14, 15 and 16 alongside three asks that are not workarounds — money as a decimal
string, `sortBy` on `GetTokensArgs`, and per-collection value. **Answered 2026-09-10**, closing
entries 0, 2, 4 and 5, correcting entry 16, rebutting entry 3, and reporting entry 17 back to us —
see each entry above for what shipped.

Two findings never became entries here: the four wallet-scoped operations that 401 while declaring
only `ApiKeyAuth`, and the absent `POST /api/v2/auth/tokens/exchange`. Both are documented in
`service/src/auth.ts` instead, because they shaped that module's whole design rather than leaving a
removable workaround.

**Declined, with reasons, 2026-09-10.**

- `disableSpamFiltering` on `/tokens/top` and `/tokens/trending`. That path has no heuristic filter to
  disable — rows come from a curated table, then a Trust and Safety enforcement check and a
  hidden-from-client exclusion. A flag by that name there would mean returning tokens OpenSea has
  enforced against, which is not what it means on the balances endpoint.
- Money as a decimal string, as a sweep across the API. The count is 24 fields, not the dozen it
  looks like, and precision was never the strongest argument — float64 holds exact integers past $90
  trillion in cents. The real reasons are formatting determinism and that `JSON.parse` picks the
  numeric type before a caller can. Rather than a breaking wire change, OpenSea now fails their build
  when a new money-shaped field ships as a number, with the 24 on an allowlist that can shrink and
  never grow. 51 money fields are already strings, including every total this codebase sums — the
  convention closes over time without a migration here.

**Shipped, unrequested, 2026-09-10.** `getNFTsByAccount`'s options gained `includeAutoHidden`
(`include_auto_hidden` on the wire) — NFTs hidden automatically because a third party minted or sent
them, distinct from holder-hidden or policy-removed items, both still excluded. Not wired up here;
nothing in this codebase currently needs it. `@opensea/cli` 2.5.0 separately caps a `Retry-After` it
honours at 300 seconds — a misconfigured proxy could previously send `retry-after: 999999` and sleep
11.5 days, or overflow `setTimeout` past ~24.8 days and retry after 1ms with no backoff. Not our
dependency (we vendor no `@opensea/cli` code), noted here only because a proxy in front of our own
outbound calls could hit the same class of bug — see `RETRYABLE_STATUSES` and `CALL_DEADLINE_MS` in
`service/src/opensea.ts`, which already bounds the whole call rather than trusting a header.

**When you hit a new one:** fix it locally if you must, add it under *Unreported* above, and tell
Ryan — he works on these packages. An upstream fix helps everyone; a local workaround helps once and
then drifts.

**When one closes:** delete the workaround the entry names, and check that it really is dead rather
than merely unused. Entry 1 sat "fixed and consumed" for a week with its guard still in the tree and
twelve live call sites, because the entry recorded the fix and nobody re-read the instruction under
it.
