---
title: "A part that was never switched on"
date: "2026-09-14"
summary: "The touch panel on the ESP32 answered every register read and never saw a finger. It wasn't broken — it had never been taken out of reset, and finding that cost a sleeping chip and a blacked-out screen."
---

The ESP32 panel has had a touch controller since the board was bought. Nothing here had ever read it.
Today it went from silent to working, and the distance was three wrong turns, each plausible enough
to commit to before it was measured.

First: the CST820 answered its identity registers perfectly, then sixteen data registers sat frozen
at the same bytes through minutes of being touched. Reading the vendor's `SLEEP_MODE` / `DEVICE_ON`
enum backwards, an early attempt wrote `0xE5` meaning "turn the device on." The device being switched
was the sleep mode. That put the part to sleep — their own driver notes sleep can be entered and not
left — and cost a power cycle to get the board talking again.

The real answer was somewhere nothing had looked: the CST820's reset line isn't a GPIO. It hangs off a
TCA9554 IO expander at 0x20, bit 2, a part this firmware had no other reason to talk to, and nothing
had ever released it from whatever state power-on left it in — alive on the bus, never scanning the
panel. The fix is waveshareteam's own bring-up sequence, copied whole: four lines low, wait 20ms, all
high, wait 150ms, their delays kept — shortening someone else's reset timing to save 170ms once per
boot is how an intermittent fault gets bought back.

Second: their sequence drives touch reset, the LCD's reset, and a power enable low together, correct
in bring-up before a display exists. Calling it after the panel controller was already initialized
reset the display mid-session and blacked out a screen that had been painting a minute earlier. The
fix was narrower: pulse only bit 2, hold the other three high throughout.

With the reset right, the dump went from a frozen coordinate to a clean idle — progress, still zero
touches. The last gap was a bus configuration inherited from the banner's `scan_i2c()`, left at
100kHz. A diagnostic sketch running its own bus at 400kHz with a longer timeout read coordinates; the
same registers under the borrowed bus read nothing. `begin()` now sets the bus up itself — three
changes at once, and which one mattered isn't established.

The other half of the day was what touch is *for*. Once taps land, a page of keys got an actual grid
instead of one-row-tall list items, three columns sized off a measured 322 ppi so each cell is close
to 9mm of finger. That surfaced the last surprise: the panel's corners are physically rounded, and an
edge-to-edge layout put tile corners under the bezel's curve — invisible in a rendered SVG, which is a
perfect rectangle, and reportable only by someone holding the unit. The grid now insets 4.5% of the
short side, and tests were rewritten to derive tap coordinates from the same geometry the renderer
uses, instead of pixel numbers the layout was free to invalidate unnoticed.

None of the three fixes would show up in a passing test suite. A register that reads back correctly
means nothing until a finger checks it.
