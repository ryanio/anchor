# Changelog

All notable changes to Anchor are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The build diary at [anchor.ryanio.com](https://anchor.ryanio.com) has the story behind these; this file
has the facts.

## [Unreleased]

### Added
- **The data service is built on `@opensea/sdk` and `@opensea/api-types`.** The SDK makes every
  OpenSea call and the generated types replace `unknown` everywhere. Anchor keeps the parts the SDK
  does not provide — one shared cache, one shared outbound rate limit, the freshness envelope, and
  errors that are built from a status code rather than from a remote body.
- **Chains are configuration.** `chains` is a list validated against OpenSea's own chain union
  (29 slugs, Solana included), and a Solana-only setup is as ordinary as an EVM one. The list is
  derived from the SDK at runtime rather than copied, and a compile-time check fails if the SDK enum
  and the generated types ever disagree. A single `"chain": "base"` string is still accepted and read
  as a one-element list; setting both is refused.
- **Address validation is chain-aware.** EVM is `0x` plus 40 hex; Solana is base58 decoding to
  exactly 32 bytes. Wallet and token addresses are checked against the configured chains at config
  load, so a mismatch is a startup error naming the field rather than a 400 at the first API call.
- **The token half of the API**, chain-aware throughout: `/portfolio/value`, `/balances`,
  `/tokens`, `/tokens/trending`, `/tokens/top`, `/tokens/:address`, `/tokens/:address/price_history`.
  Endpoints that take a `chains` list get every configured chain; endpoints whose path carries one
  chain use the first, and `/health` reports which that is.
- **A second credential.** Account-scoped OpenSea reads need a wallet JWT in addition to the API key
  — measured, not assumed. `anchor-service --set-pat` stores a personal access token in the keyring,
  which is exchanged for a JWT and refreshed before it expires. Without one, account routes fail with
  a message naming the missing credential before any network call rather than passing a bare 401
  through. `/health` and a startup line report which credentials are present.
- `docs/chains.md` — what is free about a new chain on the data side, and where chains genuinely
  diverge: Seaport order construction is EVM-only and the SDK refuses Solana outright, while
  `/swap/execute` returns Solana instructions in the same response shape as EVM calldata. Names the
  Solana hazards that replace `setApprovalForAll` — SPL delegate authority, `SetAuthority`, and
  upgradeable programs — and flags what is documented rather than verified.
- `site/links.ts` — every external URL in one place. Renaming the game repository broke four links at
  once, because GitHub redirects repository URLs but not GitHub Pages; one constant makes the next
  rename a single edit.

### Fixed
- Every OpenSea endpoint path in `docs/tokens.md` was wrong. `token_balances_by_account`,
  `token_price_history` and `swap_quote` are not endpoints; the real ones are
  `/account/{address}/tokens`, `/chain/{chain}/token/{address}/price_history` and `/swap/quote`.
  They now come from the generated OpenAPI types instead of from memory.
- Untrusted path segments are percent-encoded before they reach the SDK. `@opensea/sdk` builds paths
  with template literals and no encoding, so a collection slug of `../../events/accounts/0xdead`
  retargeted the request at a different endpoint and collided its cache key. Worth fixing upstream.

### Changed
- The counterpoint accent is `--ember`, not `--coral`. The name collided with another project.
- Mobile navigation drops to icons below 560px, and the wordmark below 380px. Four labelled links plus
  the wordmark wrapped to a second line on a phone and clipped "Source" off the right edge entirely.
  Accessible names move to `aria-label`, so nothing is lost to a screen reader.

### Added
- `docs/tokens.md` — OpenSea is both marketplaces, and Anchor was designed around one. Sets out the
  five places where fungible tokens are genuinely a different product rather than NFTs with a quantity
  field, the token half of the API, and what each changes.

### Changed
- Spend controls gain the token-specific limits. Slippage is a spend control: a $500 per-transaction
  cap means nothing if a swap executes at 90% price impact. Exposure is capped per asset, not only per
  transaction. An approval is bound to the quote it approved. Token allowlists invert to default-deny,
  because anything can deploy a token.
- Game links updated: the repository is now `tidebreak`. GitHub redirects repository URLs but *not*
  GitHub Pages, so the old play URL was a hard 404.

### Added
- **Privy backend for the executor** — the first `PolicyAuthority` and `Signer` where enforcement is
  not in Anchor's process. The key lives in Privy's enclave and every signing request is checked
  against a policy held with them. Anchor audits that remote policy at startup and refuses to run
  when the local limits claim more than it grants; the kill switch empties the policy over the API,
  and throws rather than reporting success when Privy does not confirm. Hand-rolled REST client:
  `fetch` and `node:crypto`, no Privy SDK, no runtime dependencies.
- Privy credentials read from the OS keyring, with `node executor/src/cli.ts --set-key`. No
  environment-variable fallback for a credential that can move funds.
- ERC-721 withdrawals end to end: request → policy → `safeTransferFrom` calldata →
  `eth_sendTransaction`. Marketplace actions are approved by policy and then refused by the
  transaction builder, because `ActionRequest` does not model a signed Seaport order yet.
- Video generation in `scripts/generate-asset.ts` (`--video`), against xAI's async endpoint: the POST
  returns a `request_id`, the job is polled to `done`, and the finished video is downloaded rather
  than left as a temporary URL that will rot. Supports text-to-video and image-to-video
  (`--image-url`), with a ten-minute ceiling so it cannot hang a job.

### Changed
- The footer was five columns of equally muted links, which read as a wall of grey with nothing to
  draw the eye. Now the brand and one call to action carry the weight, with two supporting columns.

### Added
- Local read-only data service: cache-first OpenSea API v2 client, SQLite response cache with explicit
  freshness, keyring-backed credentials, loopback-only HTTP API.
- Autonomy and spend-control model — bounded authority, value tiers from $100 to $100k+, vendor versus
  onchain policy enforcement (`docs/autonomy.md`).
- Working agreement for agents and humans (`AGENTS.md`).
- Test suite on `node --test`, plus CI for typecheck and tests.
- Build diary and changelog published to anchor.ryanio.com.

### Known limitations
- Privy's policy engine cannot express Anchor's cumulative caps. Its spend-limit primitive tops out
  at a 72-hour rolling window, and does not observe `eth_sendTransaction` at all, so the rolling 24h
  and 7d caps in `docs/autonomy.md` are enforced only by the in-process mirror. The per-transaction
  cap, the contract and withdrawal allowlists, and the `setApprovalForAll` refusal are enforced by
  Privy and survive a compromised desktop; the rolling totals do not.

### Changed (design)
- Favicon, mask-icon and theme-color moved to the deep-water palette — they still carried the old
  orange after the redesign.
- The next-entry countdown reads in words ("19 hours, 32 minutes") rather than naming a clock time.
- Card hover no longer tints the title coral; coral is for prose links, and a card's hover is the
  lift and the brightened border.
- One diary entry rather than several: it has been one day of work.

### Changed (ci)
- Five CI jobs collapsed into one with named steps. Each job was paying about twelve seconds of
  runner boot and checkout for ten seconds of work, with the setup duplicated five ways.

- Redesigned around a deep-water palette: ocean cyan primary, coral as a sparing counterpoint, warm
  neutrals. Shared tokens now live in `theme/tokens.css` and are reused rather than redefined.
- Glass surfaces with a lit top edge, procedural caustics and grain, and a generated deep-water hero
  wash (46 KB) that fades out below the headline. Dark mode only — the image is deep water and there
  is no honest way to make it work under a light theme.
- Lucide icons and the GitHub mark, inlined. Diary entries cut from ~1150 words to ~500 each, with a
  larger lead paragraph, section rules and a pull quote.
- A next-entry countdown that says plainly when a day is skipped, and `llms.txt` for the site.

### Added (tooling)
- `scripts/check-contrast.ts` computes WCAG ratios from the design tokens and fails CI. All 20 text
  and accent pairs clear AA in both themes. A colour that looks good but is unreadable cannot land.

- Biome 2.5.12 as the single formatter and linter — never ESLint or Prettier. One config at the root
  governs every workspace; CI runs `biome ci .` and fails on any diagnostic.
- A daily build-diary job on the Hermes scheduler that skips the entry when the day produced nothing
  worth reading, rather than padding.

### Added (brand)
- An anchor mark that reads as an **A** — distinctive rather than a stock anchor glyph, and legible at
  16px. Stroke-based with `currentColor`, so one file themes everywhere. Favicon and solid-fill
  variants alongside it.
- `scripts/generate-asset.ts` — image assets from xAI's Grok Imagine, key in the OS keyring, zero
  dependencies (the endpoint is OpenAI-compatible). For illustration and OG cards only; the logo and
  icons stay hand-authored SVG.

### Added (executor)
- `Executor` interface splitting `request → simulate → decide → submit`, so holding one stage does not
  grant the next. `PolicyDecision` appears only in return types — "here is my own approval, please
  submit it" is not a sentence the API can express.
- Approvals are unforgeable two ways: an `ApprovedAction` carries a property keyed by a non-exported
  `unique symbol`, so constructing one elsewhere fails to compile; and because a cast defeats types,
  the brand is backed by a module-private `WeakSet` that `Signer.submit` checks. The witness has no
  runtime representation, so a spread, `structuredClone`, or JSON round-trip fails closed.
- Reference `PolicyEngine` enforcing per-transaction and rolling caps, contract/action/withdrawal
  allowlists, and one-way revoke. It signs nothing and submits nothing.
- `setApprovalForAll` is blocked three ways, including at the type level — it cannot be configured
  into `allowedActions` at all.
- Caps charge gross outflow (netting would enable wash-trade drains) and budget is reserved at
  approval rather than settlement (otherwise never settling means unlimited live approvals).

### Security
- The site generator escaped `<`, `>` and `&` but not quotes, so a link URL in a diary entry or
  changelog line could break out of the `href` attribute; `javascript:` URLs rendered as live links.
  Quotes are now escaped and only `http`, `https`, `mailto` and site-relative URLs survive — verified
  against a real HTML parser, not a regex.
- The data service now requires a loopback `Host` header. Binding to `127.0.0.1` stops the network
  reaching it but not a browser: a page whose DNS rebinds to `127.0.0.1` was same-origin and could
  read the wallet inventory.
- `cloudflare/wrangler-action` is pinned to a commit rather than the mutable `v3` tag, since it
  receives the deploy token. (The first attempt at this silently did nothing — the patch pattern
  did not match and no one checked. The claim was in this file before the change was in the repo.)

### Fixed
- A malformed request URL crashed the whole service. `new URL()` sat outside the handler's `try`, so
  `GET http://[ HTTP/1.1` became an unhandled rejection and exited the process — 22 bytes to take
  down the data service, with nothing to restart it.
- Wrapped list items were broken out of their list, and a header-less table separator crashed the
  build outright. Table rows without a trailing pipe lost their last cell, pipes inside code spans
  split cells, and markdown inside code spans was rendered rather than left literal.
- Cache staleness used second precision and no clock guard: a backwards clock (NTP, suspend/resume)
  reported stale entries as fresh for the length of the jump. Now millisecond-based, and a negative
  age is treated as stale.
- `/collections` returned 200 with per-slug error strings when the API key was missing, so a widget
  checking `res.ok` rendered "no collections" instead of prompting for a key. It now returns 401.
- `HEAD` was refused with 405, breaking `curl -I` and readiness probes. It is read-only and is now
  routed like `GET`.
- Config values were trusted verbatim: `"requestsPerSecond": "fast"` produced `NaN` and silently
  disabled rate limiting entirely. Config is now validated with actionable errors.
- The declared Node floor (`>=22.6.0`) could not run the code, which needs unflagged `node:sqlite`
  and TypeScript stripping. Corrected to `>=24`, and the PKGBUILD now declares `nodejs>=24`.
- `Cache` created the shared data directory even when given an explicit path, so every test touched
  the developer's real `~/.local/share/anchor`.
- The API key prompt echoed the secret to the terminal; shutdown could hang forever on a keep-alive
  connection, leaving the cache unclosed until SIGKILL.
- Cache staleness was off by one: a TTL of *N* kept an entry fresh for *N+1* seconds, and a TTL of 0
  never expired. Found by a test written against the intended semantics rather than the code.

[Unreleased]: https://github.com/ryanio/anchor/compare/main...HEAD
