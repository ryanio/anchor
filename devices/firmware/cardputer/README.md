# Cardputer firmware

**The firmware is not in this repository, and that is the decision rather than an omission.**

Anchor drives an M5Stack Cardputer through **flint** (`ryanio/cardputer`), the Cardputer ADV
firmware Ryan already ships: eleven apps, a view contract, an exit convention every screen obeys,
a status bar, and a simulator that runs the real view code against M5GFX's SDL panel at the real
240x135. Anchor is an *app* in it — `src/views/anchor.cpp` — not a second firmware.

The alternative was a standalone sketch here, and it was written and compiled before flint surfaced.
Two firmwares for one device is a cost with no payer: the second one has no menu, no simulator, no
keyboard handling that has met the ADV's TCA8418 controller, and would need every one of those
rebuilt to reach where flint already is. What lives here instead is the half Anchor genuinely owns —
the protocol, the adapter that speaks it, and the capture tool that feeds flint's simulator.

| Half | Where |
|---|---|
| The wire protocol | [`docs/devices-cardputer.md`](../../../docs/devices-cardputer.md) |
| The host end | [`devices/src/adapters/cardputer.ts`](../../src/adapters/cardputer.ts) |
| A capture for the firmware's simulator | [`scripts/cardputer-session.ts`](../../../scripts/cardputer-session.ts) |
| The device end | `src/views/anchor.cpp` and `src/link.*` in `ryanio/cardputer` |

## Building and flashing

In a flint checkout. The Anchor profile ships that one app and brings no radio up at all; the
default build has every view including this one.

```bash
pio run -e cardputer-adv-anchor              # compile the Anchor panel alone
pio run -e cardputer-adv-anchor -t upload    # flash it over USB C
pio device monitor                           # what the unit says

pio run -e sim-anchor -t exec                # the same thing on the desktop, no hardware
```

`pio run -t upload` finds the port itself. If it does not, the unit is at `/dev/ttyACM*` and holding
G0 while plugging in forces download mode. USB CDC on boot is already set in `platformio.ini`;
without it the serial port disappears, which reads as a dead device.

## Driving it from here

```bash
node devices/src/cli.ts --cardputer                 # find one, and make it prove what it is
node devices/src/cli.ts --cardputer /dev/ttyACM0    # or name the port
node devices/src/cli.ts --list                      # what is attached
```

`--cardputer` with no path waits for the device's `hello` before it paints anything. Every ESP32-S3
with native USB enumerates through the same Espressif JTAG/serial descriptor whatever is running on
it, so a matching port name identifies a chip family and not a device — the board on this desk that
looked exactly like a Cardputer turned out to be an unrelated N16R8 devkit.

## Refreshing the simulator's capture

flint's simulator replays real bytes from this adapter rather than a hand-typed approximation:

```bash
node scripts/cardputer-session.ts --page anchor --filter azuki
```

Paste the result into the `SESSION` literal in `sim/src/link_sim.cpp` in the flint checkout. Taking
it under a different Omarchy theme gives a different, equally valid capture.

## What is not verified

**No Cardputer has run this.** The view compiles for the ADV target and is checked in the simulator,
which is the real `view`, `ui` and `store` code against M5GFX's own panel driver at the real
geometry — so the layout, the truncation, the palette and the key mapping are seen rather than
reasoned about. What the simulator cannot tell you is whether the TCA8418 keyboard reports what this
expects, whether USB CDC keeps up with a repaint, or what the panel looks like in a room. Those wait
for hardware.
