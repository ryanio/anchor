# Cardputer firmware

**The app is here. The platform is a submodule.**

Anchor drives an M5Stack Cardputer through **flint** (`ryanio/cardputer`), Ryan's Cardputer ADV
firmware: a view contract, an exit convention every screen obeys, a status bar, a keyboard layer
that has met the ADV's TCA8418 controller, and a simulator that runs the real view code against
M5GFX's SDL panel at the real 240x135. flint is vendored in [`flint/`](flint) and pinned to a
commit. Anchor's own half — the view, the host link, the simulator's replay of that link, and the
menu art — is [`app/`](app), and it is built *against* flint rather than added to it.

This is a change of mind, and the reasoning is in
[`docs/devices-cardputer.md`](../../../docs/devices-cardputer.md#where-firmware-lives). The short
version: someone installing Anchor should not find ten unrelated flint apps on the unit, and someone
reading flint should not find Anchor's wire protocol in it.

```
devices/firmware/cardputer/
├── platformio.ini      the two Anchor builds, and the guard below
├── app/src/anchor.cpp  the view: draws a rectangle a desktop sent, sends key names back
├── app/src/cable.*     the host link on a unit: newline delimited JSON over USB C
├── app/src/art.h       generated, the menu icon flint's atlas no longer carries
├── app/sim/cable_sim.cpp   the same link in the simulator, replaying a real capture
├── tools/require-flint.py  says "submodule" when the submodule is not there
└── flint/              the submodule: menu, ui, keyboard, store, simulator
```

## First: the submodule

```bash
git submodule update --init devices/firmware/cardputer/flint
```

Skip it and `pio run` stops in a fifth of a second with a paragraph telling you to run exactly
that. It does not fail thirty lines into somebody else's header, and it does not fail with
PlatformIO's own `No section: 'flint_adv'`, which is what you get without the guard — the two
sections `flint/flint.ini` defines are stubbed in `platformio.ini` purely so the build survives
long enough for `tools/require-flint.py` to say the word *submodule*.

The pin is a commit, not a branch, so a fresh clone builds the flint that this app was checked
against. `git submodule update --remote` moves it forward deliberately; nothing moves it by
accident.

> **While `feat/app-packs` is unpushed**, the pinned commit exists only in a local flint checkout,
> and `--init` against GitHub will not find it. Push that branch in `ryanio/cardputer` first, or
> point the submodule at a local clone with
> `git config submodule.devices/firmware/cardputer/flint.url /path/to/cardputer`.

## Building and flashing

Run these from `devices/firmware/cardputer/`, not from a flint checkout — this directory is the
PlatformIO project now.

```bash
pio run -e cardputer-adv-anchor              # compile the Anchor panel alone
pio run -e cardputer-adv-anchor -t upload    # flash it over USB C
pio device monitor                           # what the unit says

pio run -e sim-anchor -t exec                # the same thing on the desktop, no hardware
```

`pio run -t upload` finds the port itself. If it does not, the unit is at `/dev/ttyACM*` and holding
G0 while plugging in forces download mode. USB CDC on boot is already set; without it the serial
port disappears, which reads as a dead device.

**Only the Anchor app is in an Anchor build**, and that is a build fact rather than a menu setting.
`platformio.ini` drops `flint/src/views/` from the source filter, so flint's own apps are not
compiled, not linked, and not reachable by any key. The `FLINT_PROFILE_VIEWS='"Anchor"'` flag says
the same thing a second time at the registry. Measured on the ADV target: 18.0% RAM and 33.5% of the
app slot, against flint's full firmware at 20.5% and 37.7%.

`FLINT_PROFILE_NETWORK=0` means the spine joins no network and runs no boot probe. Anchor's data
comes down the cable from a desktop, because the service behind it binds `127.0.0.1`; a radio
nothing uses would be attack surface with no upside.

## Looking at it without hardware

The simulator is flint's, running this app's view against M5GFX's own panel driver at the real
geometry, with the host link replaying a capture instead of reading a port.

```bash
pio run -e sim-anchor -t exec        # a window you can type into

# or as a test harness: a PPM before each scripted key
.pio/build/sim-anchor/program --keys "azuki" --shot /tmp/anchor --quit-after 6000
magick /tmp/anchor-03.ppm -scale 300% /tmp/anchor-03.png
```

The first shot fires at 700ms and one every 420ms after, and the replayed host sends its first frame
at about 600ms — so `--shot` with no `--keys` photographs the waiting screen and nothing else.

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

## Regenerating what is generated

Two files in `app/` come out of flint's own tools and are never hand edited.

```bash
# the menu icon. flint's atlas has no Anchor id, so the app carries the bitmap
cd flint && python3 tools/icons/generate.py \
    --pack anchor:ANCHOR:32 --namespace anchorart --out ../app/src/art.h

# the simulator's capture: real bytes off this adapter, not a hand typed approximation
node scripts/cardputer-session.ts --page anchor --filter azuki
```

The capture goes into the `SESSION` literal in `app/sim/cable_sim.cpp`. Taking it under a different
Omarchy theme gives a different, equally valid capture; the one in the tree was taken with the data
service stopped, which is worth seeing on its own — every reading is a dash rather than a zero,
because a zero is a reading and there is nothing to read.

C++ here follows flint's `.clang-format`, symlinked as `app/.clang-format`, and flint pins
clang-format 21.1.2 in CI. Newer releases disagree about the aligned string tables in
`app/src/anchor.cpp`; format with the pinned version or not at all.

`flint/` is excluded in `biome.json`. It is somebody else's repository with its own gates, and its
`site/` carries an emscripten bundle that Anchor's lint rules report 594 errors in, none of them
ours to fix. That exclusion is the only line the submodule adds to the root config.

## What is not verified

**No Cardputer has run this.** The view compiles for the ADV target and is checked in the simulator,
which is the real `view`, `ui` and `store` code against M5GFX's own panel driver at the real
geometry — so the layout, the truncation, the palette and the key mapping are seen rather than
reasoned about. What the simulator cannot tell you is whether the TCA8418 keyboard reports what this
expects, whether USB CDC keeps up with a repaint, or what the panel looks like in a room. Those wait
for hardware.

| Half | Where |
|---|---|
| The wire protocol | [`docs/devices-cardputer.md`](../../../docs/devices-cardputer.md) |
| The host end | [`devices/src/adapters/cardputer.ts`](../../src/adapters/cardputer.ts) |
| A capture for the simulator | [`scripts/cardputer-session.ts`](../../../scripts/cardputer-session.ts) |
| The device end | `app/` in this directory |
| The platform | `flint/`, and its `docs/APPS.md` |
