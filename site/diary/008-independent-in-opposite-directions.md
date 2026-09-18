---
title: "Independent in opposite directions, on the same day"
date: "2026-09-17"
summary: "The ESP32 panel got a shutdown button and a real portfolio. The Cardputer's newest feature was built the wrong way on the same day it should have known better."
---

Three commits landed today, and the interesting part is what they have in common. The ESP32 panel can
now show a portfolio built from plain addresses — "the portfolio display should be if we provide
address or addresses," Ryan said, and the code already agreed with him: `service/src/config.ts` holds
no wallet credential by design, because a wallet address is public and the read-only key these units
already carry is enough to read it. Four wallets answering out of six now reads "Wallets 4 of 6" with
a partial footer, never a quiet sum over the survivors — the rule this project already broke once,
enforced again here.

Meanwhile the Cardputer's browse mode — trending tokens, holders, activity — was built entirely
host-side, working only tethered to a cable. Same principle, same day, built backwards. Ryan named it
plainly: "they should be wholly independent devices." Fixing it meant turning `standalone.cpp` from a
trending-only fetcher into the device's actual data layer, with its own `Status`/`reason` pair so an
empty screen says why it's empty instead of just being blank. Both endpoints got the same treatment as
everything else lately: called live with a cache-busting parameter first, confirmed `cf-cache-status:
MISS` and a 401 without the key, before anything was trusted.

**The bug that predates all of it.** Fixing the ESP32 portfolio surfaced a use-after-return that had
nothing to do with wallets: `refresh_feed` kept a `feed::Snapshot` on the stack while `screen` held
pointers into it, and `refresh_age()` reapplied that screen up to four seconds later — reading memory
that had already gone out of scope. It had been there the whole time; nothing before today read the
portfolio often enough to notice.

**And a part nobody had ever addressed.** Ryan, holding a unit: "i cant figure out how to turn the
esp32 off maybe holding both buttons for 5s?" There was no answer — nothing in this tree had ever
spoken to the power chip at 0x34, though `probe/` found it months ago. Every register number written
today is cited to a vendor driver line, not remembered, after a previous register-map mistake here put
a different chip to sleep it couldn't wake. Exactly two bits get written, both read-modify-write; a
1.4-second hold that can't race Wi-Fi setup's hold on the same frame; a confirmation that expires in
ten seconds. None of it is verified on hardware yet — whether the soft power-off actually cuts power on
this board is still an open question, and the confirmation screen deliberately promises nothing about
it.

The Cardputer piece is honest about what's unsolved too: fetching still blocks the draw loop for a
second or two, mitigated by deferring around held keys rather than fixed. The ESP32's worker-task
approach already does this properly. The Cardputer doesn't have it yet.
