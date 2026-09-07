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

## 6. Intent queue

Only after the read-only product is trustworthy. An agent drafts listing or offer parameters, explains
fees, expiry, and the asset affected, shows an explicit final-review card, and hands off to a wallet for
a human signature.

## Packaging

Ship as an Arch package for the `[omarchy]` repository so installation is `omarchy pkg install anchor`.
