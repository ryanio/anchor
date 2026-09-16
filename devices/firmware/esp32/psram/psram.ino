/*
 * Is the corruption in the buffer, or in the wire out of it?
 *
 * The app firmware paints a 368x448 RGB565 framebuffer held in PSRAM and pushes bands of it to the
 * CO5300 with `draw16bitRGBBitmap`. A unit on this desk shows "weird blocks, not super consistent"
 * while every other instrument says the system is fine:
 *
 *   - `panel/` reports the tearing-effect line steady at 34-36 transitions and solid fills clean, so
 *     the controller, the init sequence and the QSPI bus all work.
 *   - The device id in every HELLO has been `anchor-pulse-s3` with no `-fault-N` all evening, so the
 *     decoder is parsing the host's tiles cleanly — nothing is being dropped or shifted on the wire.
 *   - Measured host side, steady state traffic is about 2KB over six repaints. Nothing is flooding.
 *
 * What none of those touch is the path actually in use: a large, contiguous read out of *PSRAM*,
 * DMA'd over QSPI, while the CPU is doing other work. `panel/` draws with `fillScreen` and
 * primitives, which stream nothing out of PSRAM at all. That is the gap this sketch closes.
 *
 * It answers three questions that separate three different bugs, and it answers them without a host:
 *
 *   1. **Does the buffer itself stay intact?** The pattern is written once and checksummed after
 *      every blit. A checksum that drifts means memory is being corrupted, and nothing about the
 *      display is at fault.
 *   2. **Does the same pattern blit cleanly from internal SRAM?** The A/B is the whole point. A
 *      quarter-height band is blitted from PSRAM and then the identical band from internal RAM. If
 *      PSRAM is dirty and SRAM is clean, the answer is the memory the buffer lives in, which is a
 *      firmware fix (bounce buffer, or smaller bands) rather than a broken panel.
 *   3. **Is it the size of the transfer?** Bands are blitted at four sizes, largest first, and each
 *      is labelled on the glass. Corruption that only appears past some height is a DMA or bus
 *      contention limit, and the band size in `present_frame` becomes the thing to cap.
 *
 * The pattern is deliberately flat colour blocks separated by one pixel white rules: flat blocks
 * make a wrong byte obvious at arm's length, and a rule that bends or repeats locates it. Each
 * block also carries a distinct colour per row and column, so a block drawn from the wrong offset
 * shows as the wrong colour rather than as plausible noise.
 *
 *   arduino-cli compile --fqbn "$FQBN" psram
 *   arduino-cli upload  --fqbn "$FQBN" -p /dev/ttyACM1 psram
 *
 * Reflash `app` afterwards; this takes over the screen like every other sketch here.
 */

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <esp_heap_caps.h>

#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define TE_PIN 13

#define PANEL_WIDTH 368
#define PANEL_HEIGHT 448
#define PANEL_PIXELS ((uint32_t)PANEL_WIDTH * PANEL_HEIGHT)

Arduino_DataBus *bus =
    new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
/* The 16 is the vendor's column offset; `panel/` says what getting it wrong looks like. */
Arduino_CO5300 *gfx =
    new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0 /* rotation */, PANEL_WIDTH, PANEL_HEIGHT, 16, 0, 0, 0);

static uint16_t *psram_frame = nullptr;
/* One quarter of the panel, in internal RAM, for the A/B. 368x112x2 is 82,432 bytes, which this
 * part will hand out of internal SRAM with the USB stack up; a whole panel there would not fit. */
#define SRAM_BAND_ROWS 112
static uint16_t *sram_band = nullptr;

/* A cheap checksum that notices a single flipped bit. Not cryptographic; it does not need to be. */
static uint32_t checksum(const uint16_t *pixels, uint32_t count) {
  uint32_t sum = 2166136261u;
  for (uint32_t i = 0; i < count; i++) {
    sum ^= pixels[i];
    sum *= 16777619u;
  }
  return sum;
}

/*
 * Flat blocks, one pixel white rules between them, a distinct colour per cell.
 *
 * The colour is derived from the cell's own row and column, so a block that arrives from the wrong
 * source offset is a visibly wrong colour rather than a plausible one. `phase` shifts the palette
 * each pass, so a block that stops updating is as obvious as one that updates wrongly.
 */
static void paint_pattern(uint16_t *into, uint16_t rows, uint16_t rowOffset, uint8_t phase) {
  const uint16_t cell = 46;
  for (uint16_t y = 0; y < rows; y++) {
    const uint16_t panelY = (uint16_t)(y + rowOffset);
    for (uint16_t x = 0; x < PANEL_WIDTH; x++) {
      uint16_t colour;
      if ((panelY % cell) == 0 || (x % cell) == 0) {
        colour = 0xFFFF; /* the rules */
      } else {
        const uint8_t cx = (uint8_t)(x / cell);
        const uint8_t cy = (uint8_t)(panelY / cell);
        const uint8_t r = (uint8_t)((cx * 5 + phase) & 0x1F);
        const uint8_t g = (uint8_t)((cy * 9 + phase * 2) & 0x3F);
        const uint8_t b = (uint8_t)((cx + cy * 3 + phase) & 0x1F);
        colour = (uint16_t)((r << 11) | (g << 5) | b);
      }
      into[(uint32_t)y * PANEL_WIDTH + x] = colour;
    }
  }
}

static void label(const char *text, int16_t y, uint16_t colour) {
  gfx->setTextSize(2);
  gfx->setTextColor(colour, RGB565_BLACK);
  /* 20px in: the panel's corners are rounded and the framebuffer's are not. */
  gfx->setCursor(20, y);
  gfx->print(text);
}

static int te_activity(uint16_t ms) {
  pinMode(TE_PIN, INPUT);
  int last = digitalRead(TE_PIN);
  int changes = 0;
  uint32_t until = millis() + ms;
  while (millis() < until) {
    const int now = digitalRead(TE_PIN);
    if (now != last) {
      changes++;
      last = now;
    }
  }
  return changes;
}

void setup() {
  Serial.begin(115200);
  const uint32_t waited = millis();
  while (!Serial && millis() - waited < 3000) delay(10);

  Serial.println("psram: PSRAM vs internal SRAM, as a source for draw16bitRGBBitmap");
  Serial.printf("psram: psram total %u free %u\n", (unsigned)ESP.getPsramSize(),
                (unsigned)ESP.getFreePsram());

  psram_frame = (uint16_t *)heap_caps_malloc(PANEL_PIXELS * 2u, MALLOC_CAP_SPIRAM);
  sram_band = (uint16_t *)heap_caps_malloc((size_t)SRAM_BAND_ROWS * PANEL_WIDTH * 2u,
                                           MALLOC_CAP_INTERNAL);
  Serial.printf("psram: framebuffer in psram %s, band in internal %s\n",
                psram_frame != nullptr ? "ok" : "FAILED", sram_band != nullptr ? "ok" : "FAILED");
  if (psram_frame == nullptr || sram_band == nullptr) {
    for (;;) {
      Serial.println("psram: no memory; nothing to measure");
      delay(2000);
    }
  }

  if (!gfx->begin()) {
    for (;;) {
      Serial.println("psram: gfx->begin() failed");
      delay(2000);
    }
  }
  bus->beginWrite();
  bus->writeC8D8(0x35, 0x00); /* tearing effect on, so the refresh is measurable */
  bus->endWrite();
  gfx->fillScreen(RGB565_BLACK);
  gfx->setBrightness(200);
  Serial.printf("psram: tearing activity %d/150ms\n", te_activity(150));
}

void loop() {
  static uint8_t phase = 0;
  static uint32_t pass = 0;
  pass++;

  /* 1. Write the pattern into PSRAM once, and remember what it should be. */
  paint_pattern(psram_frame, PANEL_HEIGHT, 0, phase);
  const uint32_t wrote = checksum(psram_frame, PANEL_PIXELS);

  /* 2. Blit it from PSRAM in four band sizes, largest first. */
  const uint16_t bands[4] = {PANEL_HEIGHT, 224, 112, 28};
  for (uint8_t b = 0; b < 4; b++) {
    const uint16_t rows = bands[b];
    gfx->draw16bitRGBBitmap(0, 0, psram_frame, PANEL_WIDTH, rows);
    delay(250);
  }

  /* 3. The same pattern, same size, out of internal SRAM instead. This is the A/B. */
  paint_pattern(sram_band, SRAM_BAND_ROWS, 0, phase);
  gfx->draw16bitRGBBitmap(0, PANEL_HEIGHT - SRAM_BAND_ROWS, sram_band, PANEL_WIDTH, SRAM_BAND_ROWS);
  label("bottom band: from INTERNAL SRAM", PANEL_HEIGHT - SRAM_BAND_ROWS + 8, RGB565_BLACK);
  label("above: from PSRAM", 8, RGB565_BLACK);

  /* 4. Did the buffer itself survive being read? */
  const uint32_t after = checksum(psram_frame, PANEL_PIXELS);
  Serial.printf("psram: pass %u, checksum %s (wrote %08X, read back %08X), te %d/150ms\n",
                (unsigned)pass, wrote == after ? "STABLE" : "DRIFTED", (unsigned)wrote,
                (unsigned)after, te_activity(150));

  phase = (uint8_t)(phase + 3);
  delay(1200);
}
