# Roadmap

Order matters. Each step exists to make the next one safe or possible.

## 1. Local read-only data service

The foundation. One wallet, a few selected collections, cached activity, explicit polling limits, and
token storage in the OS keyring. Everything else in Anchor reads from here rather than calling the API
directly — one cache, one rate limit, one place where freshness is tracked.

## 2. Quickshell widget

A compact top-bar widget: portfolio pulse, incoming offers, auction countdowns, activity count. Clicking
an item opens its page or a native detail panel.

## 3. Gallery and theme integration

Owned works rotate as wallpaper or a desktop gallery, with an optional palette extracted into the
current Omarchy theme. Must be reversible in one action.

## 4. Notification policy

Calm by default: sales, offers, transfers, watched auction deadlines. Snooze, mute, per-collection
filters. The failure mode to avoid is a desktop that cries wolf.

## 5. Agent research briefs

Read-only summaries over the same local data service: overnight activity, a collection's recent sales
and offers, listings matching filters. Always cited, always timestamped, never financial actions.

## 6. Policy-bound execution

The agent starts acting. An `Executor` interface abstracts *where policy is enforced* — a vendor policy
engine (Privy, Turnkey) to start, an onchain module (Safe allowance, ERC-4337 session keys) as the
trust-minimised destination — so the backend is a config choice, not an architectural one.

Balances grow through the tiers in [autonomy.md](autonomy.md): ~$100, then $1k, $10k, $100k+, each
promotion earned by a clean incident record. The agent proposes; policy it cannot change decides.

## Packaging

Ship as an Arch package for the `[omarchy]` repository so installation is `omarchy pkg install anchor`.
