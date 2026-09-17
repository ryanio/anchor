---
title: "A blitter retired for somebody else's code"
date: "2026-09-16"
summary: "The ESP32 panel had its own hand-written protocol for pixels a host had to send. Today it got a second firmware that renders itself, and three bugs that only exist on real glass."
---

The ESP32 panel's original firmware is a blitter: the desktop renders, the device streams pixels over
serial. That meets "works when nobody is at a desk" never — these units get carried around, and an
unplugged blitter shows nothing. `pulse/` is the same panel driven by LVGL instead, so it boots, asks
for a network on its own glass, joins, saves to NVS, and fetches trending tokens with no host in the
loop. `app/` still builds; the blitter is one flash away until `pulse/` proves itself on hardware.

None of the three bugs that came out of it would show up in a passing test. The touch controller drops
contact mid-press — `sensors.cpp` found this months ago and settles it with a 40ms delay, but
`pulse_touch.cpp` was written fresh for LVGL and didn't inherit that, so LVGL saw press and release
several times a second and no popover survived long enough to draw. The panel's driver wants its column
window on an even boundary; an odd one shifts each row a pixel further across than the last, which
down a line of text reads exactly as italics — only some labels slant, because whether a box lands on
an odd column is luck. And LVGL renders straight into its draw buffer instead of the blitter's streamed
framebuffer, so PSRAM's latency gets paid on every glyph; moved to internal SRAM, which the buffer's
own comment had already guessed would fix it.

The simulator that made all three findable didn't exist yesterday either. `sim/` compiles the actual
`.ino` and `.cpp` files unmodified against shims for Arduino, the display library, WiFi and NVS,
renders into a real framebuffer, and describes every frame in words — each label, its box, whether it
escaped its parent — because reading what the screen says is cheaper than reading pixels. It found
seven bugs in `wifi_setup.cpp` on the first run, including a join whose result was never drawn: the
unit joined, saved, and sat on "connecting" forever.

Then Ryan looked at the actual device: "the not set up screen is weirdly to the right with a lot of
blank space." He was right — every empty state had been laid out as a portfolio reading with one row
filled in, so the status word sat in the value column at x=123 with three blank pairs under it and
250px of dead panel below. Fixing it meant writing down what a status screen actually is, rather than
copying a reading's layout and deleting most of it. `pulse_design.{h,cpp}` is that: colour by role, a
spacing scale whose largest step is the panel's corner clearance, four named archetypes. Unifying the
two copies of the colour palette drifted apart between `pulse_ui.cpp` and `pulse_wifi.cpp` changed no
pixel — provable now, for the first time.

A unit with nothing saved had no way back into setup short of a 1.4-second hold nothing on screen
mentioned, on a touch controller that until yesterday couldn't reliably hold that long. Fixed today
too: with no network saved, the whole panel is the button.
