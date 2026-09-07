# Changelog

All notable changes to Anchor are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The build diary at [anchor.ryanio.com](https://anchor.ryanio.com) has the story behind these; this
file has the facts.

## [Unreleased]

Everything below is the first release, still being assembled. Nothing is tagged yet — this heading
becomes `## [0.1.0] - YYYY-MM-DD` at the moment the tag is pushed, and not before.

### Added

**The data service** — the foundation everything else reads from, so there is one cache, one
outbound rate limit, and one place where freshness is tracked.

- Read-only by construction: only `GET` and `HEAD` are routed inbound, and the OpenSea client's
  `post()` and `request()` throw, so every SDK write path fails at the transport rather than by
  convention.
- Cache-first, backed by `node:sqlite`, with an explicit freshness envelope on every response and a
  stale-on-failure fallback. Staleness is millisecond-based and treats a backwards clock as stale.
- Built on [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js) and `@opensea/api-types`.
  Every call goes through the SDK and every response is typed from the generated OpenAPI types.
- Loopback-only, and it requires a loopback `Host` header — binding to `127.0.0.1` stops the network
  reaching it but not a browser whose DNS rebinds to it.
- Credentials live in the OS keyring, never in config, argv or logs. Errors are rebuilt from a status
  code, so a remote response body can never carry a credential back out.

**Both marketplaces.** OpenSea is NFTs *and* fungible tokens, and Anchor treats them as different
products rather than one with a quantity field. The token half covers portfolio value, balances,
trending and top tokens, individual tokens and price history.
[docs/tokens.md](docs/tokens.md) sets out the five places they genuinely diverge — including
slippage, which is a spend control: a $500 per-transaction cap means nothing if a swap executes at
90% price impact.

**Chains are configuration, and Solana is native.** `chains` is a validated list, so a Solana-only
setup is as ordinary as an EVM one. The list is derived from the SDK at runtime rather than copied,
with a compile-time check that fails if the SDK enum and the generated types ever disagree. Address
validation is chain-aware — EVM is `0x` plus 40 hex, Solana is base58 decoding to exactly 32 bytes —
and runs at config load, so a mismatch is a startup error naming the field rather than a 400 hours
later. [docs/chains.md](docs/chains.md) covers where chains actually differ.

**One credential, and a guard on it.** Every read Anchor makes needs the OpenSea API key and
nothing else. An earlier version of this file claimed account-scoped reads also required a wallet
JWT; that was wrong, and the story is in the [build diary](https://anchor.ryanio.com). A wallet
token is still supported — `anchor-service --set-pat` stores a personal access token, exchanged for
a JWT and refreshed before expiry — because the spec declares `WalletAuth` on fifty paths Anchor
does not call yet, and writing will need it. It gates nothing.

Credentials are validated on the way in. A credential is one opaque token, and a value carrying
whitespace or control characters is refused rather than stored, because a reader that accepts
"whatever line arrived" will cheerfully store a shell command — which is exactly what happened.

**Policy-bound execution** (preview — see Known limitations). An `Executor` interface splitting
`request → simulate → decide → submit`, so holding one stage does not grant the next. Approvals are
unforgeable two ways: an `ApprovedAction` carries a property keyed by a non-exported `unique symbol`,
and because a cast defeats types, the brand is backed by a module-private `WeakSet` that
`Signer.submit` checks. The witness has no runtime representation, so a spread, `structuredClone` or
JSON round-trip fails closed. Actions that delegate standing authority are excluded from the
delegable action type altogether — they cannot be configured into an allowlist by a typo or a future
refactor.

**The executor speaks both chains.** `Address` is a union of two nominally distinct branded types,
`EvmAddress | SolanaAddress`, parsed rather than pattern-matched: EVM hex is lowercased because
EIP-55 casing is a checksum, and base58 is preserved verbatim because its casing is *the value*.
Every allowlist entry is a `(chain, address)` pair, so an entry for one chain never matches an
address on another — the same twenty hex bytes name a different contract on every EVM chain, and
`CREATE2` puts chosen code at a chosen address on a chain nobody configured.

`setApprovalForAll` turned out to have several Solana counterparts rather than none. The membership
test is written down — an action that *moves no value*, *grants an authority outliving the
transaction*, and *needs a revocation nobody can guarantee* — and it admits the SPL `Approve`
delegate and `SetAuthority`, which does not bound what a delegate may spend but hands over the
account. It also admits the System Program's `Assign`, the widest member of the class and the one an
SPL-only reading misses: a wallet account is system-owned, an account's owner program may debit its
lamports with no signature, so one `Assign` hands over the entire native balance having moved
nothing. Closing an account is deliberately outside the class (it moves value, so the withdrawal
allowlist covers it), and arbitrary program invocation is not an action kind at all: an
`ActionRequest` carries intent and has no member that can hold instructions or bytes.

A dependency-free guard parses legacy and v0 Solana transactions and refuses a delegation, an
unallowlisted program, or an unrecognised instruction — soundly *in the presence of address lookup
tables*, because it reads program ids and instruction data rather than resolved accounts. It is
explicit that it cannot check where value goes when operands resolve through a table: a refusal
filter, never a simulation.

Being on the program allowlist means *permission to be inspected*, not permission to run. Three of
the six allowlisted programs have their instructions classified — three discriminant encodings in
one file, because SPL Token's tag is one byte, the System Program's is a four-byte little-endian
`u32`, and the Compute Budget program's is a one-byte borsh tag. The Compute Budget program is
included because it is not inert: `SetComputeUnitPrice` names a price per compute unit, and at the
maximum unit limit it commits the account's entire native balance to a validator tip. That is a
spend no cap can see, because a priority fee produces no asset delta and appears in no simulation,
so it is refused here against a ceiling of 0.01 SOL rather than upstream where the number does not
exist. Unusually for this module the check is exact: both operands are inline literals, so no
lookup table can move the answer.

A Privy backend is the first authority where enforcement lives outside Anchor's process: the key is
in Privy's enclave, and Anchor audits the remote policy at startup and refuses to run when its local
limits claim more than that policy grants. Caps charge gross outflow, because netting would permit
wash-trade drains, and budget is reserved at approval rather than settlement. The value ladder —
$100 to $100k+, each tier earned by a clean incident record — is in
[docs/autonomy.md](docs/autonomy.md).

**The site, the brand, and the tooling.**

- anchor.ryanio.com: build diary, changelog and `llms.txt`, on a deep-water palette with shared
  tokens in `theme/tokens.css` reused across the project rather than redefined.
- An anchor mark that reads as an **A**, stroke-based on `currentColor`, legible at 16px.
- `scripts/check-contrast.ts` computes WCAG ratios from the tokens and fails CI — all 20 text and
  accent pairs clear AA in both themes, so a colour that looks good but is unreadable cannot land.
- `scripts/check-versions.ts` enforces the Node floor across `.node-version`, CI and the PKGBUILD,
  and requires GitHub Actions to be pinned to commit SHAs rather than mutable tags.
- Biome as the single formatter and linter — never ESLint or Prettier.
- `scripts/generate-asset.ts` for images and video from xAI, key in the keyring, zero dependencies.
- [docs/upstream.md](docs/upstream.md) — every workaround that exists only because of an upstream
  gap, and what to delete when each is fixed.

### Known limitations

- **The wallet-token exchange has never been run end to end.** Its request and response shapes are
  read from `@opensea/sdk`'s source rather than from a successful call. We now hold a scoped token,
  but no route Anchor calls needs one, so nothing exercises the path.
- **`/account/{address}/portfolio` returns 500 upstream** for a large account with no query
  parameters, and 200 for that same account with any parameter. Reported to OpenSea; see
  [docs/upstream.md](docs/upstream.md).
- **Privy's policy engine cannot express Anchor's cumulative caps.** Its spend-limit primitive tops
  out at a 72-hour rolling window and does not observe `eth_sendTransaction` at all, so the rolling
  24h and 7d caps in [docs/autonomy.md](docs/autonomy.md) are enforced *only* by the in-process
  mirror. The per-transaction cap, the contract and withdrawal allowlists, and the delegation
  refusal are enforced by Privy and survive a compromised desktop. The rolling totals do not.
- **Privy's Solana policy engine is materially weaker than its EVM one**, and this is the finding to
  read twice. It has no condition that can name `Approve`, `ApproveChecked` or `SetAuthority` — its
  token decoder covers six other instructions — so there is no Solana equivalent of the
  `ethereum_calldata` + `function_name` condition that refuses `setApprovalForAll` by name. The only
  remote control is an ALLOW rule that positively lists the instructions Anchor sends, letting
  default-deny refuse the rest; omit that one condition and the control disappears with no error
  anywhere, so Anchor's startup audit refuses to run against a policy missing it. Solana also has
  *no* aggregation primitive at all, so both cumulative caps are local-only there, and Privy reject
  outright any transaction whose conditions need an address loaded from an address lookup table.
  Starkest of all: **there is no Compute Budget condition source**, so a Privy policy can permit the
  program and then say nothing whatever about the priority fee it names. The other gaps are controls
  weaker than their EVM counterparts; this one has no remote expression at all, and the local ceiling
  is the only thing standing there. The startup audit states it every time rather than refusing,
  because there is no policy change that would fix it.
- **Anchor cannot build a Solana transaction.** Compiling an SPL transfer needs associated token
  account derivation — ed25519 on-curve arithmetic — and a live blockhash. The builder refuses and
  explains itself; the policy, guard and signer around it are complete and tested. Closing this needs
  either a compiled transaction from OpenSea's `/swap/execute` or a runtime dependency, which is a
  human's decision.
- **`ActionRequest` does not model a signed Seaport order**, so marketplace actions are approved by
  policy and then refused by the transaction builder. ERC-721 withdrawals work end to end. Seaport is
  EVM-only upstream, so there is no Solana version of this gap.
- **No package yet.** `packaging/PKGBUILD` is a skeleton targeting the `[omarchy]` repository; the
  install path is not yet `omarchy pkg install anchor`.

[Unreleased]: https://github.com/ryanio/anchor/compare/main...HEAD
