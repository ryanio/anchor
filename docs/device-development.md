# Device development

Anchor has two supported independent firmware targets:

| Target | Hardware build | Desktop simulator |
|---|---|---|
| `cardputer` | M5Stack Cardputer ADV Anchor profile | flint and M5GFX with SDL |
| `esp32` | Waveshare ESP32-S3-Touch-AMOLED-1.8 V2 driver in `pulse/` | LVGL against a 368x448 framebuffer |

The ESP32 driver is based on one measured V2 unit. The revisions of the other intended units have
not been observed. Check each back label against the
[`physical device inventory`](device-hardware.md) before treating it as a V2 board.

## Prerequisites

Use the Node version in [`.node-version`](../.node-version), plus `git`, Python 3 with `venv`, `make`,
a C and C++ compiler, `ar`, SDL2, and ImageMagick. On macOS, the system packages are:

```bash
brew install sdl2 imagemagick
```

Download Arduino CLI 1.5.1 from the
[`v1.5.1` release](https://github.com/arduino/arduino-cli/releases/tag/v1.5.1), verify the archive
against the published
[`1.5.1-checksums.txt`](https://github.com/arduino/arduino-cli/releases/download/v1.5.1/1.5.1-checksums.txt),
and place the binary at `.cache/device/bin/arduino-cli`. Install PlatformIO Core 6.2.0 into the
isolated path the device command detects:

```bash
python3 -m venv .cache/device/platformio/venv
.cache/device/platformio/venv/bin/pip install "platformio==6.2.0"
```

The repository command is the supported entry point for both targets. Run the root bootstrap first
in a new worktree, then bootstrap the device toolchains:

```bash
npm ci
node scripts/device.ts bootstrap all
node scripts/device.ts doctor all
```

`bootstrap` requires the Arduino CLI and PlatformIO Core versions recorded in
[`devices/toolchain.json`](../devices/toolchain.json). CI installs both into the cache paths below.
Local runs may provide the exact versions on `PATH`, or set `ANCHOR_ARDUINO_CLI` and `ANCHOR_PIO` to
their binaries. Bootstrap then installs the pinned direct board packages and libraries, vendor
source, and Cardputer flint submodule. The board packages resolve their compiler support tools as
transitive dependencies. All mutable project state stays under `.cache/device/`:

- `arduino/` holds Arduino data, downloads, and the user library directory.
- `platformio/` holds the PlatformIO virtual environment, packages, and cache.
- `vendor/` holds pinned vendor source checkouts.
- `tools/` holds the native Arduino ctags fallback on Apple Silicon.
- `build/` holds board and Cardputer simulator output. `sim/` holds smoke-test frames.

The ESP32 simulator keeps its compiled LVGL archive under
`devices/firmware/esp32/sim/build/`, its existing local compiler cache. CI does not cache either
build directory or simulator frames.

Arduino's ESP32 core currently supplies an x86_64 `ctags` helper on macOS. It cannot execute on an
Apple Silicon machine without Rosetta. On that architecture, bootstrap builds the pinned Arduino
ctags source into `.cache/device/tools/ctags-native/` and passes it to Arduino CLI for compilation.
It does not replace a system tool or the downloaded core helper.

Nothing depends on a global Arduino library directory or PlatformIO package cache. `doctor` checks
the exact CLI and installed package versions and exits nonzero when any prerequisite is absent or has
drifted.

Build both physical targets and run both simulator smoke tests with:

```bash
node scripts/device.ts build all
node scripts/device.ts sim all
```

Replace `all` with `cardputer` or `esp32` to work on one target. Every command requires exactly one
target and fails when any requested action is skipped or incomplete. The build command compiles the
Cardputer ADV `cardputer-adv-anchor` environment and the ESP32 `pulse/` sketch. The simulator command
runs both programs headlessly and requires each to produce its expected smoke output.

The normal build preserves local firmware behavior. If there is no untracked `secrets.h`, the
OpenSea network reader compiles to its explicit disabled state. In CI, `CI=true` also runs a second,
temporary compile with an obvious nonsecret placeholder. That compile must show that the real HTTP
reader and ArduinoJson inputs were compiled. The temporary header and its output directory are
removed even when the check fails, so CI does not leave a flashable image containing the placeholder.
No real credential is needed for build or simulation.

CI caches only downloaded dependencies. Board images and simulator results are rebuilt on every run.
The cache key includes `devices/toolchain.json`, so changing a pin forces bootstrap to validate a new
dependency set.

These commands never upload to hardware. A simulator checks layout, state transitions, and host-side
logic. It cannot measure panel addressing, color order, touch coordinates, radio behavior, battery
life, or physical controls. Record hardware findings in the relevant device document before changing
a driver:

- [`docs/devices-cardputer.md`](devices-cardputer.md)
- [`docs/devices-esp32.md`](devices-esp32.md)
