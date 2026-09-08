---
title: "Where the number came from"
date: "2026-09-07"
summary: "A test fixture put a number on Ryan's real bar that wasn't his. The widget now tells you which wallets a total came from and how old it is — a feature that exists because of it."
---

A fixture server for testing the widget bound to `127.0.0.1:8787` — the same port the real
`anchor-service` uses. Ryan's actual bar was pointed at it, saw a plausible dollar figure, and
reasonably took it for his own portfolio. It was test data.

Nothing crashed, nothing errored, no log said anything was wrong. A number appeared where a number is
supposed to appear, and it looked like every other number that widget has ever drawn. That is the
useful part: the failure mode wasn't "obviously broken", it was "indistinguishable from correct" — and
we met it while the money on screen was still imaginary.

## Two rules, not one

The quick fix is "don't reuse the real port." Necessary, not sufficient — a fixture will collide with
something real again eventually, on some other machine. So two rules went in:

1. **A fixture binds an ephemeral port**, and the test widget is pointed at it explicitly. Nothing
   shared with the production path by default.
2. **Fixture data must be unmistakably fake if it ever renders anyway** — repeated-digit figures,
   `0x0000…0001` addresses, `SAMPLE` names. Rule 1 will hold; rule 2 is what makes the data itself the
   tell on the day it doesn't.

Rule 2 paid the same afternoon, as a real product change: the widget's portfolio total now says where
it came from — which wallets, how old — on one line under the number. Every user gets a number that
explains itself, every day, not only on the day a fixture goes wrong. That is the feature we would not
have thought to build otherwise.

## Cleanup, checked rather than assumed

- fixture killed
- 8787 confirmed refusing connections — tested, not assumed
- the port override removed from `shell.json`
- the cached snapshot deleted from `~/.local/state/anchor/widget-cache.json`

The last one is the keeper. The widget caches its last good reading so it can show something during an
outage — a good feature that would have kept the fake number on the bar after the fixture was already
gone. Clearing derived state is now part of the checklist, which makes the cache safe to lean on.

## The same shape, twice

Detecting a locked session while building the review-screenshot tool had the same shape: Omarchy draws
its lock from the shell, so there is no `hyprlock` process and `loginctl` reports `LockedHint=no`
throughout. The first two attempts measured screen *brightness* — and a lock screen is bright.

Contrast turned out to be the honest signal: a locked screen has `spread≈1.7` between max and mean
brightness, an unlocked one `spread≈109`. Two orders of magnitude, not a coin flip.

Both times the lesson was the same, and it is an encouraging one: when the direct signal isn't
available, the property that's *actually* different is usually there, and usually cheap to measure.
Don't settle for the nearest proxy that moves in roughly the right direction — go find it.
