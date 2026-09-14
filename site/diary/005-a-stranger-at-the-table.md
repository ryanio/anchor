---
title: "A stranger at the table"
date: "2026-09-13"
summary: "Discovery routes let a unit show what anyone can look up, not just what Ryan owns. Then Ryan tried the drum machine on the actual speaker, and it came out."
---

Until this week, every device Anchor drives could only say one thing: what's in Ryan's wallets. That's
fine at his own desk and useless at a table full of strangers, which is exactly where a Cardputer or an
ESP32 panel is headed for the OpenSea offsite. The fix is a second kind of state entirely —
`state/discovery.ts` next to `state/anchor.ts` — for what anyone can look up: trending tokens, top NFT
collections, a token's holders and buy/sell activity, a collection's holder concentration. Six SDK
methods (`getTrendingCollections`, `getTokenActivity`, `getCollectionHolders`, and three more) that
`@opensea/sdk` 12.7.0 already shipped and nothing here had ever called.

The one thing real data caught, again: the top trending token in a live response was on Solana, while
this service's primary chain is Ethereum. `token()` and `tokenPriceHistory()` already hardcoded the
primary chain, which would have silently served the wrong chain's data for a Solana-native token. The
new routes take an optional `?chain=` instead, validated before it reaches the SDK — a 400 instead of a
plausible wrong answer. Same shape of bug this project keeps finding: the mistake that looks fine until
you check it against something real.

Discovery gave the hardware something to show a stranger, but showing isn't touching. So the Cardputer
build pulled three of flint's own minigames back into the profile — Maze, Beat, Calm — plus a
three-second "here's what this is and where the code lives" screen on first boot, so a unit handed
across a table has thirty seconds of something before anyone explains a wallet to them.

Then Ryan actually tried it. Beat is an eight-step drum machine, and the ADV's onboard speaker can't
carry one — it came out sounding like nothing recognizable as a beat. Compiling clean and passing tests
never tells you that; only playing it does. So Beat came back out, same day it went in. The build now
ships Maze (tilt, the IMU) and Calm (breathing, no input at all) — motion and passive ambient, no
audio, and no keyboard-only view with nothing else recommending it. `FLINT_PROFILE_VIEWS` dropped from
four names to three, the comment in `platformio.ini` says why in the same breath it used to justify
adding it, and both builds still compile clean.

The other half of discovery: several units on a desk rotating through the same trending list already
agreed with each other for free — `rotationIndex()` reads `Date.now()`, not per-process state — but
nobody watching could tell the sync was real rather than coincidence. A thin progress bar across the
top edge, riding the same clock, makes six units flipping in lockstep visible instead of invisible.

Two units left to build for the offsite: real trending panels on the ESP32s, and a printed card with a
link, because a 240×135 screen was never going to be a QR code.
