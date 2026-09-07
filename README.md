# Anchor

**Make your wallet a part of your desktop, not another browser tab.**

Anchor is an ambient OpenSea experience for [Omarchy](https://omarchy.org) — a wallet-aware Linux
desktop. Your art becomes the theme. Your positions and watchlist live in the bar. Meaningful offers,
auction deadlines and price moves become notifications. An agent acts within limits it cannot change.

**Both halves of OpenSea.** NFTs *and* fungible tokens. They are not the same product with different
nouns — ownership, buying, time scale, risk and the right desktop surface all differ — so
[docs/tokens.md](docs/tokens.md) sets out what changes for each.

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
- Cache locally and make data freshness visible.
- Treat floor prices, mint eligibility, and social signals as hints, not facts.
- Every visual customization is easy to undo.

## Roadmap

1. **Local read-only data service** — wallet, selected collections, cached activity, polling limits, token storage.
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
| `docs/` | Security model, autonomy and spend controls, NFTs vs tokens, roadmap |
| `.node-version` | The Node version, for local `mise` and CI alike. Single source of truth |

## Installing

Not packaged yet. The goal is a single Arch package installable on Omarchy:

```bash
omarchy pkg install anchor
```

Omarchy ships its own pacman repository (`[omarchy]` → `pkgs.omarchy.org`), so the packaging target is
a standard `PKGBUILD`. See `packaging/`.

## Contributing

Early and opinionated, but genuinely open. Read `docs/security.md` before proposing anything that
touches keys, signing, or network exposure — those constraints are the point of the project, not
obstacles to route around.

## License

MIT — see [LICENSE](LICENSE).
