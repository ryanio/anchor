# `pulse/`: the LVGL firmware

This is the independent firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2). It draws its own
screen, joins Wi-Fi on the device, and reads public portfolio and discovery data for configured
addresses without a desktop process.

The driver is based on one measured V2 unit. Other intended units still need their back-label
revision checked against [`docs/device-hardware.md`](../../../../docs/device-hardware.md) before
flashing.

`../app/` is the older host-fed blitter. It remains for historical hardware work, but new development
and CI target `pulse/`.

## The design system

`pulse_design.{h,cpp}` holds the palette, the spacing scale, the type scale and the four shapes of
screen this firmware has. Nothing else in `pulse/` names a colour or a pixel.

- **Colours by role**, not by hue: `ground`, `surface`, `raised`, `edge`, `ink`, `ink_dim`,
  `ink_faint`, `accent`, `good`, `bad`, `warn` — and a `Tone` enum so a screen says `Tone::Warn`
  rather than picking a shade. The values are the Tokyo Night ones sampled out of
  `review/devices/pulse-amoled.png`; they used to exist twice, verbatim, in `pulse_ui.cpp` and
  `pulse_wifi.cpp`.
- **Six spacing steps** (4, 8, 12, 20, 32, 52) where `lg` is also `INSET`, the corner clearance, so
  the outermost gutter is part of the same rhythm as everything inside it.
- **Nine type steps**, each a Montserrat face `lv_conf.h` already carries, named for the job:
  `caption` 16 … `hero` 40, `display` 48. Nothing is smaller than 16 — this panel is read from
  across a room.
- **Four archetypes**: `buildReading` (one subject, four labelled values, a footer),
  `buildStatus` (one state, said plainly, with what to do about it), `buildChooser` (the network
  list), `buildInput` (the passphrase keypad, `pulse_keypad.{h,cpp}` over the host-tested
  `pulse_keypad_model.h`). Every screen in the firmware is one of them, and
  the Wi-Fi join result and the ambient "Not set up" screen are now the *same* archetype.

The status archetype is why this exists. Every state with no data used to be drawn as a reading with
one row filled — the state word landing in the right-aligned 40 px value column at x=123 with three
empty label/value pairs beneath it — which is 250 px of dead panel and was reported as exactly that.

## Run it without hardware

Run these from the repository root so the isolated toolchain paths resolve correctly.

```bash
node scripts/device.ts bootstrap esp32
node scripts/device.ts doctor esp32
node scripts/device.ts sim esp32

# direct scenarios after bootstrap
export ANCHOR_GFX_DIR="$PWD/.cache/device/vendor/waveshare/examples/arduino-v2/libraries/GFX_Library_for_Arduino/src"
export ANCHOR_LVGL_DIR="$PWD/.cache/device/arduino/user/libraries/lvgl"
devices/firmware/esp32/sim/lvgl.sh --shot /tmp/pulse --quit-after 4000
devices/firmware/esp32/sim/lvgl.sh --taps "184,120 300,300" --shot /tmp/pulse
devices/firmware/esp32/sim/lvgl.sh --no-psram --shot /tmp/pulse   # the fallback draw buffer
```

Every state the ambient screen can be in has a `--feed` scenario, because a state nobody can
photograph is a state nobody has designed:

```bash
devices/firmware/esp32/sim/lvgl.sh --feed no-credentials --saved "Home:x" --shot /tmp/a
devices/firmware/esp32/sim/lvgl.sh --feed joining --saved "Home:x" --shot /tmp/b
devices/firmware/esp32/sim/lvgl.sh --feed fetching --saved "Home:x" --shot /tmp/c
devices/firmware/esp32/sim/lvgl.sh --feed failed --saved "Home:x" --shot /tmp/d
devices/firmware/esp32/sim/lvgl.sh --feed lost --saved "Home:x" --shot /tmp/e
devices/firmware/esp32/sim/lvgl.sh --feed waiting --saved "Home:x" --shot /tmp/f
devices/firmware/esp32/sim/lvgl.sh --feed disabled --saved "Home:x" --shot /tmp/g
devices/firmware/esp32/sim/lvgl.sh --feed live --saved "Home:x" --shot /tmp/h
devices/firmware/esp32/sim/lvgl.sh --feed stale --saved "Home:x" --shot /tmp/i
```

The portfolio has its own states, and slot 0 of the rotation is where they land — so a short run
photographs the portfolio and a `--gap 6000 --wait` walks on to the trending rows behind it:

```bash
devices/firmware/esp32/sim/lvgl.sh --feed portfolio --saved "Home:x" --shot /tmp/p
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-partial --saved "Home:x" --shot /tmp/q
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-stale --saved "Home:x" --shot /tmp/r
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-failed --saved "Home:x" --shot /tmp/s
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-none --saved "Home:x" --shot /tmp/t
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-fetching --saved "Home:x" --shot /tmp/u
devices/firmware/esp32/sim/lvgl.sh --feed portfolio-only --saved "Home:x" --shot /tmp/v
```

`--saved` is what keeps Wi-Fi setup from opening over the state being photographed.

The rotation is the portfolio first, then one slot per trending token, and **each half always owns at
least one slot** — with no tokens, slot 1 is the trending status saying why, and with no portfolio,
slot 0 is the portfolio status saying why. `--feed portfolio-only` is the pair that proves neither
failure can be hidden by the other half working.

This builds `pulse.ino`, `pulse_ui.cpp` and LVGL 9.2.2 for the desktop, runs the firmware's real
`setup()` and `loop()` against shims for Arduino, `Arduino_GFX` and the heap, points the firmware's
own flush callback at a 368×448 RGB565 framebuffer, and writes a PNG per frame — plus a description
of every label LVGL is holding and the box it resolved to. LVGL compiles once into a cached archive;
after that a layout change rebuilds in about a second.

It is the point of the exercise. A layout is a hundred small judgements and each one otherwise costs
a compile, a flash, a walk to the desk and a squint — on a board somebody is using.

## Battery and power off

`pulse_power.{h,cpp}` talks to the AXP2101 at 0x34. The charge shows as a chip on the metadata line
of every ambient screen, and a 1.4-second hold on that chip opens a confirmation that will switch the
unit off. `docs/devices-esp32.md` has the register table and the source each number came from.

```bash
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --battery 78,3860
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --battery 9,3550
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --battery 42,3780,charging
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --battery 0,0,none,usb
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --power

# the gesture, then the button, then what the PMU was actually asked to do
devices/firmware/esp32/sim/lvgl.sh --saved "Home:x" --feed live --battery 42,3780 \
  --hold 270,410,2600 --tap 269,308 --shot /tmp/power
```

The run prints `AXP2101 0x10 = 0x31, power off COMMANDED` when the shutdown bit was written, which is
the only way to see it here — the desktop process carries on regardless.

**`sim/include/Wire.h` replays registers, not silicon.** It answers at 0x34 only when a scenario says
to, with the addresses `pulse_power.cpp` cites, so a run proves the decode, the ADC-enable path and
the screen. It cannot tell you that writing bit 0 of 0x10 cuts power on this board. Confirm that PMU
write on the physical unit.

## Wi-Fi setup, on the glass

`pulse_wifi.{h,cpp}` is the LVGL replacement for `../app/wifi_setup.cpp`: an `lv_list` of networks,
the `pulse_keypad` button matrix over an `lv_textarea` in password mode, and a result screen that says what actually
happened. It owns its own LVGL screen — `open()` remembers whichever screen was loaded and `close()`
puts it back — so the ambient readout never has to know it exists.

```bash
# a fresh unit: nothing saved, so setup opens by itself after two seconds
devices/firmware/esp32/sim/lvgl.sh --wifi --networks "Offsite:-42,Guest:-71,Cafe:-63:open" --shot /tmp/wifi
# type a passphrase and join (coordinates are the list row, then keys, then the keyboard's OK)
devices/firmware/esp32/sim/lvgl.sh --wifi --networks "Guest:-59" --lead 3600 --gap 700 \
  --taps "180,99 97,289 106,228 70,289 298,228 271,228 134,228 161,228 97,289 334,411" --wait
# the failure screen, without standing next to a router
devices/firmware/esp32/sim/lvgl.sh --wifi --join-fail --networks "Guest:-59" --shot /tmp/wifi-failed
# a provisioned unit: no setup screen, and a 1.7 s hold on the readout is the way back in
devices/firmware/esp32/sim/lvgl.sh --wifi --saved "Guest:seaports" --networks "Guest:-59" --hold "184,200,1700"
```

The harness prints every `WiFi.begin()` the firmware made and what NVS ended up holding, which is how
"only the credential that worked is saved" is checked rather than asserted.

`pulse.ino` calls it: `pulse_wifi::begin()` in `setup()` and `pulse_wifi::tick()` in `loop()`.

**Measured** (the `## Measured` figures below predate both this module and `feed`):

- **With the feed enabled — the configuration this ships in — Wi-Fi setup costs 28,292 bytes of
  flash and 1,960 bytes of static RAM**: 1,472,139 → 1,500,431, and 50,032 → 51,992. It is small
  because `app/feed.cpp` has already linked the ESP32 Wi-Fi station stack. Wired into a sketch that
  has *not*, the same four lines cost 526,583 bytes, nearly all of it that stack. Both numbers are
  true and only the first is the price of this feature.
- **The four widgets alone are 12,444 bytes of flash and 104 of static RAM** (747,540 → 759,984),
  with `pulse_wifi.cpp` compiled but not called. Turn `LV_USE_KEYBOARD`, `LV_USE_BUTTONMATRIX`,
  `LV_USE_TEXTAREA` and `LV_USE_LIST` back off and the figure returns.
- **`LIST_H` is a name this file cannot have.** It is an include guard in a header the ESP32 core
  drags in behind `WiFi.h`, so it expands to nothing on the board and to itself on the desktop. The
  simulator compiled it happily and `arduino-cli` did not. Compile for the board before believing a
  green simulator.

## Compile for the board

```bash
node scripts/device.ts build esp32
```

This uses the pinned Arduino CLI, ESP32 core, LVGL, ArduinoJson, and Waveshare display library
recorded in [`devices/toolchain.json`](../../../toolchain.json). It compiles only. See
[`docs/device-development.md`](../../../../docs/device-development.md) for the shared workflow and
cache locations.

## Flashing

The repository device command does not upload. Flashing remains a manual hardware operation after
the unit's revision and stable USB path have been confirmed. See
[`docs/device-hardware.md`](../../../../docs/device-hardware.md) before selecting a unit and
[`docs/devices-esp32.md`](../../../../docs/devices-esp32.md) for the board-specific observations.

## Measured

- **The design system costs 2,116 bytes of flash and 216 bytes of static RAM.** 1,713,839 →
  1,715,955 (54% either way), 52,016 → 52,232. That is the whole of `pulse_design.cpp`, the status
  archetype, both adaptive font rules and two new screens, against a build that already carried the
  reading. No new face was enabled — the scale is the list of faces `lv_conf.h` already had, which
  is why it is nine steps and not seven.
- **The Wi-Fi picker's button row was 15 px wider than the safe area.** Three buttons of 109 px plus
  two 8 px gaps is 343, against a safe width of 328 — arithmetic that was correct when `INSET` was
  12 and was not updated when it became 20. Found by deriving the row from `SAFE_W` instead, which
  changed the number.
- **The keyboard ran 12 px past the safe rectangle** into both bottom corners, on the row carrying
  the space bar and the OK key. It ends at 428 now.
- **"ABC" on the mode key never fitted.** Ten columns is about 32 px a key and three glyphs of
  Montserrat 24 is 39, so the "A" was clipped in every render including the one whose comment claimed
  widening the keys had fixed it. The control keys are set in 18 now.
- **`lv_obj_get_x/y` are relative to the parent's *content* box in LVGL 9.** Reading the simulator's
  tree dump as absolute panel coordinates makes a correctly centred block look one `INSET` high. It
  cost one wrong fix, immediately reverted.

## Measured before the design system

- **Compiles at 677,672 bytes (21% of the 3 MB app partition) and 25,144 bytes of static RAM (7%).**
  `../app/` is 963,539 (30%) and 55,392 (16%) — the blitter is *larger*, because it carries the
  wire-format decoder, the WiFi stack and the setup UI that this sketch does not.
- **The whole screen lives in 8,816 bytes of LVGL heap**, zero fragmentation, reported by
  `lv_mem_monitor()` in the boot banner and by the simulator at exit. `LV_MEM_SIZE` was 256 kB of
  guessed headroom until that number existed; it is 128 kB now, sized for Explore and Wi-Fi setup
  together (the comment in `lv_conf.h` has the measurement).
- **The layout renders correctly through a 24-line draw buffer as well as a 96-line one.** Same
  picture, more flushes — which is the check that the partial-refresh tiling is right, and a bug
  there would show as banding.
- **Both allocation paths run.** `--no-psram` found that `LV_MEM_POOL_ALLOC` handing LVGL a null pool
  crashes inside `lv_init()`, before any diagnostic this firmware has; `pulse_mem.h` falls back to
  internal SRAM now. That path cannot be reached on hardware without desoldering something.
- **`lv_conf.h` is genuinely being read.** Proven by compiling a sketch whose `lv_conf.h` was a bare
  `#error` and watching the build stop on it — the control was made to fail before it was trusted.

## What simulation and CI do not measure

- **Colour fidelity, and therefore the byte-order conclusion.** The flush hands `Arduino_GFX` native
  `uint16_t` RGB565 with no swap, because `Arduino_ESP32QSPI::writePixels` does the high-byte-first
  packing itself (`MSB_32_16_16_SET`) and `../app/app.ino` already depends on exactly that. Read
  rather than remembered — and still not *seen*. If it is wrong the screen comes up with blues where
  the reds are, and the fix is one `lv_draw_sw_rgb565_swap()` in `flush_cb`.
- **Touch.** `docs/devices-esp32.md` records the CST820 on this board answering its identity
  registers and **never once answering with a coordinate**. `pulse_touch.cpp` reads it with the
  access pattern `app/sensors.cpp` proved, and releases its reset through the TCA9554 by calling
  `sensors::begin()` — which is the one non-obvious fact this board has produced — but no finger has
  produced a number here. The coordinate mapping is the identity, and is a placeholder for a
  measurement rather than a calibration.
- **Refresh rate.** LVGL renders *into* PSRAM here, which is the opposite of the blitter's
  stream-through access pattern. If the screen feels slow, move the draw buffer to
  `MALLOC_CAP_INTERNAL` first — 70 kB is plausible there.

## Hardware verification

In this order, because each answers the next one's question:

1. Flash, and read the banner. `tearing activity` near 34-36/150 ms says the panel is refreshing;
   `lv_mem` says whether 128 kB was the right pool.
2. Look at the colours. Blues where reds should be is the byte order, and the fix is one line.
3. Put a finger on the glass. The footer reports the coordinate LVGL resolved for four seconds and
   the banner prints it too. Nothing, and the CST820 is still silent. Mirrored or transposed, and
   `mapX`/`mapY` in `pulse_touch.cpp` is the one function to change — with the numbers on screen.
