---
title: "A face that is not AI"
date: "2026-09-23"
summary: "The ESP32 gets a companion screen — a face that reads the portfolio's mood — and two crashes on the way to shipping it off by default."
---

The ESP32 unit now has a second home screen: a glowing rounded face that blinks, breathes, and
looks happy or worried with the portfolio's day. Sleepy when offline or stale, curious while
fetching, lost with no Wi-Fi saved. A tap steps it through the portfolio total and the top trending
token, using only strings the feed already formatted. It ships off by default, behind
`PULSE_COMPANION_HOME=1`, because it's a prototype.

The interesting part is what it's built out of. This firmware doesn't compile in arcs, so every
curve on the face is a lie told with circles. A one-sided border on a circle looked like the answer
first — draw a ring, only stroke the top — and LVGL rendered it as a short, shallow dash instead of
an eyelid. The actual technique: a dark circle with a body-coloured circle laid a few pixels over
it, so the visible sliver is a crescent. Every eye, every mouth curve on this face is two circles,
not one arc.

The glow cost a segfault. The first version was a single 64px shadow behind the body — cheap to
say, expensive to allocate — and it failed its buffer allocation. LVGL wrote through the null
pointer it got back instead of checking it. The fix was to stop asking for one big soft shadow and
draw two translucent layers instead, which is what actually reads as a glow on the panel and never
asks LVGL for a 64px blur buffer in the first place.

The second crash was about who owns the memory, not the pixels. The obvious way to build a screen
of LVGL objects is once, at boot, and keep it around. Do that for the companion and the 32-network
Wi-Fi scan runs out of LVGL pool and crashes, because the character's objects sit in memory the
whole time the scan needs it. So the companion's objects now exist only while the screen is on
screen, built on tap-in, torn down on tap-out. That scan now peaks at 110,728 bytes with a
22,400-byte block still free — and taking the teardown back out makes it segfault again. There's no
version of this feature that's free: either it lives only when visible, or it costs the Wi-Fi scan
its headroom.

None of this is AI, and the commit says so directly — mood and wording are a fixed model checked on
the host, not a generated line. The strings are the feed's own formatted numbers; the face just
picks which one to say and how to look while saying it.

Four scenarios and a portfolio-down fixture cover the states. What's not covered yet is the same
gap the last two entries have had: none of this has been on the glass.
