# `pulse/` — the LVGL firmware

The second firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2), and the first that draws its
own screen.

`../app/` is the one that works today: the desktop renders an Anchor surface and this board blits
pixels, which is the bargain `docs/devices-esp32.md` argues for at length — the firmware owns no
font, no palette and no layout. It also cannot show anything at all with nothing on the cable, and
these units have to work in the field. That case is named in the doc and left open as "a separate,
larger call". This is that call, made.

**`app/` is not touched by any of this and stays the firmware that ships** until LVGL is proven on
glass. Nothing here has been flashed.

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
  list), `buildInput` (the passphrase keyboard). Every screen in the firmware is one of them, and
  the Wi-Fi join result and the ambient "Not set up" screen are now the *same* archetype.

The status archetype is why this exists. Every state with no data used to be drawn as a reading with
one row filled — the state word landing in the right-aligned 40 px value column at x=123 with three
empty label/value pairs beneath it — which is 250 px of dead panel and was reported as exactly that.

## Run it without hardware

```bash
devices/firmware/esp32/sim/lvgl.sh --shot /tmp/pulse --quit-after 4000
devices/firmware/esp32/sim/lvgl.sh --taps "184,120 300,300" --shot /tmp/pulse
devices/firmware/esp32/sim/lvgl.sh --no-psram --shot /tmp/pulse   # the fallback draw buffer
```

Every state the ambient screen can be in has a `--feed` scenario, because a state nobody can
photograph is a state nobody has designed:

```bash
sim/lvgl.sh --feed no-credentials --saved "Home:x" --shot /tmp/a   # nothing typed in yet
sim/lvgl.sh --feed joining        --saved "Home:x" --shot /tmp/b
sim/lvgl.sh --feed fetching       --saved "Home:x" --shot /tmp/c
sim/lvgl.sh --feed failed         --saved "Home:x" --shot /tmp/d   # never worked
sim/lvgl.sh --feed lost           --saved "Home:x" --shot /tmp/e   # worked, then stopped
sim/lvgl.sh --feed waiting        --saved "Home:x" --shot /tmp/f
sim/lvgl.sh --feed disabled       --saved "Home:x" --shot /tmp/g   # built with no API key
sim/lvgl.sh --feed live           --saved "Home:x" --shot /tmp/h   # a reading
sim/lvgl.sh --feed stale          --saved "Home:x" --shot /tmp/i   # a reading, labelled old
```

`--saved` is what keeps Wi-Fi setup from opening over the state being photographed.

This builds `pulse.ino`, `pulse_ui.cpp` and LVGL 9.2.2 for the desktop, runs the firmware's real
`setup()` and `loop()` against shims for Arduino, `Arduino_GFX` and the heap, points the firmware's
own flush callback at a 368×448 RGB565 framebuffer, and writes a PNG per frame — plus a description
of every label LVGL is holding and the box it resolved to. LVGL compiles once into a cached archive;
after that a layout change rebuilds in about a second.

It is the point of the exercise. A layout is a hundred small judgements and each one otherwise costs
a compile, a flash, a walk to the desk and a squint — on a board somebody is using.

## Wi-Fi setup, on the glass

`pulse_wifi.{h,cpp}` is the LVGL replacement for `../app/wifi_setup.cpp`: an `lv_list` of networks,
an `lv_keyboard` over an `lv_textarea` in password mode, and a result screen that says what actually
happened. It owns its own LVGL screen — `open()` remembers whichever screen was loaded and `close()`
puts it back — so the ambient readout never has to know it exists.

```bash
# a fresh unit: nothing saved, so setup opens by itself after two seconds
sim/lvgl.sh --wifi --networks "Offsite:-42,Guest:-71,Cafe:-63:open" --shot /tmp/wifi
# type a passphrase and join (coordinates are the list row, then keys, then the keyboard's OK)
sim/lvgl.sh --wifi --networks "Guest:-59" --lead 3600 --gap 700 \
  --taps "180,99 97,289 106,228 70,289 298,228 271,228 134,228 161,228 97,289 334,411" --wait
# the failure screen, without standing next to a router
sim/lvgl.sh --wifi --join-fail --networks "Guest:-59" ...
# a provisioned unit: no setup screen, and a 1.7 s hold on the readout is the way back in
sim/lvgl.sh --wifi --saved "Guest:seaports" --networks "Guest:-59" --hold "184,200,1700"
```

The harness prints every `WiFi.begin()` the firmware made and what NVS ended up holding, which is how
"only the credential that worked is saved" is checked rather than asserted.

Four lines wire it into `pulse.ino`; until they are there, `--wifi` is the only thing that calls it.

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
arduino-cli compile --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none" devices/firmware/esp32/pulse
```

## Flash it (nobody has)

```bash
arduino-cli upload -p /dev/ttyACM0 --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none" devices/firmware/esp32/pulse
```

`/dev/serial/by-id/` is the stable path when two ESP32-S3s are on the desk — every one of them
enumerates through the same Espressif descriptor, so a port index is a coin flip. See the section in
`docs/devices-esp32.md` about the 6,601 restarts that fact produced.

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
  guessed headroom until that number existed; it is 64 kB now.
- **The layout renders correctly through a 24-line draw buffer as well as a 96-line one.** Same
  picture, more flushes — which is the check that the partial-refresh tiling is right, and a bug
  there would show as banding.
- **Both allocation paths run.** `--no-psram` found that `LV_MEM_POOL_ALLOC` handing LVGL a null pool
  crashes inside `lv_init()`, before any diagnostic this firmware has; `pulse_mem.h` falls back to
  internal SRAM now. That path cannot be reached on hardware without desoldering something.
- **`lv_conf.h` is genuinely being read.** Proven by compiling a sketch whose `lv_conf.h` was a bare
  `#error` and watching the build stop on it — the control was made to fail before it was trusted.

## Not measured, and not to be claimed

- **Nothing here has been on the glass.** Not one pixel. Every statement above comes from a compiler
  or a desktop simulator.
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

## The first five minutes with hardware

In this order, because each answers the next one's question:

1. Flash, and read the banner. `tearing activity` near 34-36/150 ms says the panel is refreshing;
   `lv_mem` says whether 64 kB was the right pool.
2. Look at the colours. Blues where reds should be is the byte order, and the fix is one line.
3. Put a finger on the glass. The footer reports the coordinate LVGL resolved for four seconds and
   the banner prints it too. Nothing, and the CST820 is still silent. Mirrored or transposed, and
   `mapX`/`mapY` in `pulse_touch.cpp` is the one function to change — with the numbers on screen.
