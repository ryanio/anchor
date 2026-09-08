---
title: "The fixture that lied"
date: "2026-09-08"
summary: "A test server bound to the real service port and showed Ryan a portfolio total that was not his. The fix that followed is the interesting part."
---

A fixture server for testing the widget bound to `127.0.0.1:8787` — the same port the real
`anchor-service` uses. Ryan's actual bar was pointed at it, saw a plausible dollar figure,
and reasonably took it for his own portfolio. It wasn't. It was test data.

Nothing crashed, nothing errored, no log said anything was wrong. A number appeared where a
number is supposed to appear, and it looked exactly like every other number that widget has
ever drawn. That is what made it dangerous: the failure mode wasn't "obviously broken," it
was "indistinguishable from correct."

## Two rules, not one

The instinct is to say "don't reuse the real port" and move on. That's necessary but not
sufficient — a fixture will eventually collide with something real again, on some other
machine, in some other way. So two rules went in instead of one:

1. **A fixture binds an ephemeral port**, and the test widget is pointed at it explicitly.
   Nothing shared with the production path by default.
2. **Fixture data must be unmistakably fake if it ever renders anyway** — repeated-digit
   figures, `0x0000…0001` addresses, `SAMPLE` names. Not because rule 1 should fail, but
   because it will, someday, and the data itself should be the tell when the plumbing isn't.

The second rule produced a real product change: the widget's portfolio total now says where
it came from — which wallets, how old — in one line under the number. That line exists
because it was the thing missing when a stranger's fake total needed to be caught by eye
instead of by test.

## Cleanup, checked rather than assumed

Restoring the machine wasn't "kill the process and move on" either:

- fixture killed
- 8787 confirmed refusing connections — not assumed, tested
- the port override removed from `shell.json`
- the cached snapshot deleted from `~/.local/state/anchor/widget-cache.json`

That last one mattered more than it looks. The widget caches its last good reading so it can
show something during an outage. Without deleting it, the fake number would have kept
appearing on the bar *after* the fixture server was already gone — a ghost of a mistake that
had otherwise been fully fixed, surviving in exactly the place built to survive real outages.

## The same shape, twice

A related recovery-of-signal failure showed up building the review-screenshot tool the same
day: detecting a locked session with no lock process to check (Omarchy draws its own lock
from the shell, so there's no `hyprlock`, and `loginctl` reports `LockedHint=no` the whole
time). The first two attempts tested screen *brightness* — and a lock screen is bright, so
both let it through, and both wrote a password prompt to disk before anyone noticed. The fix
was to test *contrast* instead: a locked screen has `spread≈1.7` between max and mean
brightness, an unlocked one has `spread≈109`. Two orders of magnitude, not a coin flip.

Same lesson both times: when the direct signal isn't available, don't reach for the nearest
proxy that happens to move in roughly the right direction. Find the property that's actually
different.
