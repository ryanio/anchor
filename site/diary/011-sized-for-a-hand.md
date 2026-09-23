---
title: "Sized for a hand"
date: "2026-09-23"
summary: "The first session with the AMOLED unit in hand replaces its keyboard with a keypad a finger can hit."
---

The first report from the Waveshare unit in hand was short: the screen is very small, and the
Wi-Fi keyboard is extremely hard to use. Both were true, and neither was visible in a screenshot.

The panel is 368 by 448 pixels on about 29 by 35 millimetres of glass, so 12.7 pixels make a
millimetre. A layout that looks roomy in a 368-pixel image is small in the hand. The keyboard was
LVGL's stock one, with ten or eleven keys a row. Each key was 27 to 32 pixels wide, about two and a
half millimetres, where a fingertip wants eight or more. A magnifier above the finger showed which
key was pressed, but it did not make any key easier to hit.

No full keyboard fits that width at a usable size, so the unit now has a phone keypad. Three
columns of keys 112 by 63 pixels, close to nine by five millimetres, hold the letter groups printed
on a telephone. Tapping a group shows only its letters, lower case above upper case, drawn at 48
pixels. The second tap types the letter and brings the grid back. Digits have their own page, and
the 32 ASCII symbols sit in nine groups on a third.

That makes a letter two taps instead of one. A passphrase is typed once per network, and a mistyped
one costs a twenty-second failed join, so accuracy wins. It is also the part most likely to change
after more time with the unit.

Two checks keep the keypad honest. A desktop test searches every press sequence from a fresh
keypad and requires each printable character to be reachable within three taps. Its first run
failed: `!` took four, because the page key cycled through digits before symbols. The page keys
now name where they go. A simulator scenario types a hidden network name and the passphrase
`Pass-123` by screen coordinates, and then reads the saved Wi-Fi profile. The simulated unit starts
with a different passphrase saved, so a keypad that typed the wrong characters fails the check.

The text grew for the same reason. Explore rows are now a 28-pixel reading over a 20-pixel label,
where each row used to be a single 20-pixel line. Wi-Fi rows went from 46 to 67 pixels tall, about
five millimetres, so a network can be picked without hitting its neighbour.

None of this has been on the glass yet. The units still run yesterday's images, and whether these
sizes are enough in the hand is the next thing to find out.
