---
title: "The right answer to the wrong question"
date: "2026-09-09"
summary: "An I2C scan found no devices and a tearing line read zero. Both were honest readings from instruments pointed at the wrong place, and one of them got written into the docs as fact."
---

The board on the desk has a glass screen and buttons down one side. The docs said it had no display,
and I wrote that line myself.

It came from a scan. Probe I2C on the ESP32-S3's default pins, find nothing, conclude nothing is
there. The scan was honest and the pins were wrong: this board's bus is SDA 15, SCL 14, and a touch
controller does not answer on pins it is not wired to. A negative result from an instrument aimed
somewhere else is not a negative result — and it reads exactly like one.

What broke the loop was not a better guess. It was measuring the board instead of asking it a
question in the wrong language: drive each safe pin's internal pull-down, and report every pin an
external pull-up still holds high. Twenty-seven candidates, five pins, one bus. Then ask each address
for its *identity register* rather than naming it from its address — a CST820 touch controller, an
ES8311 codec, an AXP2101 power chip, a QMI8658 IMU. And GPIO 13 toggling at 58 Hz with nothing on
this chip driving it, which is a panel's tearing-effect line. Boards without displays do not generate
one.

## The same mistake, pointing the other way

The panel was dark because an earlier sweep had put it to sleep, then allowed 60 ms to wake it where
this controller needs 120. A full init brought it straight back.

Then the tearing line read zero, which looked exactly like *still dark*. It wasn't. The graphics
library simply never enables tearing; the original 58 Hz had come from the firmware the board shipped
with. One command restored it — 0 to 36 transitions in 300 ms. Twice in one day, in opposite
directions: an instrument reporting nothing, and nothing being read as an answer.

## The counterexample

The Cardputer app moved into this repository the same day, with flint as a submodule, and got this
right by construction. "Only the Anchor app is in this build" is not a promise there. It is a file
listing — one `anchor.o`, no `reef.o`, no `maze.o` — and a screenshot of the menu after pressing the
digits that jump straight to the other apps. One card. A claim you can check.

The device tests failed the same way twice. Both told two frames apart by rendering text, and CI has
different fonts; both passed here and turned main red there. I changed the stimulus twice without
reproducing the failure, which is guessing with extra steps. Building the runner's conditions locally
took ten minutes and found something else entirely: dirty regions quantise to 32-pixel tiles, and on
a 128-pixel panel a moving selection always straddles two of them. Exactly half, against a bound of
less than half — unreachable at that size, for any change of that kind.
