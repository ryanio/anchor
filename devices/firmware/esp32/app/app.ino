/*
 * Anchor Pulse on an ESP32-S3, over the USB cable.
 *
 * The board this was written for and flashed to is a bare ESP32-S3 N16R8 devkit: 16MB of flash,
 * 8MB of octal PSRAM, native USB-Serial/JTAG, and a glass display whose bus is not yet known.
 * The display is real — `probe/` measures a panel's tearing-effect line ticking at 58 Hz on GPIO 13
 * — but its QSPI pin map has not been found, so nothing here can draw on it yet. Until it can, this
 * firmware does the two things the hardware can honestly do today:
 *
 *   1. **Run the real protocol against a real framebuffer.** The panel is 466x466 — the largest
 *      candidate in the design doc — allocated in PSRAM, painted by the host, decoded by the same
 *      `anchor_pulse.c` the host test compiles. Nothing about that is simulated. It turns the two
 *      biggest "assumed, not verified" lines in the doc into measurements: whether a 434 KB
 *      framebuffer fits, and what a full frame actually costs end to end.
 *   2. **Show the frame on the only output it has.** The devkit's RGB LED is driven from the mean
 *      colour of the committed frame, so an Anchor surface rendered on the desktop, in the user's
 *      live Omarchy theme, changes the colour of a light on the board. It is one pixel, and it is a
 *      real one — the whole path, host rasteriser to glass, with only the glass missing.
 *
 * Everything with judgement in it is in `../src/anchor_pulse.c`, which is portable C99 and is
 * compiled and driven by `devices/src/adapters/esp32-firmware.test.ts` on every `npm test`. This
 * file is a transport, a buffer and a light.
 */

#include <Arduino.h>
#include <Wire.h>
#include <esp_heap_caps.h>

#include "anchor_pulse.h"

/*
 * The panel this device claims.
 *
 * No panel is driven yet, so this is a choice rather than a measurement, and it is the design doc's
 * largest candidate on purpose: 466x466 RGB565 is 434,312 bytes, which the doc says "does not fit
 * in internal SRAM on an S3" and leaves as arithmetic. With 8MB of PSRAM confirmed on this board it
 * fits comfortably, and pushing a real frame at that size is the falsification test the doc asks
 * for — if a full frame costs more than a few hundred milliseconds end to end, shipping pixels was
 * the wrong call.
 */
#define PANEL_WIDTH 466u
#define PANEL_HEIGHT 466u
#define PANEL_BYTES (PANEL_WIDTH * PANEL_HEIGHT * 2u)

/*
 * The tile buffer stays in internal SRAM even though PSRAM is available: every incoming byte is
 * memcpy'd through it, and PSRAM is on a slower bus than the CPU's own RAM. 8 KB holds four full
 * rows of the widest panel.
 */
#define MAX_TILE_BYTES 8192u
static uint8_t tile_buffer[MAX_TILE_BYTES + 9u];

/*
 * The receive buffer, sized to hold a whole frame rather than a whole tile.
 *
 * **Measured, and it is the interesting number on this board.** A full 466x466 repaint is about
 * 23 KB on the wire after run-length coding, delivered by USB in well under 100 ms. The device
 * cannot decode it that fast, and the reason is where the pixels land: the framebuffer is in PSRAM,
 * which is an order of magnitude slower to write than internal SRAM. With a 16 KB buffer the tail
 * of every full frame was dropped, the stream shifted, and the decoder faulted on a header it read
 * out of the middle of a payload — first as ANCHOR_FAULT_MAGIC, then, once a shifted length field
 * happened to look plausible, as ANCHOR_FAULT_LENGTH.
 *
 * 64 KB absorbs the whole burst, so the decode rate stops mattering for a single frame. That is a
 * fix for this board and not a general one: the honest general answer is flow control, and the
 * protocol already has the vocabulary for it — a host that pings every N tiles and waits for the
 * pong cannot outrun any device. That belongs in a reviewed change, not in a bring-up.
 */
#define ANCHOR_RX_BUFFER_BYTES 65536u

static uint8_t *framebuffer = nullptr;
static uint16_t panel_width = PANEL_WIDTH;
static uint16_t panel_height = PANEL_HEIGHT;

static anchor_pulse_t pulse;

static uint32_t last_heard_ms = 0;
static uint16_t stale_after_ms = 6000;
static uint8_t configured_brightness = 70;
static bool have_ready = false;
static bool presented = false;
static uint32_t commit_count = 0;
static bool framebuffer_in_psram = false;
static size_t rx_buffer_bytes = 0;

/* ------------------------------------------------------------------------------- the light ---- */

/*
 * The devkit's one output.
 *
 * `RGB_BUILTIN` is defined by the board variant; GPIO48 is the fallback because that is where the
 * WS2812 sits on an ESP32-S3-DevKitC-1. If the board turns out to have neither, this is a no-op and
 * the protocol still runs — which is the point of keeping the light out of the decoder.
 */
#ifndef RGB_BUILTIN
#define RGB_BUILTIN 48
#endif

static void show_colour(uint8_t r, uint8_t g, uint8_t b) {
  rgbLedWrite(RGB_BUILTIN, r, g, b);
}

/*
 * The mean colour of the frame, as one pixel.
 *
 * Sampled rather than summed over every pixel: 217,156 of them is real work on every commit, and a
 * regular stride over a flat-filled surface lands on the same answer. The pixels are RGB565 in the
 * order the host was told to send them — `ANCHOR_PIXEL_RGB565_LE` below — so this reads them as
 * little-endian and unpacks 5/6/5.
 */
static void present_to_led(void) {
  const uint32_t pixels = (uint32_t)panel_width * (uint32_t)panel_height;
  const uint32_t stride = 37; /* coprime with the row width, so it does not sample one column */
  uint32_t r = 0, g = 0, b = 0, n = 0;
  for (uint32_t i = 0; i < pixels; i += stride) {
    uint16_t p = (uint16_t)framebuffer[i * 2] | ((uint16_t)framebuffer[i * 2 + 1] << 8);
    r += ((p >> 11) & 0x1F) << 3;
    g += ((p >> 5) & 0x3F) << 2;
    b += (p & 0x1F) << 3;
    n++;
  }
  if (n == 0) return;
  /* Scaled by the host's brightness so BRIGHTNESS and BLANK mean something on a device with no
   * backlight to turn down. */
  uint32_t scale = configured_brightness > 100 ? 100 : configured_brightness;
  show_colour((uint8_t)(r / n * scale / 100), (uint8_t)(g / n * scale / 100),
              (uint8_t)(b / n * scale / 100));
}

/* -------------------------------------------------------------------------------- sinks ------- */

static void sink_write(void *ctx, const uint8_t *bytes, size_t count) {
  (void)ctx;
  Serial.write(bytes, count);
}

static void sink_present(void *ctx) {
  (void)ctx;
  commit_count++;
  presented = true;
  present_to_led();
}

static void sink_ready(void *ctx, const anchor_ready_t *ready) {
  (void)ctx;
  have_ready = true;
  configured_brightness = ready->brightness;
  stale_after_ms = ready->stale_after_ms;
}

static void sink_brightness(void *ctx, uint8_t percent) {
  (void)ctx;
  configured_brightness = percent;
  if (presented) present_to_led();
}

/*
 * BLANK is a security message, not a convenience. The host sends it when the desktop session locks,
 * and `docs/security.md` is explicit that private wallet data must not stay on a screen its owner
 * has walked away from. The pixels go, not just the brightness.
 */
static void sink_blank(void *ctx) {
  (void)ctx;
  anchor_pulse_fill(&pulse, 0x00, 0x00);
  presented = false;
  show_colour(0, 0, 0);
}

/* -------------------------------------------------------------------------------- banner ------ */

/*
 * What is on this board, printed once, before the first HELLO.
 *
 * This is not decoration: it is how the machine on the other end of the cable learns the chip, the
 * memory and whether anything answered on I2C, without a second channel and without a JTAG probe.
 * The host's serial link resynchronises past it (`findHello` in `esp32-serial.ts`), which is why it
 * is safe to put human-readable text on the same endpoint the protocol uses.
 *
 * Once only, and strictly before the first HELLO. A banner emitted *after* a host has synchronised
 * would arrive mid-stream and be read as a device talking nonsense — correctly, because that is
 * what it would be.
 */
static void scan_i2c(void) {
  Wire.begin(15 /* SDA */, 14 /* SCL */, 100000u);
  int found = 0;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.printf("anchor-pulse: i2c device at 0x%02X\n", address);
      found++;
    }
  }
  Serial.printf("anchor-pulse: i2c devices found: %d (SDA=15 SCL=14, measured by probe/)\n", found);
  // Scanned on the bus the probe measured, not on the Arduino defaults. Scanning the wrong pins and
  // reading the silence as "no display" is precisely how this firmware once reported a board with a
  // screen on it as having none.
}

static void banner(void) {
  Serial.printf("anchor-pulse: firmware up, protocol v%d\n", ANCHOR_PULSE_VERSION);
  Serial.printf("anchor-pulse: chip %s rev %d, %d core(s), %d MHz\n", ESP.getChipModel(),
                ESP.getChipRevision(), ESP.getChipCores(), ESP.getCpuFreqMHz());
  Serial.printf("anchor-pulse: flash %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("anchor-pulse: psram total %u free %u\n", (unsigned)ESP.getPsramSize(),
                (unsigned)ESP.getFreePsram());
  Serial.printf("anchor-pulse: internal heap free %u largest %u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  Serial.printf("anchor-pulse: panel %ux%u, framebuffer %u bytes in %s\n", panel_width, panel_height,
                (unsigned)((uint32_t)panel_width * panel_height * 2u),
                framebuffer_in_psram ? "psram" : "internal");
  Serial.printf("anchor-pulse: rgb led on gpio %d\n", RGB_BUILTIN);
  Serial.printf("anchor-pulse: serial rx buffer %u bytes\n", (unsigned)rx_buffer_bytes);
  scan_i2c();
  Serial.printf("anchor-pulse: no panel driver yet; the frame is shown as one colour on the led\n");
  Serial.flush();
}

/* ---------------------------------------------------------------------------------- boot ------- */

/*
 * Why the device id carries the last fault.
 *
 * When the decoder rejects something, the host has usually already hung up — it saw bytes it could
 * not parse and closed the link, which is exactly what it should do. So there is no connection left
 * to report the reason down, and the protocol deliberately has no message for one.
 *
 * The id in the *next* HELLO is the one honest channel: it is a string the device already sends, it
 * is sanitised at the host before it reaches a log line, and reconnecting is how anyone would look.
 * A device that faulted announces itself as `anchor-pulse-s3-fault-3` until it is power cycled, and
 * that is how the receive-buffer bug below was found rather than guessed at.
 */
static anchor_fault_t last_fault = ANCHOR_OK;

static void say_hello(void) {
  uint8_t out[96];
  char id[40];
  if (last_fault == ANCHOR_OK) {
    snprintf(id, sizeof(id), "anchor-pulse-s3");
  } else {
    snprintf(id, sizeof(id), "anchor-pulse-s3-fault-%d", (int)last_fault);
  }
  /*
   * The input mask is zero: this board reports nothing. There is no touch panel, no keyboard and no
   * IMU on it. Adding one later is a bit in this mask and a call to `anchor_pulse_input` — and it
   * still could not say anything but a slot id and two numbers.
   */
  size_t n = anchor_pulse_hello(out, sizeof(out), panel_width, panel_height,
                                ANCHOR_PIXEL_RGB565_LE, (uint16_t)MAX_TILE_BYTES, 0u, id);
  if (n > 0) Serial.write(out, n);
}

static void install_decoder(void) {
  anchor_pulse_sink_t sink;
  memset(&sink, 0, sizeof(sink));
  sink.present = sink_present;
  sink.ready = sink_ready;
  sink.brightness = sink_brightness;
  sink.blank = sink_blank;
  sink.write = sink_write;
  anchor_pulse_init(&pulse, framebuffer, panel_width, panel_height, tile_buffer,
                    sizeof(tile_buffer), &sink);
  anchor_pulse_fill(&pulse, 0x00, 0x00);
}

void setup() {
  /*
   * The receive buffer, and why it is the first line of setup().
   *
   * **Measured, the hard way.** With the core's default HWCDC ring buffer the first full frame
   * faulted every time: the host splits a 466x466 panel into 8 KB tiles and writes them back to
   * back, USB delivers them faster than `loop()` drains them, and the bytes that do not fit are
   * dropped on the floor. A dropped byte is not a dropped pixel — it shifts the stream, so the next
   * header is read out of a payload and the decoder correctly concludes it is being lied to.
   *
   * The symptom was a device that answered pings in 1 ms and then went silent forever, which reads
   * like a hang and is actually a fault. 16 KB holds two of the largest tiles the host can send.
   */
  /*
   * `end()` first, and this is the whole bug.
   *
   * With `CDCOnBoot=cdc` the core has already called `Serial.begin()` before `setup()` runs, and
   * `setRxBufferSize` on a running HWCDC does nothing and returns 0. So the first version of this
   * line looked correct, changed nothing, and the device kept dropping bytes — the buffer stayed at
   * the core's default while the comment above it claimed 16 KB. The size is printed in the banner
   * now, because a buffer you believe in is not a buffer you measured.
   */
  Serial.end();
  rx_buffer_bytes = Serial.setRxBufferSize(ANCHOR_RX_BUFFER_BYTES);
  Serial.begin(115200);
  // Without this a write blocks forever whenever no host has the port open, which on a device whose
  // only job is to be written to is a hang rather than a slow path.
  Serial.setTxTimeoutMs(0);
  show_colour(0, 0, 0);

  /*
   * PSRAM first, internal SRAM as a fallback at a smaller panel.
   *
   * A 434 KB framebuffer cannot come out of internal RAM on this part, so a board without working
   * PSRAM must claim a smaller panel rather than fail to boot — the host reads the geometry out of
   * HELLO and paints whatever it is told, which is exactly why that field exists.
   */
  framebuffer = (uint8_t *)heap_caps_malloc(PANEL_BYTES, MALLOC_CAP_SPIRAM);
  framebuffer_in_psram = framebuffer != nullptr;
  if (framebuffer == nullptr) {
    panel_width = 240;
    panel_height = 135;
    framebuffer = (uint8_t *)heap_caps_malloc((size_t)panel_width * panel_height * 2u,
                                              MALLOC_CAP_INTERNAL);
  }
  if (framebuffer == nullptr) {
    // Nothing useful is possible; say so on a loop rather than pretending to be a display.
    for (;;) {
      Serial.println("anchor-pulse: no memory for a framebuffer");
      show_colour(40, 0, 0);
      delay(1000);
    }
  }

  install_decoder();

  /*
   * Say nothing until someone is listening.
   *
   * HWCDC discards writes when no host has the port open — which is correct, and it meant the boot
   * banner was reliably lost: the board finished booting long before anything attached, printed its
   * one banner into the void, and every later reader saw only HELLOs. Waiting on `Serial`, which
   * reports the CDC connection state, makes the banner arrive for whoever actually connects.
   *
   * The flush matters as much. Flashing leaves the peripheral's receive path holding bytes from
   * esptool's stub loader, and feeding those to the decoder is a guaranteed ANCHOR_FAULT_MAGIC
   * before a host has said anything at all — a device that announces itself as already broken.
   */
  uint32_t waited = 0;
  while (!Serial && waited < 30000u) {
    delay(10);
    waited += 10;
  }
  delay(50);
  while (Serial.available() > 0) (void)Serial.read();

  banner();
  last_heard_ms = millis();
  say_hello();
}

/* ---------------------------------------------------------------------------------- loop ------- */

void loop() {
  uint8_t chunk[4096];
  /*
   * Drain everything that is waiting before doing anything else.
   *
   * The old shape read one chunk per `loop()` and then slept a millisecond, which caps the device
   * at half a megabyte a second no matter how fast the link is — and a frame arrives faster than
   * that. Draining in a loop means the only limit is how fast the decoder runs.
   */
  bool read_any = false;
  while (Serial.available() > 0) {
    int available = Serial.available();
    size_t take = (size_t)available > sizeof(chunk) ? sizeof(chunk) : (size_t)available;
    size_t got = Serial.readBytes(chunk, take);
    if (got == 0) break;
    read_any = true;
    {
      last_heard_ms = millis();
      anchor_fault_t fault = anchor_pulse_feed(&pulse, chunk, got);
      if (fault != ANCHOR_OK) {
        last_fault = fault;
        /*
         * A host that sent something a host cannot send is not a host. Start over rather than
         * resynchronise: the decoder has already been told a lie, and the cheapest honest response
         * is a device that has forgotten everything and is asking again.
         *
         * This is also the one fault signal the host can see without a second channel — a fresh
         * HELLO arriving mid-session means the device rejected something.
         */
        install_decoder();
        have_ready = false;
        presented = false;
        show_colour(20, 0, 0);
        delay(200);
        say_hello();
        break;
      }
    }
  }

  /*
   * Noticing that the host went away.
   *
   * On the network a closed socket says this for you. A cable says nothing at all: the port keeps
   * existing, the device stays in its session, and because a device stops announcing itself once
   * READY lands, the *next* host to open the port waits for a HELLO that will never come. The
   * symptom is a display that works exactly once per power cycle, and it cost a debugging round
   * here — `connected but sent no hello within 10000ms` against a device that was perfectly healthy.
   *
   * `Serial` as a bool is the CDC connection state, which is the honest equivalent of a socket
   * close. Long silence is the backstop for a host that dies without dropping DTR: the frame is
   * already blanked by then, so returning to announcing costs nothing and makes reconnection work.
   */
  static bool was_connected = true;
  bool connected = (bool)Serial;
  bool timed_out = have_ready && (millis() - last_heard_ms) > ((uint32_t)stale_after_ms * 8u);
  if ((was_connected && !connected) || timed_out) {
    install_decoder();
    last_fault = ANCHOR_OK;
    have_ready = false;
    presented = false;
    show_colour(0, 0, 0);
  }
  was_connected = connected;

  /*
   * Serial has no connect event, so the device asks until someone answers.
   *
   * On the network the device accepts a connection and knows when a host arrived; on a cable the
   * port simply exists and the host may open it minutes after boot. The host reads the first HELLO
   * it sees and drops the rest of that segment, which is why this stops the moment READY lands.
   */
  static uint32_t last_hello_ms = 0;
  if (!have_ready && millis() - last_hello_ms > 500u) {
    last_hello_ms = millis();
    say_hello();
  }

  /*
   * The only thing this device decides on its own.
   *
   * Past the host's stale threshold the frame is no longer known to be true, and the firmware
   * cannot write "stale" on itself — it has no font, which is the whole bargain of shipping pixels.
   * So it dims, which says "this is not live" without claiming to know what is, and then it goes
   * dark, because an unlit light is a true statement and a stale portfolio is a false one.
   */
  if (presented && have_ready) {
    uint32_t silence = millis() - last_heard_ms;
    if (silence > (uint32_t)stale_after_ms * 4u) {
      sink_blank(nullptr);
    } else if (silence > stale_after_ms) {
      uint8_t was = configured_brightness;
      configured_brightness = (uint8_t)(was / 4u);
      present_to_led();
      configured_brightness = was;
    }
  }

  // Only yield when there was nothing to do. Sleeping while bytes are queued is what overflowed
  // the buffer in the first place.
  if (!read_any) delay(1);
}
