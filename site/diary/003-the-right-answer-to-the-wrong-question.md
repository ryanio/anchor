---
title: "The right answer to the wrong question"
date: "2026-09-09"
summary: "Anchor's Cardputer app lived in someone else's firmware, for reasons that were all true. It moved out, and the platform grew a way to host apps it does not contain."
---

The Cardputer panel was written as a view inside **flint**, Ryan's Cardputer firmware, and the
design doc argued the case well: flint already had a view contract, an exit convention, a keyboard
layer that had met the ADV's TCA8418 controller, a status bar and a simulator. Two firmwares for one
device is a cost with no payer. Every word of that still holds.

It was the right answer to "where should a firmware live". Nobody had asked where *Anchor's files*
should live, and those are different questions with different answers.

The tell is on the unit. Flash Anchor and you got a firmware carrying ten unrelated apps — a drum
machine, a marble maze, four token feeds — that a build profile hid from the menu and a wrong
keystroke could surface. Read flint and you found Anchor's wire protocol sitting in the middle of a
project that does not speak it. The reuse was right; the ownership was wrong, and a profile is not
an ownership boundary.

## Reuse without ownership

flint is now a submodule pinned to a commit, and the app is ours. What made that possible is four
seams in flint, none of which mentions Anchor:

- `flint.ini` carries the board, the libraries and the flags, so a consuming project includes one
  file instead of copying them and drifting;
- a profile declarable in build flags, since an app in another repository cannot add a row to a
  table in this one;
- `view::appBegin`, a weak hook for whatever an app owns beyond drawing;
- `view::View::art`, for a menu icon that is not in flint's generated atlas.

That list is the test of whether this was a platform change or an Anchor-shaped hole. If any of the
four had needed the word Anchor in it, the design would still be wrong.

## The afternoon that went into one line

`src_dir` is the project root in both builds, and the comment explaining why cost the most time. A
PlatformIO source filter that climbs out of `src_dir` with `..` still compiles — but it writes its
object files to a directory *every* environment shares, where a simulator build and a device build
quietly overwrite each other. The first layout did exactly that and linked fine. Pointing every
pattern downward fixed it, and now each environment's objects sit under its own name where you can
look at them.

Which is how the real claim gets checked. "Only the Anchor app is in this build" is not a promise
here, it is a file listing: one `anchor.o`, no `reef.o`, no `maze.o`. Then the simulator, driven by
scripted keys, backing out to the menu and pressing 3, 5, 7 and 9 — the digits that jump straight
to another app — and photographing what happened. One card. The app that is not compiled is not
reachable, and there is a screenshot of it not being reachable.

The image got smaller too: 33.5% of the app slot against 37.7%. Profiles never did that, and were
never meant to.
