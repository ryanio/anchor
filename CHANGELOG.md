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

### Fixed
- Cache staleness was off by one: a TTL of *N* kept an entry fresh for *N+1* seconds, and a TTL of 0
  never expired. Found by a test written against the intended semantics rather than the code.

[Unreleased]: https://github.com/ryanio/anchor/compare/main...HEAD
