# Anchor Pulse firmware

The device half of the wire format in [`../../src/adapters/esp32-wire.ts`](../../src/adapters/esp32-wire.ts),
and the smallest application that puts an Anchor frame on real glass.

`../../../docs/devices-esp32.md` argues the design: the host renders and the device blits, so the
firmware owns no font, no palette, no layout and no design system. What is left after that argument
is a byte-fed state machine and a `memcpy`, and that is what `src/anchor_pulse.c` is.

## The board

**Waveshare ESP32-S3-Touch-AMOLED-1.8, V2 hardware.** Measured with esptool and the probe below, not
read off a label:

```
Chip type   ESP32-S3 (QFN56) revision v0.2
Features    Wi-Fi, BT 5 (LE), dual core + LP core, 240MHz, embedded PSRAM 8MB (AP_3v3)
Flash       16MB, quad, 3.3V (manufacturer 20, device 4018)
USB mode    USB-Serial/JTAG
MAC         28:84:85:3a:d3:f0
Panel       368x448 AMOLED, CO5300 controller, QSPI
```

It is **not** an M5Stack Cardputer, which is an ESP32-S3FN8 with 8 MB of flash and no PSRAM. Both
enumerate as `303a:1001` "USB JTAG/serial debug unit", so the USB descriptor cannot tell them apart.
Ask the ROM.

### How it was identified, after a wrong answer

The first version of this firmware scanned I2C on SDA=8/SCL=9 — the Arduino defaults for an S3 —
found nothing, and reported that no display was attached. That reached `docs/devices.md` and survived
a merge. The board has a glass screen and buttons down one side.

**Zero devices on the wrong pins is not a negative result.** It is an instrument reporting that it
was aimed at nothing. AGENTS.md asks for attention to the thing you look *through*, and a default
constant is exactly what goes unlooked-at.

`probe/` replaces the assumption with a measurement and takes no pin map on faith. It drives each
safe GPIO's internal pull-down (~45k) and reports every pin that still reads high, on the physical
grounds that an I2C bus carries external pull-ups of a few kilohms and very little else does. Five
pins out of twenty-seven, and one real bus at **SDA=15, SCL=14**. Every device on it is then asked
for its identity register rather than named from its address:

| Address | Identity register | What it is |
|---|---|---|
| 0x15 | chip 0xB7, vendor 0x41 | CST820 capacitive touch |
| 0x18 | 0x83 0x11 | ES8311 audio codec |
| 0x20 | in 0xCF, out 0x87, config 0x78 | TCA9554-class IO expander |
| 0x34 | 0x4A | AXP2101 power-management unit |
| 0x51 | — | PCF85063-class real-time clock |
| 0x6B | WHO_AM_I 0x05, rev 0x7C | QMI8658 IMU |

That fingerprint names the product *and its revision*: V2 pairs a CO5300 with a CST820, where V1 used
an SH8601 with an FT3168 — the touch controller identifies the display driver. The vendor's own
`pin_config.h` then declares `IIC_SDA 15` and `IIC_SCL 14`. A physical probe and a vendor header
arriving at the same two pins independently is what makes this an identification and not a story.

## What is measured and what is not

**Measured on the hardware, with the panel presenting every frame**, by painting real Anchor surfaces
from the real host adapter through `tools/measure.ts`:

| | |
|---|---|
| PSRAM | 8,388,608 bytes total, 7,943,664 free at boot |
| Internal heap | 333,448 free, largest block 270,324 |
| Framebuffer | 368×448 RGB565 = **329,728 bytes, allocated in PSRAM** |
| Firmware size | 389,200 bytes of flash (12%), 32,848 bytes of static RAM |
| Full frame on the wire | 60 messages, **23,219 bytes** — about 5% of the raw framebuffer |
| Ping round trip | median **0.9 ms** |
| Full frame, end to end | 74 ms to render and send, then **139 ms** to the pong |
| A changed reading | median **70 ms** (min 55, max 97) |
| Unchanged frame | median **3 ms**, and **zero bytes on the wire** |

The instrument is the PONG. The stream is ordered, so a reply to a ping issued after a COMMIT cannot
come back until the device has read, decoded and *presented* everything before it — an upper bound on
the whole path, with no cooperation from the firmware beyond a reply the protocol already requires.

**Against the design doc's falsification test** — the argument for shipping pixels is wrong if a full
frame costs more than a few hundred milliseconds or a changed reading more than about 50 ms: the full
frame passes at ~213 ms, and the changed reading **misses** at 70 ms. It is honest to say so. The cost
is not the link: host rasterisation is 22–41 ms of it, and the panel push was most of the rest until
the decoder began reporting which rows changed (105 ms → 70 ms).

**Measured on the desktop**, with no hardware, on every `npm test`:

- `src/anchor_pulse.c` compiles clean under `cc -std=c99 -Wall -Wextra -Werror -O2`.
- It reconstructs, byte for byte, the frames the real `Esp32PulseDevice` paints — including a second
  incremental paint, and including the stream split at every single byte boundary.
- The comparison can fail: corrupting a pixel byte produces a different framebuffer, and a test
  asserts it does.
- Tiles that overrun the panel, run-length data that under-fills its rectangle, payloads larger than
  the buffer HELLO promised, and message types only a device may send are each refused, with the
  specific fault.
- The dirty-row band is asserted from synthetic tiles at known rows, so it holds on a machine with
  different fonts.

**Not measured:**

- Wi-Fi, TLS-PSK, and free heap with a radio and a TLS session up.
- Touch, the IMU, and the side buttons. All present, none wired to `DeviceInput` yet.
- Colour fidelity. The framebuffer is handed to the driver as native-endian RGB565 with no swap pass;
  that it is *correct* on the glass is a thing a person has to look at.

## What the hardware taught us

Bugs no amount of desktop testing would have found. Each is fixed, and each is the kind of thing
AGENTS.md means by measuring the instrument rather than the reading.

1. **`setRxBufferSize` was a silent no-op.** With `CDCOnBoot=cdc` the core calls `Serial.begin()`
   before `setup()` runs, and resizing a running HWCDC does nothing and returns 0. The code looked
   right, the comment claimed 16 KB, and the buffer stayed at the default. It needs `Serial.end()`
   first — and the size is in the boot banner now, because a buffer you believe in is not a buffer
   you measured.
2. **The receive buffer has to hold a whole frame, not a whole tile.** The blit target is PSRAM,
   far slower to write than internal SRAM, so the device cannot decode a 23 KB frame as fast as USB
   delivers it. The general answer is flow control — the protocol already has PING/PONG, and a host
   that pings every N tiles cannot outrun any device — but that is a reviewed change, not a bring-up.
3. **A dropped byte does not look like a dropped byte.** It shifts the stream, so the next header is
   read out of the middle of a payload. It surfaced as `ANCHOR_FAULT_MAGIC`, and later — once a
   shifted length field happened to look plausible — as `ANCHOR_FAULT_LENGTH`. Neither names the
   cause.
4. **Flashing leaves bytes in the peripheral**, and feeding them to a strict parser makes a
   freshly-flashed device announce itself as already broken. Both ends now resynchronise once
   *before* the session and stay strict after it — the device mirrors the host's `findHello`.
5. **A cable has no disconnect event.** A device stops announcing itself once READY lands, so the
   next host to open the port waits for a HELLO that never comes: a display that works exactly once
   per power cycle. The firmware watches the CDC connection state, which is the honest equivalent of
   a socket close.
6. **A search whose success and whose failure look identical is not a search.** `panelsweep/` hunted
   the display bus using the tearing line as an oracle. It found the pins that silenced the panel —
   and then carried on past the hit instead of stopping, so it could not say which combination did
   it, and produced two thousand more "candidates" against a line that was already dead. It aborts on
   a dead oracle now.
7. **And the mirror of that, which is the one worth remembering.** Once the pin map was known, a full
   initialisation brought the controller back and the tearing line stayed at zero — which read exactly
   like a panel that was still dark. It was not. Arduino_GFX's init does not enable tearing, and the
   original 58 Hz had come from the firmware that shipped on the board. One command (`0x35`) restored
   it. The panel had been refreshing the whole time; the *instrument* was off. That is the same error
   as the I2C scan at the top of this file, pointing the other way.

The fault code rides in the device id of the next HELLO — `anchor-pulse-s3-fault-3` — because by the
time the decoder rejects something the host has usually already hung up, and the protocol
deliberately has no message for a complaint. That channel is how several of these were found rather
than guessed at.

## Layout

```
src/anchor_pulse.{c,h}   the protocol. C99, no allocation, no platform. This is the firmware.
host/conformance.c       the same decoder as a desktop binary, driven by the Node test
app/app.ino              the application: transport, framebuffer, the LED, and nothing else
probe/probe.ino          what is actually wired to this board — measured, not assumed
panelsweep/panelsweep.ino  hunt for the display's bus using the panel's own tearing line
tools/bringup.ts         host side — paint one frame down the cable and hold it there
tools/measure.ts         host side — what a frame actually costs, end to end
library.properties       so the Arduino IDE can find src/ as a library
platformio.ini           an alternative build; see the note under Building
```

The split is the point. Everything with judgement in it is in `src/`, which is portable and is
tested on every `npm test`; everything platform-specific is a thin shim that can be replaced without
touching a decoder.

## Transport: the cable first, the radio later

The design doc specifies Wi-Fi with TLS-PSK, the device listening and Anchor dialling out. That is
still the end state and nothing here contradicts it. This firmware speaks the identical protocol
over **USB CDC serial**, for two reasons.

**It is the short path to a lit pixel.** A network display needs an SSID, a password, a provisioning
portal, a generated pairing key and a QR code scanned off a screen that is not drawing yet — five
things that can be wrong before the first frame. A cable needs none of them, and everything upstream
of the transport is unchanged: same surfaces, same rasteriser, same theme, same dirty-rect diff,
same bytes.

**It makes invariant 6 vacuous rather than merely satisfied.** Over the network the invariant is
kept by inverting the connection direction so Anchor binds nothing. Over a cable there is no socket,
no port, no address and no route — the bytes never enter a network stack, so there is nothing on any
LAN to reach and no eavesdropper for a pairing key to protect against. That is strictly stronger
than the loopback exemption `checkTransport` already grants, which is why this path is allowed in
the clear while a LAN one is refused. The trust boundary becomes a wire, exactly as it is for the
Stream Deck.

Moving to Wi-Fi later replaces two functions in the sketch and nothing above them.

## Building and flashing

### Prerequisites

```bash
sudo pacman -S --needed arduino-cli esptool
```

The serial device is `root:uucp` on Arch. On this machine it was made usable through the udev
`uaccess` ACL, so the logged-in user gets read/write with no `sudo` and no group change.

> **PlatformIO is the other path and was not the one used.** `platformio.ini` is here because
> `~/Projects/cardputer` builds that way, but on this machine `pio` could not install
> `tool-esptoolpy`: it shells out to `pip`, and the system Python is externally managed and has no
> `pip` module, so the install fails with `MissingPackageManifestError` and then loops over
> download mirrors forever. It works from a PlatformIO virtualenv. arduino-cli needs no Python at
> all, which is why the verified instructions below use it.

### 1. Identify the board first

Native-USB Espressif parts all enumerate identically as `303a:1001` "USB JTAG/serial debug unit", so
the USB descriptor does **not** say which chip it is — a bare S3 devkit and an M5Stack Cardputer are
indistinguishable from the descriptor alone. Ask the ROM:

```bash
esptool --port /dev/ttyACM0 flash-id
```

### 2. Install the core

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.11
```

Pinned deliberately; 3.3.11 is the version this was built and flashed with. These are firmware
libraries, not npm dependencies — the `devices` workspace still has exactly one.

The panel needs a CO5300 driver. **Do not install `GFX Library for Arduino` from the Arduino
index:** 1.6.0 is the published version and it does not compile against ESP32 core 3.3.11 —
`Arduino_ESP32SPI` calls `spiFrequencyToClockDiv` with the pre-3.x signature. The vendor repository
carries **1.6.4**, which does compile, so take it from there — clone
`waveshareteam/ESP32-S3-Touch-AMOLED-1.8` and copy
`examples/arduino-v2/libraries/GFX_Library_for_Arduino` into `~/Arduino/libraries/`.

`arduino-v2` is the V2 hardware, which is what this board is. That directory also holds
`pin_config.h`, and it is the source of every display constant in `app/` — none were written from
memory.

### 3. Link this directory as a library

The application lives in `app/` and the protocol in `src/`, so the sketch finds `anchor_pulse.h`
through the Arduino library path rather than a relative include:

```bash
mkdir -p ~/Arduino/libraries
ln -sfn "$PWD" ~/Arduino/libraries/AnchorPulse
```

### 4. Compile and flash

The FQBN below is for the **N16R8** board measured above: 16 MB flash, 8 MB octal PSRAM, native USB.
`PSRAM=opi` and `FlashSize=16M` are not cosmetic — with the wrong PSRAM mode the board boots and
finds no PSRAM, which looks exactly like a code bug for an hour.

```bash
FQBN=esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none
arduino-cli compile --fqbn "$FQBN" app
arduino-cli upload  --fqbn "$FQBN" -p /dev/ttyACM0 app
```

`CDCOnBoot=cdc` matters: without it `Serial` is a UART on pins nobody has wired, and the firmware
appears to do nothing at all. `DebugLevel=none` matters too — the core's own log goes to the same
CDC endpoint the protocol uses, and a log line arriving mid-frame is a fault.

If the board does not auto-reset into the bootloader, hold BOOT while plugging it in.
`esptool --port /dev/ttyACM0 erase-flash` is the way back to a blank board.

### 5. Paint something

```bash
node devices/firmware/esp32/tools/bringup.ts --port /dev/ttyACM0
node devices/firmware/esp32/tools/measure.ts --port /dev/ttyACM0
```

`bringup` prints the geometry the device reported, paints one `detail` surface in the live Omarchy
theme, and repaints on a timer. **The repaint sends no bytes** — the dirty-rect diff finds nothing —
so a link that stays up while the byte counter stays still is the idle-costs-nothing property
working. `measure` produces the table above.

The boot banner appears on the same port, and the device waits for a host before printing it:

```
anchor-pulse: chip ESP32-S3 rev 2, 2 core(s), 240 MHz
anchor-pulse: psram total 8388608 free 7943664
anchor-pulse: panel 466x466, framebuffer 434312 bytes in psram
anchor-pulse: serial rx buffer 65536 bytes
anchor-pulse: i2c devices found: 0 (SDA=8 SCL=9)
```

## Verifying the decoder without hardware

```bash
cd devices && npm test                        # includes the conformance suite
```

Or drive it by hand:

```bash
cc -std=c99 -Wall -Wextra -Werror -O2 -Isrc -o /tmp/conformance \
  host/conformance.c src/anchor_pulse.c
/tmp/conformance 128 128 1033 /tmp/fb.bin /tmp/dev.bin 1 < frames.bin
```

The last argument is the chunk size. `1` feeds the stream a byte at a time, which splits every
message at every possible offset — what a 64-byte USB endpoint and a TCP segment boundary do to it
in practice.

## What the firmware may not do

Restating it here because this is the file a firmware author opens, and the boundary is the design
rather than an omission.

- **It signs, spends and approves nothing.** There is no opcode, field or string in this protocol
  for a signature, a key, an address, an amount or an approval, and there is nowhere to add one that
  would not be a new document and a human's decision. AGENTS.md invariant 1.
- **Its entire outbound vocabulary is a slot id and two numbers.** A tap is a page change. The host
  hangs up on a device that sends anything else, and `anchor_pulse_feed` returns `ANCHOR_FAULT_TYPE`
  on a host that does.
- **It never allocates.** The framebuffer and the tile buffer are the caller's, and `maxTileBytes`
  in HELLO is a promise about memory that already exists. A message larger than the promise is a
  fault, not a bigger buffer.
- **It serves nothing.** No HTTP status page, no OTA endpoint, no debug shell. A device that also
  runs a helpful web UI has undone `docs/devices-esp32.md` entirely.
- **It blanks when told.** BLANK arrives when the desktop session locks, and it clears the pixels as
  well as the backlight — a dimmed panel is still readable in a dark room and entirely readable to a
  phone camera.

## Known gaps

- **Colour fidelity is unverified.** The framebuffer is handed to the driver as native-endian RGB565
  with no swap pass, which is why `ANCHOR_PIXEL_RGB565_LE` is what HELLO declares. That it looks
  right on the glass needs a person to look at the glass.
- **The whole dirty band is pushed, not the dirty rectangle.** The decoder reports the rows that
  changed, because a band of whole rows is contiguous in the framebuffer and needs no per-row loop.
  A narrow change in the middle of a wide panel still pushes full-width rows. Measure before making
  it cleverer.
- **Touch, the IMU and the side buttons are all unused.** The HELLO input mask is zero. A CST820 and
  a QMI8658 are real inputs, and GPIO 1, 2 and 21 carry external pull-ups, which is what a button
  looks like. Each is a bit in that mask and a call to `anchor_pulse_input` — and none of them could
  say anything but a slot id and two numbers.
- **No flow control.** The 64 KB receive buffer is a fix for this board's frame size, not a general
  one. A host that pinged every N tiles and waited could not outrun any device, using only the
  vocabulary the protocol already has. It is the right next change and it is a reviewed one.
- **A page shaped for this screen.** 368×448 in portrait is not a strip, and the panel currently
  renders a page designed for other geometry. That is a design question, and `scripts/review.ts` is
  where it gets answered.
- **No Wi-Fi, no TLS-PSK.** Deliberate. The cable keeps invariant 6 vacuous rather than merely
  satisfied.
