# Cardputer firmware

**The app is here. The platform is a submodule.**

Anchor runs on the M5Stack Cardputer ADV through **flint** (`ryanio/cardputer`), Ryan's Cardputer
firmware. The unit can fetch and render public OpenSea discovery data on its own. The USB link is a
compatibility path and is not required away from a desktop. flint supplies the view contract, status
bar, keyboard layer, network setup, and a simulator at the real 240x135 geometry. It is vendored in
[`flint/`](flint) and pinned to a commit. Anchor's view, on-device data reader, optional host link,
simulator fixtures, and menu art live in [`app/`](app).

This is a change of mind, and the reasoning is in
[`docs/devices-cardputer.md`](../../../docs/devices-cardputer.md#where-firmware-lives). The short
version: someone installing Anchor should not find ten unrelated flint apps on the unit, and someone
reading flint should not find Anchor's wire protocol in it.

```
devices/firmware/cardputer/
├── platformio.ini      the two Anchor builds, and the guard below
├── app/src/anchor.cpp  the view and its local navigation
├── app/src/standalone.*  the on-device OpenSea reader
├── app/src/cable.*     the optional host link over USB C
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

## Building and simulating

Use the repository-level device command from the repository root. It installs the pinned PlatformIO
packages and flint submodule under the repository, then builds the Cardputer ADV target.

```bash
node scripts/device.ts bootstrap cardputer
node scripts/device.ts doctor cardputer
node scripts/device.ts build cardputer
node scripts/device.ts sim cardputer
```

These commands compile and simulate. They do not flash hardware. See
[`docs/device-development.md`](../../../docs/device-development.md) for the shared workflow and cache
locations.

The Anchor profile includes Anchor, Maze, Calm, and the network Setup view. Anchor reads public
OpenSea data directly when a read-only API key is present in the local secrets header. Without one,
the reader compiles to an explicit disabled state. Secrets remain local and are never passed on the
command line or committed.

## Looking at it without hardware

The simulator is flint's. It runs Anchor's real view against M5GFX's SDL panel driver at the real
geometry. Captured fixtures stand in for network and optional host input, so it needs no hardware or
credential.

```bash
node scripts/device.ts sim cardputer
```

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

CI compiles the ADV target and checks the real `view`, `ui`, and `store` code in the simulator. The
simulator cannot measure the physical keyboard, USB throughput, radio behavior, battery life, or the
panel's appearance in a room. Those require a Cardputer ADV.

| Half | Where |
|---|---|
| The wire protocol | [`docs/devices-cardputer.md`](../../../docs/devices-cardputer.md) |
| The host end | [`devices/src/adapters/cardputer.ts`](../../src/adapters/cardputer.ts) |
| A capture for the simulator | [`scripts/cardputer-session.ts`](../../../scripts/cardputer-session.ts) |
| The device end | `app/` in this directory |
| The platform | `flint/`, and its `docs/APPS.md` |
