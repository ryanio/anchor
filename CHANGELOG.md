# Changelog

All notable changes to Anchor are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The build diary at [anchor.ryanio.com](https://anchor.ryanio.com) has the story behind these; this file
has the facts.

## [Unreleased]

### Added
- Local read-only data service: cache-first OpenSea API v2 client, SQLite response cache with explicit
  freshness, keyring-backed credentials, loopback-only HTTP API.
- Autonomy and spend-control model — bounded authority, value tiers from $100 to $100k+, vendor versus
  onchain policy enforcement (`docs/autonomy.md`).
- Working agreement for agents and humans (`AGENTS.md`).
- Test suite on `node --test`, plus CI for typecheck and tests.
- Build diary and changelog published to anchor.ryanio.com.

### Security
- The site generator escaped `<`, `>` and `&` but not quotes, so a link URL in a diary entry or
  changelog line could break out of the `href` attribute; `javascript:` URLs rendered as live links.
  Quotes are now escaped and only `http`, `https`, `mailto` and site-relative URLs survive — verified
  against a real HTML parser, not a regex.
- The data service now requires a loopback `Host` header. Binding to `127.0.0.1` stops the network
  reaching it but not a browser: a page whose DNS rebinds to `127.0.0.1` was same-origin and could
  read the wallet inventory.
- `cloudflare/wrangler-action` is pinned to a commit rather than the mutable `v3` tag, since it
  receives the deploy token.

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
