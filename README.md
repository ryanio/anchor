# Anchor

**Make your wallet a part of your desktop, not another browser tab.**

Anchor is an ambient OpenSea experience for [Omarchy](https://omarchy.org) — a wallet-aware Linux
desktop. Your art becomes the theme. Your positions and watchlist live in the bar. Meaningful offers,
auction deadlines and price moves become notifications. An agent acts within limits it cannot change.

**Both halves of OpenSea.** NFTs *and* fungible tokens. They are not the same product with different
nouns — ownership, buying, time scale, risk and the right desktop surface all differ — so
[docs/tokens.md](docs/tokens.md) sets out what changes for each.

**Every chain, not just Ethereum.** Chains are configuration, not an assumption: `chains` is a list
validated against OpenSea's own chain union, Solana included, and a Solana-only setup is as ordinary
as an EVM one. [docs/chains.md](docs/chains.md) covers what that costs — almost nothing on the data
side, rather more once something signs.

> **Status: early.** This is a scaffold and a plan, not a working product yet. The roadmap below is
> the honest order of work. Issues and ideas welcome.

> **Not an official OpenSea product.** Anchor is a personal open-source project by
> [@ryanio](https://github.com/ryanio). It is not affiliated with, endorsed by, or supported by
> OpenSea, and it uses only public APIs.

## Why

Crypto has spent a decade living in browser tabs. A wallet is not a website login — it is identity,
taste, history, inventory, community, and intent. That deserves a better home than thirty pinned tabs,
and it should feel excellent on accessible hardware you actually own, not a $3,000 "web3 computer."

## What it is

**OpenSea Ambient** — one coherent thing, rather than a pile of widgets:

- A compact **Quickshell top-bar widget**: portfolio pulse, incoming offers, auction countdowns, activity count.
- **Gallery and theme integration**: owned works rotate as wallpaper, with an optional palette extracted into the current Omarchy theme.
- **Calm notifications**: sales, offers, transfers, watched auction deadlines, meaningful price moves.
  Low-volume by default, per-collection controls, and thresholds relative to each asset's own
  volatility — a 5% day for a collection and a 5% minute for a token are not the same event.
- **Agent research briefs**: read-only summaries over local data, always cited and timestamped.

And then the part that makes it more than a dashboard: **an agent that acts on your behalf**, holding a
real balance under spend controls it cannot widen — starting around $100 and growing as the policy model
earns it. See [docs/autonomy.md](docs/autonomy.md).

## Principles

These are not negotiable, and they shape the architecture:

- Private keys and seed phrases never touch agents, device firmware, or logs.
- The agent **acts within policy it cannot change**. Limits are enforced at signing time, outside the
  agent — so a compromised desktop inherits the spend budget, not the balance.
- Withdrawals go only to pre-registered addresses; changing that list is a human action with a time-lock.
- Token approvals are a separate, human-only action class. They are never delegated.
- Least-privilege scoped tokens only, stored in the OS keyring — never in a theme file or a prompt.
- Use OpenSea's own packages rather than hand-rolled copies of its API. The platform moves; a
  hand-written client rots and lies about it.
- Cache locally and make data freshness visible.
- Treat floor prices, mint eligibility, and social signals as hints, not facts.
- Every visual customization is easy to undo.

## Roadmap

1. **Local read-only data service** — wallet, selected collections, watched tokens, cached activity, polling limits, token storage. Built on `@opensea/sdk` and `@opensea/api-types`.
2. **Quickshell widget** — one wallet, one portfolio summary, a selected collection list.
3. **Gallery / theme integration** — display art, apply a reversible palette.
4. **Notification policy** — defaults that avoid spam, with per-collection controls.
5. **Agent briefs** — read-only summaries over the same local data service.
6. **Policy-bound execution** — an `Executor` interface over a policy engine (Privy, Turnkey) or an onchain module (Safe, session keys), with the value ladder in [docs/autonomy.md](docs/autonomy.md).

## Layout

| Path | What |
|---|---|
| `service/` | Local read-only data service. Everything else reads from here |
| `widget/` | Quickshell top-bar widget |
| `theme/` | Gallery wallpaper and palette extraction |
| `packaging/` | Arch packaging, targeting the `[omarchy]` repo |
| `docs/` | Security model, autonomy and spend controls, NFTs vs tokens, chains, upstream workarounds, roadmap |
| `.node-version` | The Node version, for local `mise` and CI alike. Single source of truth |

## Installing

Not packaged yet. The goal is a single Arch package installable on Omarchy:

```bash
omarchy pkg install anchor
```

Omarchy ships its own pacman repository (`[omarchy]` → `pkgs.omarchy.org`), so the packaging target is
a standard `PKGBUILD`. See `packaging/`.

### Starting it

One command, and it survives reboots:

```bash
anchor-service --install-service
```

It installs the systemd **user** unit — a user unit, never a system one, because the service reads
one person's keyring and one person's config and has no business running before anybody has logged
in — then enables it. Packaged installs already have the unit and it is enabled in place.

## Configuring

**Nothing you configure lives in this checkout.** Every file below is written outside the repository,
on first run where it makes sense, so setting Anchor up never produces a diff and updating never
overwrites your setup.

| What | Where | Written by |
|---|---|---|
| Wallets, chains, watched collections, TTLs, port | `~/.config/anchor/config.json` | the service, on first run |
| Credentials | your OS keyring, via `--set-api-key` / `--set-pat` | never a file |
| Bar widget — which figures show, refresh interval | `~/.config/omarchy/shell.json` | Omarchy, or the panel's own controls |
| Stream Deck / device panels | `~/.config/anchor/devices.json` | you, falling back to the packaged default |
| Cache and last-known reading | `$XDG_DATA_HOME/anchor`, `$XDG_STATE_HOME/anchor` | the service and the widget |

The one file in the repository that looks like configuration is
[`devices/config/panel.json`](devices/config/panel.json), and it is the *packaged default* — copy it
to `~/.config/anchor/devices.json` and edit that instead. Anchor reads yours first and only falls
back to the packaged one.

A wallet is not typed in most setups: a wallet PAT's token carries the addresses it is linked to, and
the service resolves every one of them. `wallets` in the config file is for overriding that, not for
getting started.

**No secret is ever written to a file by Anchor**, including a config file, a log, or a cache. If you
find one, that is a bug worth reporting rather than working around.

## Contributing

Early and opinionated, but genuinely open. Read `docs/security.md` before proposing anything that
touches keys, signing, or network exposure — those constraints are the point of the project, not
obstacles to route around.

## License

MIT — see [LICENSE](LICENSE).
