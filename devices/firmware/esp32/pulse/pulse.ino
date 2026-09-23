/*
 * Anchor Pulse on LVGL, on an ESP32-S3, with nothing on the cable.
 *
 * The board is the same one `app/` runs on — a **Waveshare ESP32-S3-Touch-AMOLED-1.8, V2**: an
 * ESP32-S3 N16R8, 16 MB flash, 8 MB octal PSRAM, a 368x448 AMOLED behind a CO5300 on QSPI, and a
 * CST820 touch controller on I2C at SDA=15/SCL=14. Every pin, offset and quirk below is read out of
 * `app/app.ino` and `app/sensors.cpp` rather than rediscovered; those two files are the record of
 * what this hardware actually does, and this sketch does not get to have a second opinion.
 *
 * ## Why there are two firmwares
 *
 * `app/` is a framebuffer blitter. The desktop renders an Anchor surface — in the user's live
 * Omarchy theme, in the user's fontconfig monospace — and ships pixels down the USB cable; the
 * device owns no font, no palette and no layout. `docs/devices-esp32.md` argues that at length and
 * the argument is still sound. It is also, for these units, beside the point: they have to work in
 * the field, untethered, and a blitter with no host on the cable is a dark panel.
 *
 * The doc names this case and leaves it open — a standalone renderer for real portfolio data with
 * no host present is "a separate, larger call". Ryan made it, and this is that renderer.
 *
 * **`app/` is untouched and stays the one that works** until this is proven on glass. That is not
 * caution for its own sake: there is a deadline on `app/`, another agent is adding a data module to
 * it right now, and nothing here has been flashed. This sketch compiles and it renders in the host
 * simulator; no pixel of it has been seen on the panel.
 *
 * ## What is where
 *
 *   `lv_conf.h`        LVGL's configuration, and a long comment about how Arduino finds it
 *   `pulse_ui.{h,cpp}` the screen, in LVGL objects, with no Arduino in it so the simulator shares it
 *   `pulse_touch.*`    the CST820 as the pressed/released stream LVGL wants, and why not `poll()`
 *   `sensors_link.cpp` one include, so `app/sensors.cpp` compiles in without being copied
 *   `../sim/lvgl.sh`   all of the above on the desktop, writing PNGs, with no board attached
 *
 * This file is the part that only a board can have: a panel, a clock, two buffers and a light.
 */

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include <lvgl.h>

#include "pulse_touch.h"
#include "../app/feed.h"
#include "pulse_feed_view.h"
#include "pulse_explore.h"
#include "pulse_power.h"
#include "pulse_ui.h"
#include "pulse_wifi.h"

/* ------------------------------------------------------------------------------- the panel ---- */

#define PANEL_WIDTH 368
#define PANEL_HEIGHT 448

/*
 * The display, from the vendor's `pin_config.h` for V2 hardware, by way of `app/app.ino`.
 *
 * There is no reset pin — the vendor's own example passes `GFX_NOT_DEFINED`, which is what the probe
 * found the hard way. The 16 is a column offset, because a CO5300 addresses a wider frame than this
 * panel exposes; getting it wrong shifts every pixel sideways and wraps the right edge, which looks
 * like a rendering bug and is not one.
 */
#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define TE_PIN 13

static Arduino_DataBus *panel_bus =
    new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
static Arduino_CO5300 *panel = new Arduino_CO5300(panel_bus, GFX_NOT_DEFINED, 0 /* rotation */,
                                                  (int16_t)PANEL_WIDTH, (int16_t)PANEL_HEIGHT, 16, 0,
                                                  0, 0);
static bool panel_ready = false;
static uint8_t brightness_percent = 70;

static void set_backlight(uint8_t percent) {
  if (!panel_ready) return;
  if (percent > 100) percent = 100;
  panel->setBrightness((uint8_t)((uint32_t)percent * 255u / 100u));
}

/*
 * Turn the tearing-effect line on, and why it is worth a line of code.
 *
 * The panel drives GPIO 13 once per refresh when this is enabled, and Arduino_GFX's init does not
 * enable it. That signal is how anything here can tell a running panel from a dark one without a
 * human looking at the desk — and reading its absence as "the panel is dark" is a mistake this
 * project has already made once, in both directions. On a firmware that draws its own screen it
 * matters more, not less: a wrong colour and a dead panel are the same picture from a keyboard.
 */
static void enable_tearing(void) {
  panel_bus->beginWrite();
  panel_bus->writeC8D8(0x35, 0x00);
  panel_bus->endWrite();
}

/* Transitions on the tearing line: a measurement of whether the panel is actually refreshing. The
 * healthy figure measured by `panel/` on this board is 34-36 per 150 ms, from a ~58 Hz signal. */
static int te_activity(uint16_t ms) {
  pinMode(TE_PIN, INPUT);
  int last = digitalRead(TE_PIN);
  int changes = 0;
  uint32_t until = millis() + ms;
  while (millis() < until) {
    int now = digitalRead(TE_PIN);
    if (now != last) {
      changes++;
      last = now;
    }
  }
  return changes;
}

/* --------------------------------------------------------------------------- LVGL's display ---- */

/*
 * The draw buffer: one, 96 rows tall, in PSRAM.
 *
 * **One and not two.** LVGL's double buffering earns its keep when the flush is asynchronous — DMA
 * out of one buffer while the renderer fills the other. This flush is a blocking `draw16bitRGBBitmap`
 * with no OS underneath it (`LV_USE_OS LV_OS_NONE`), so the second buffer would be 70 kB that is
 * never written to while anything is reading it. Say what it would buy before spending it.
 *
 * **96 rows and not the whole panel.** A full-screen buffer costs 329,728 bytes and, more to the
 * point, `LV_DISPLAY_RENDER_MODE_FULL` pushes the entire panel on every refresh — `app/` measured
 * exactly that at 105 ms per commit before it started sending only the rows that changed. In partial
 * mode LVGL hands the flush the invalidated rectangle, so the footer's ticking age costs a strip a
 * few hundred pixels wide rather than a whole frame. 96 rows is 70,656 bytes and covers the tallest
 * single row of this layout in one pass, which keeps the common repaint to one address-window setup.
 *
 * **In PSRAM**, for the reason `app/app.ino` gives about the framebuffer: internal SRAM is the
 * scarce thing on this part once the USB stack has taken its share, and there are 7,943,664 bytes
 * free in PSRAM at boot. The cost is real and unmeasured — PSRAM is on a slower bus than the CPU's
 * own RAM, and LVGL *renders* into this buffer rather than merely streaming through it, which is the
 * opposite of the tile buffer's access pattern. If the refresh rate on glass disappoints, moving
 * this one allocation to `MALLOC_CAP_INTERNAL` is the first thing to try; 70 kB is plausible there
 * and the fallback below already does it when PSRAM is absent.
 */
#define DRAW_BUFFER_LINES 96
#define DRAW_BUFFER_BYTES ((size_t)PANEL_WIDTH * DRAW_BUFFER_LINES * 2u)

static uint8_t *draw_buffer = nullptr;
static bool draw_buffer_in_psram = false;
/*
 * What was actually allocated, not what was asked for.
 *
 * The banner printed `DRAW_BUFFER_BYTES` at first, which is the constant and therefore always right
 * and sometimes a lie: with PSRAM refused, `setup()` falls back to a quarter-height buffer and the
 * banner cheerfully reported 70,656 bytes of a 17,664-byte allocation. The simulator's `--no-psram`
 * run is where that showed up, and it is the same class of mistake `app/app.ino` records against its
 * receive buffer — "a buffer you believe in is not a buffer you measured".
 */
static size_t draw_buffer_bytes = 0;
static int draw_buffer_lines = 0;
static lv_display_t *display = nullptr;
static lv_indev_t *pointer = nullptr;
static bool presented = false;

/*
 * LVGL's clock. `lv_tick_set_cb` rather than calling `lv_tick_inc()` from a timer: this sketch has
 * no interrupt of its own and `millis()` is already the monotonic millisecond counter LVGL wants, so
 * handing it the function is strictly fewer moving parts than maintaining a second counter that can
 * drift from the first.
 */
static uint32_t lv_tick_from_millis(void) {
  return millis();
}

/*
 * The flush: LVGL's rendered rectangle, onto the CO5300.
 *
 * ## Byte order — determined, not assumed
 *
 * **No swap is needed, and here is how that was established rather than hoped.** Three things had to
 * agree, and all three were read rather than remembered:
 *
 *   1. LVGL is built `LV_COLOR_DEPTH 16` with no swap option enabled, so `px_map` holds RGB565 as
 *      native `uint16_t` values — on this part, little-endian in memory.
 *   2. `Arduino_TFT::draw16bitRGBBitmap` takes `uint16_t *` and passes it to
 *      `Arduino_DataBus::writePixels`, which is documented by its own signature as taking pixel
 *      *values*, not bytes.
 *   3. `Arduino_ESP32QSPI::writePixels` (`databus/Arduino_ESP32QSPI.cpp`) does the byte-order work
 *      itself: every pixel goes through `MSB_32_16_16_SET`/`MSB_16_SET` into the transmit buffer,
 *      which is exactly the high-byte-first packing the panel wants. Handing it pre-swapped values
 *      would produce a *second* swap and a screen of wrong colours.
 *
 * `app/app.ino` relies on the same property from the other end — it hands the driver a framebuffer
 * the host filled as `ANCHOR_PIXEL_RGB565_LE` with "no pass over 329,728 bytes to swap them" — so
 * this is the established behaviour of this driver on this board rather than a fresh guess.
 *
 * What would falsify it: the screen would come up with blues where the reds are, and the fix would
 * be one call to `lv_draw_sw_rgb565_swap(px_map, w * h)` before the blit. That is cheap to try and
 * has deliberately *not* been left in "just in case", because a swap that is wrong in one direction
 * looks identical to a swap that is wrong in the other, and a commented-out line invites a coin
 * flip instead of a look. **Not verified on glass**: colour fidelity is on the doc's unmeasured
 * list for this board and this does not take it off.
 *
 * The cast to `uint16_t *` is safe because LVGL aligns the draw buffer to `LV_DRAW_BUF_ALIGN` (4)
 * and hands out areas starting at the buffer's own base in partial mode.
 */
/*
 * Wait for the panel to finish scanning before writing over what it is scanning.
 *
 * The CO5300 pulses GPIO 13 once per refresh when tearing-effect is enabled, which `setup()` turns
 * on. Until now nothing read it during a flush: LVGL handed over a rectangle and it went straight
 * down the QSPI bus, whenever that happened to be. Write to a line the controller is in the middle
 * of sending and the top of the region shows the old frame while the bottom shows the new one, one
 * scan apart — on a horizontal run of glyphs that is a shear, and it was reported from the desk as
 * text that "looks italicised, can barely read it". It is not a font problem at all.
 *
 * Waiting for the next edge puts the write in the gap between scans. The bound is the honest part:
 * at roughly 60 Hz an edge is never more than ~17 ms away, so 20 ms is "the line is dead or the
 * panel stopped refreshing" rather than a tight deadline — and in that case this returns and the
 * write happens anyway, because a sheared frame beats a frozen one. `panel/` measured this line
 * healthy at 34-36 transitions per 150 ms, so it is there to be used.
 */
static void wait_for_scan_gap(void) {
  const int start = digitalRead(TE_PIN);
  const uint32_t until = millis() + 20u;
  while (millis() < until) {
    if (digitalRead(TE_PIN) != start) return;
  }
}

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
  if (panel_ready) {
    const int32_t w = area->x2 - area->x1 + 1;
    const int32_t h = area->y2 - area->y1 + 1;
    wait_for_scan_gap();
    panel->draw16bitRGBBitmap((int16_t)area->x1, (int16_t)area->y1, (uint16_t *)px_map, (int16_t)w,
                              (int16_t)h);
  }
  /*
   * The backlight stays down until there is a whole frame to show — the same rule `app/app.ino`
   * holds about never presenting a partly-painted frame on boot, and it applies more here: LVGL's
   * first refresh arrives as several rectangles, so a panel lit before the last one shows a screen
   * being assembled.
   */
  if (!presented && lv_display_flush_is_last(disp)) {
    presented = true;
    set_backlight(brightness_percent);
  }
  lv_display_flush_ready(disp);
}

/*
 * The indev: a level, every refresh period, from `pulse_touch::read()`.
 *
 * LVGL's contract is "where is the finger, and is it down" — not "what gesture happened" — which is
 * the whole reason `pulse_touch` reads the controller rather than wrapping `sensors::poll()`. The
 * header of `pulse_touch.h` has the argument in full.
 *
 * The last coordinate is held across the release on purpose. LVGL raises its click on the release
 * and uses the point it was given at that moment; a released sample carrying (0,0) would fire
 * whatever sits in the top-left corner, every time a finger lifts.
 */
static void touch_read_cb(lv_indev_t *indev, lv_indev_data_t *data) {
  (void)indev;
  static int16_t last_x = 0;
  static int16_t last_y = 0;
  int16_t x = 0;
  int16_t y = 0;
  if (pulse_touch::read(&x, &y)) {
    last_x = x;
    last_y = y;
    data->state = LV_INDEV_STATE_PRESSED;
  } else {
    data->state = LV_INDEV_STATE_RELEASED;
  }
  data->point.x = last_x;
  data->point.y = last_y;
}

/* ---------------------------------------------------------------------------- the reading ---- */

/*
 * What the panel says, today, with nothing feeding it.
 *
 * These are the figures from `review/devices/pulse-amoled.png`'s sibling state — the design target
 * for this screen — and they are hard-coded because the thing that will replace them does not exist
 * yet: a data module (`feed.{h,cpp}`) is being written in `app/` by another agent as this lands. The
 * seam is `pulse_ui::Reading`, which takes formatted strings precisely so that whatever produces
 * them owns the formatting.
 *
 * **This is placeholder data and the panel must never be mistaken for live.** That is what the
 * footer is for: it counts up from boot, so a screen nobody has fed says how old its reading is and
 * keeps saying it. A number with no age on it is the failure `theme/README.md` principle 6 names,
 * and the one this project has already shipped once.
 */
static pulse_ui::Screen screen;

static uint32_t booted_at_ms = 0;
static char age_text[24] = "just now";

/* ------------------------------------------------------------------------------ the feed ------ */

/*
 * `feed::Status` and `pulse_feed_view::Status` are two spellings of one enum, and this is what
 * keeps them one.
 *
 * The view is compiled by the desktop simulator, which has no TLS stack and no business acquiring
 * one, so it cannot include `feed.h`. Mirroring the enum by value is the price of that separation;
 * mirroring it *silently* would be the bug, because a reorder on either side would remap every
 * state to its neighbour and a unit that failed to join would announce that it was fetching.
 */
static_assert((int)feed::Status::Disabled == (int)pulse_feed_view::Status::Disabled, "feed enum drift");
static_assert((int)feed::Status::NoCredentials == (int)pulse_feed_view::Status::NoCredentials,
              "feed enum drift");
static_assert((int)feed::Status::Joining == (int)pulse_feed_view::Status::Joining, "feed enum drift");
static_assert((int)feed::Status::Online == (int)pulse_feed_view::Status::Online, "feed enum drift");
static_assert((int)feed::Status::Fetching == (int)pulse_feed_view::Status::Fetching, "feed enum drift");
static_assert((int)feed::Status::Failed == (int)pulse_feed_view::Status::Failed, "feed enum drift");
static_assert((int)feed::Status::NoWallets == (int)pulse_feed_view::Status::NoWallets,
              "feed enum drift");

/*
 * How long each trending token holds the screen.
 *
 * The same six seconds the desktop uses for its own rotations, and the same trick: the index comes
 * from a clock rather than a counter, so several units on one table agree with each other without
 * any of them talking. They are not synchronised to the *desktop* here — this device is untethered
 * and `millis()` starts at its own boot — but two units powered up together stay in step, and that
 * is the property worth having in a room.
 */
constexpr uint32_t ROTATE_MS = 6000;

static uint32_t last_feed_draw_ms = 0;

/* ------------------------------------------------------------------------------ the health line --- */

/*
 * One line a minute on Serial, for endurance and battery runs.
 *
 * The boot banner reports memory once, before any TLS request has run, so it cannot show a leak or
 * how close the fetch worker's stack comes to its limit. This line can: `heap_min` is the lowest the
 * internal heap has ever been, `worker_stack_min` is the fetch task's high-water mark, and a
 * `lv_largest` that keeps shrinking is fragmentation in the LVGL pool. Capture it with any serial
 * monitor over a long session, then compare the first and last lines.
 *
 * Integers and compiled-in words only. Nothing that came off the network is printed here.
 */
static constexpr uint32_t HEALTH_MS = 60000;
static uint32_t last_health_ms = 0;

static const char *status_name(feed::Status status) {
  switch (status) {
    case feed::Status::Disabled: return "disabled";
    case feed::Status::NoCredentials: return "no-wifi";
    case feed::Status::Joining: return "joining";
    case feed::Status::Online: return "online";
    case feed::Status::Fetching: return "fetching";
    case feed::Status::Failed: return "failed";
    case feed::Status::NoWallets: return "no-wallets";
  }
  return "unknown";
}

static void report_health() {
  lv_mem_monitor_t mem;
  lv_mem_monitor(&mem);
  const feed::Snapshot snap = feed::snapshot();
  const pulse_power::Battery &battery = pulse_power::state();
  Serial.printf(
      "anchor-pulse-lvgl: health up=%lus heap=%u largest=%u heap_min=%u psram=%u lv_free=%u "
      "lv_largest=%u lv_used=%u%% worker_stack_min=%lu http=%d trending=%s portfolio=%s "
      "battery=%d%%%s\n",
      (unsigned long)(millis() / 1000u), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
      (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram(),
      (unsigned)mem.free_size, (unsigned)mem.free_biggest_size, (unsigned)mem.used_pct,
      (unsigned long)snap.workerStackFreeBytes, snap.lastHttpCode, status_name(snap.status),
      status_name(snap.portfolioStatus), (int)battery.percent,
      battery.usb ? (battery.charging ? " usb charging" : " usb") : "");
}

/*
 * Pull what the feed knows onto the screen.
 *
 * Called on a beat rather than on change, because "how old is this" changes every second even when
 * nothing else does, and a panel that stops counting looks like a panel that stopped.
 */
static void refresh_feed(void) {
  /*
   * One snapshot, and it outlives this function on purpose.
   *
   * `feed::snapshot()` copies everything out under one spinlock precisely so that the total, the
   * coverage label that qualifies it and the age that dates it cannot come from three different
   * moments. Calling it twice here — once for the portfolio and once for the tokens — would throw
   * that away for no gain.
   *
   * **`static`, because `screen` keeps pointers into it.** `pulse_ui::Reading` holds `const char *`
   * rather than buffers (see `pulse_ui.h` for why), so the composed screen points at these strings,
   * and `screen` is a file-static that `refresh_age()` re-applies up to four seconds later when the
   * touch readout expires. With this on the stack that second `update()` reads a frame that has been
   * gone since the function returned — which would usually look like nothing at all, and
   * occasionally like a garbled price. It costs ~600 bytes of `.bss` and takes the same amount off
   * an 8 KB loop-task stack.
   */
  static feed::Snapshot snap;
  snap = feed::snapshot();

  static pulse_feed_view::Token view_tokens[feed::MAX_TOKENS];
  for (size_t i = 0; i < snap.count && i < feed::MAX_TOKENS; i++) {
    view_tokens[i].symbol = snap.tokens[i].symbol;
    view_tokens[i].name = snap.tokens[i].name;
    view_tokens[i].price = snap.tokens[i].price;
    view_tokens[i].change = snap.tokens[i].change;
    view_tokens[i].changePositive = snap.tokens[i].changePositive;
    view_tokens[i].chain = snap.tokens[i].chain;
    view_tokens[i].address = snap.tokens[i].address;
    view_tokens[i].volume = snap.tokens[i].volume;
  }

  pulse_feed_view::Trending trending;
  trending.status = (pulse_feed_view::Status)snap.status;
  trending.reason = snap.reason;
  trending.tokens = view_tokens;
  trending.count = snap.count;
  trending.ageMs = snap.ageMs;
  trending.everSucceeded = snap.everSucceeded;

  /*
   * The portfolio, by pointer into `snap` — which lives until this function returns, and the screen
   * it composes is redrawn from scratch on the next pass. The strings themselves were formatted in
   * `feed.cpp` at fetch time; nothing here parses, rounds or re-decides anything about them.
   */
  pulse_feed_view::Portfolio portfolio;
  portfolio.status = (pulse_feed_view::Status)snap.portfolioStatus;
  portfolio.reason = snap.portfolioReason;
  portfolio.total = snap.portfolio.total;
  portfolio.nftValue = snap.portfolio.nftValue;
  portfolio.change = snap.portfolio.change;
  portfolio.changePositive = snap.portfolio.changePositive;
  portfolio.haveChange = snap.portfolio.haveChange;
  portfolio.covered = snap.portfolio.covered;
  portfolio.configured = snap.portfolio.configured;
  portfolio.ageMs = snap.portfolioAgeMs;
  portfolio.everSucceeded = snap.portfolioEverSucceeded;

  screen = pulse_feed_view::compose(trending, portfolio, millis() / ROTATE_MS);
  pulse_explore::update(trending, portfolio, millis());
  pulse_ui::update(screen);
}

/* ------------------------------------------------------------------- the calibration readout --- */

/*
 * A touch puts its own coordinate in the footer for four seconds, and prints it.
 *
 * This is the only thing a tap does on this screen, and it is deliberately a **diagnostic rather
 * than a product behaviour**. There is no second page to turn to yet and inventing one here would
 * be inventing what the device is for; what there *is* is an open question that a person with a
 * finger and a lit panel can close in ten seconds, and nothing else can:
 *
 *   `docs/devices-esp32.md` records the CST820 on this board answering its identity registers and
 *   **never once answering with a coordinate**. So `pulse_touch.cpp` maps raw x and y straight
 *   through, with a comment saying it is the identity mapping because there is no measurement to
 *   base a transform on. Whoever flashes this first can read the answer off the glass: touch the
 *   top-left corner and the footer should say a small x and a small y. If it says nothing, the
 *   controller is still silent. If the numbers are mirrored or transposed, `mapX`/`mapY` is the one
 *   function to change, and the numbers to change it with are on the screen.
 *
 * It goes through LVGL's event system rather than reading `pulse_touch::read()` a second time from
 * `loop()`, which matters: what this reports is the coordinate **LVGL resolved and dispatched**, not
 * a raw sample the UI might never have seen. A calibration readout that bypasses the thing being
 * calibrated would be the "control that cannot fail" AGENTS.md warns about.
 */
constexpr uint32_t TOUCH_READOUT_MS = 4000;
static int32_t touch_x = 0;
static int32_t touch_y = 0;
static uint32_t touched_at_ms = 0;
static bool ever_touched = false;

static void on_touch(lv_event_t *event) {
  (void)event;
  lv_indev_t *indev = lv_indev_active();
  if (indev == nullptr) return;
  lv_point_t point;
  lv_indev_get_point(indev, &point);
  touch_x = point.x;
  touch_y = point.y;
  touched_at_ms = millis();
  ever_touched = true;
  Serial.printf("anchor-pulse-lvgl: touch at %d,%d\n", (int)point.x, (int)point.y);
}

/*
 * The bottom line, which has two claimants and one of them wins for four seconds.
 *
 * Both archetypes have exactly one: the reading's age, and the status's note. `pulse_ui::setFooter`
 * writes to whichever is up, which is why this function does not have to know which kind of screen
 * is showing. The age itself belongs to the feed — it is the age of the *reading*, the only age
 * worth printing next to a number — and `pulse_feed_view::compose` sets it.
 *
 * What survives here is the calibration readout: a touch replaces that line with its own coordinate
 * briefly, because the open question about this board is still whether the CST820 ever answers at
 * all, and the person who can close it is holding the unit. It is rewritten every pass rather than
 * once, because `refresh_feed` runs twice a second and re-applies the screen underneath it.
 *
 * Before the feed existed this also counted up from boot, so that placeholder figures could never be
 * mistaken for live ones. There are no placeholder figures now — an unfed screen says what it is
 * waiting for instead — so that job is done and the count is gone with it.
 */
static void refresh_age(void) {
  if (!ever_touched) return;
  if ((millis() - touched_at_ms) >= TOUCH_READOUT_MS) {
    /* Hand the line back to whatever the screen itself wanted there, once, rather than every pass.
     * Through `update()` rather than `setFooter()` so that a status whose note is empty goes back to
     * being a centred composition with nothing at the bottom, instead of an empty visible label. */
    if (age_text[0] != '\0') {
      age_text[0] = '\0';
      pulse_ui::update(screen);
    }
    return;
  }
  snprintf(age_text, sizeof(age_text), "touch %d,%d", (int)touch_x, (int)touch_y);
  pulse_ui::setFooter(age_text);
}

/* -------------------------------------------------------------------------------- banner ------ */

/*
 * What is on this board, printed once at boot.
 *
 * Unlike `app/`, `Serial` here is not the protocol — nothing decodes a wire format in this sketch —
 * so printing is free and there is no rule against it. It is kept anyway to the same shape as
 * `app/`'s banner, because these two firmwares will be compared against each other on the same desk
 * and a boot log that reads differently is a difference somebody will chase.
 *
 * The two lines worth having are the last two. `lv_mem_monitor` is the only honest source for what
 * `LV_MEM_SIZE` should be — the 256 kB in `lv_conf.h` is headroom, not a measurement, and this is
 * how it stops being one. The tearing count is the panel answering for itself.
 */
static void banner(void) {
  Serial.printf("anchor-pulse-lvgl: firmware up, lvgl %d.%d.%d\n", LVGL_VERSION_MAJOR,
                LVGL_VERSION_MINOR, LVGL_VERSION_PATCH);
  Serial.printf("anchor-pulse-lvgl: chip %s rev %d, %d core(s), %d MHz\n", ESP.getChipModel(),
                ESP.getChipRevision(), ESP.getChipCores(), ESP.getCpuFreqMHz());
  Serial.printf("anchor-pulse-lvgl: flash %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("anchor-pulse-lvgl: psram total %u free %u\n", (unsigned)ESP.getPsramSize(),
                (unsigned)ESP.getFreePsram());
  Serial.printf("anchor-pulse-lvgl: internal heap free %u largest %u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  Serial.printf("anchor-pulse-lvgl: panel CO5300 %dx%d, %s\n", PANEL_WIDTH, PANEL_HEIGHT,
                panel_ready ? "up" : "DID NOT COME UP");
  Serial.printf("anchor-pulse-lvgl: draw buffer %u bytes (%d lines) in %s\n",
                (unsigned)draw_buffer_bytes, draw_buffer_lines,
                draw_buffer_in_psram ? "psram" : "internal");
  {
    lv_mem_monitor_t monitor;
    lv_mem_monitor(&monitor);
    Serial.printf("anchor-pulse-lvgl: lv_mem %u total, %u free, %u%% used, %u%% frag\n",
                  (unsigned)monitor.total_size, (unsigned)monitor.free_size,
                  (unsigned)monitor.used_pct, (unsigned)monitor.frag_pct);
  }
  Serial.printf("anchor-pulse-lvgl: tearing activity %d/150ms (34-36 is healthy on this panel)\n",
                te_activity(150));
  Serial.printf("anchor-pulse-lvgl: waveshare esp32-s3-touch-amoled-1.8 v2\n");
  Serial.flush();
}

/* ---------------------------------------------------------------------------------- boot ------- */

void setup() {
  Serial.begin(115200);
  // Without this a write blocks forever whenever no host has the port open, which on a device whose
  // whole point is that it needs no host would be a hang on the first `printf`.
  Serial.setTxTimeoutMs(0);

  /*
   * Bring the panel up before anything can ask to paint on it. `begin()` runs the CO5300
   * initialisation sequence, which is also what recovers the controller from any state it was left
   * in — including asleep, which is where an early pin sweep once left this board for a session.
   */
  panel_ready = panel->begin();
  if (panel_ready) {
    enable_tearing();
    panel->fillScreen(0);
  }
  set_backlight(0);

  /*
   * Internal SRAM first now, PSRAM as the fallback — the opposite of what this did, and of what
   * `app/` does with its framebuffer.
   *
   * The two buffers have opposite access patterns and only one of them was thought about here. The
   * blitter's framebuffer is *streamed*: written once by a memcpy and read once by the DMA, so
   * PSRAM's latency is amortised over long sequential bursts and its size is what matters. LVGL
   * *renders* into this one — glyph by glyph, blend by blend, with random access all over it — and
   * every one of those touches pays PSRAM's latency in full.
   *
   * On the glass that was reported as a panel that "feels laggy", alongside text that looked sheared.
   * The comment above `DRAW_BUFFER_LINES` had already named this as the first thing to try if the
   * refresh disappointed, which it now has. 70,656 bytes against the 249,844 largest free internal
   * block the boot banner reports is a comfortable fit.
   *
   * PSRAM stays as the fallback rather than a smaller internal buffer, because a slow whole-height
   * buffer beats a fast quarter-height one: a shorter buffer means more flushes per refresh, and
   * every flush is another chance to catch the panel mid-scan.
   */
  draw_buffer = (uint8_t *)heap_caps_malloc(DRAW_BUFFER_BYTES, MALLOC_CAP_INTERNAL);
  draw_buffer_in_psram = false;
  draw_buffer_bytes = DRAW_BUFFER_BYTES;
  draw_buffer_lines = DRAW_BUFFER_LINES;
  if (draw_buffer == nullptr) {
    draw_buffer = (uint8_t *)heap_caps_malloc(DRAW_BUFFER_BYTES, MALLOC_CAP_SPIRAM);
    draw_buffer_in_psram = draw_buffer != nullptr;
  }
  if (draw_buffer == nullptr) {
    draw_buffer_lines = 24;
    draw_buffer_bytes = (size_t)PANEL_WIDTH * (size_t)draw_buffer_lines * 2u;
    draw_buffer = (uint8_t *)heap_caps_malloc(draw_buffer_bytes, MALLOC_CAP_INTERNAL);
  }
  if (draw_buffer == nullptr) {
    // Nothing useful is possible; say so on a loop rather than pretending to be a display.
    for (;;) {
      Serial.println("anchor-pulse-lvgl: no memory for a draw buffer");
      delay(1000);
    }
  }

  lv_init();
  lv_tick_set_cb(lv_tick_from_millis);

  display = lv_display_create(PANEL_WIDTH, PANEL_HEIGHT);
  lv_display_set_flush_cb(display, flush_cb);
  lv_display_set_buffers(display, draw_buffer, nullptr, (uint32_t)draw_buffer_bytes,
                         LV_DISPLAY_RENDER_MODE_PARTIAL);
  /*
   * Every flushed rectangle is snapped to an even column, and this is why text looked italic.
   *
   * The CO5300 is written by setting a column window (`CASET`) and streaming pixels into it, and
   * `Arduino_CO5300::writeAddrWindow` passes whatever x and width it is given straight through with
   * no alignment. This panel family wants those on even columns: give it an odd one and the
   * controller's own write pointer advances at a different rate from the data being fed to it, so
   * each row lands a pixel further across than the last. Down a block of text that is a progressive
   * shear — which is precisely what "networks, strongest first" looked like on the glass, and why it
   * was described as italics rather than as corruption. It is neither a font nor a style: it is the
   * same glyphs, drawn with every row offset from the one above.
   *
   * It explains the part that made no sense from here, too — why only *some* elements slanted. LVGL
   * invalidates the bounding box of whatever changed, so whether a given label shears at all comes
   * down to whether its box happened to land on an odd column. A subtitle that redraws on its own is
   * a small odd rectangle; a whole screen repaint starts at zero and is even.
   *
   * `x1 &= ~1` and `x2 |= 1` widen every area outward to even boundaries, which costs at most two
   * columns of redraw and cannot lose pixels. The simulator could never have caught this: it writes
   * into a framebuffer, and a framebuffer does not care where a rectangle starts.
   */
  lv_display_add_event_cb(
      display,
      [](lv_event_t *event) {
        lv_area_t *area = (lv_area_t *)lv_event_get_param(event);
        if (area == nullptr) return;
        area->x1 &= ~1;
        area->x2 |= 1;
      },
      LV_EVENT_INVALIDATE_AREA, nullptr);

  /*
   * Touch before the screen, because `pulse_touch::begin()` is where `sensors::begin()` runs and
   * that is what brings `Wire` up at all. It also takes 170 ms of vendor-specified reset timing,
   * which is better spent behind a dark panel than between the first frame and the backlight.
   */
  pulse_touch::begin();
  pointer = lv_indev_create();
  lv_indev_set_type(pointer, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(pointer, touch_read_cb);
  lv_indev_set_display(pointer, display);

  booted_at_ms = millis();

  /*
   * The feed before the screen, so the first frame drawn is already the truth.
   *
   * `begin()` only reads NVS and starts the worker; it joins nothing and fetches nothing yet, so it
   * costs the boot nothing. Composing the reading from a real snapshot before `build()` means a
   * unit with no network typed into it opens saying "wi-fi / not set up" rather than opening on a
   * placeholder and correcting itself a moment later — which on a device somebody is holding is the
   * difference between an answer and a flicker.
   */
  feed::begin();
  refresh_feed();
  pulse_ui::build(screen);

  /*
   * The battery and the only way to switch this unit off.
   *
   * After `build()`, because the gesture attaches to a chip the screen owns. It is a hold rather
   * than a tap, on a child object rather than the frame, so it cannot race Wi-Fi setup's own hold
   * and a sleeve cannot reach it — and it opens a confirmation rather than acting, because a device
   * that powers down in somebody's bag is worse than one nobody can switch off.
   *
   * `pulse_power` writes exactly two bits on the AXP2101, both read-modify-write, and reads
   * everything else. See its header for which vendor driver each register number came from.
   */
  pulse_power::begin();
  pulse_ui::attachPowerGesture(pulse_power::powerOff);

  /*
   * Wi-Fi setup, which owns its own screen and takes over when it needs to.
   *
   * After `pulse_ui::build`, because `attachOpenGesture` needs a surface to attach to and the
   * gesture is a hold on the ambient screen — a deliberate press rather than the five corner taps
   * the old Arduino_GFX module used, which was a gesture nobody would guess and this one is at least
   * discoverable by fidgeting.
   *
   * `begin()` opens the picker by itself on a unit with nothing saved, which is the case that
   * matters: the first thing a stranger does with one of these is turn it on, and the first thing it
   * should do is ask for a network rather than sit there saying it has none.
   */
  pulse_wifi::begin();
  pulse_explore::begin(pulse_wifi::open);
  pulse_ui::onExplore(pulse_explore::open);
  pulse_wifi::attachOpenGesture(pulse_ui::surface());
  /* `LV_EVENT_PRESSED` rather than `LV_EVENT_CLICKED`: a press is reported the moment LVGL decides
   * a finger is down, which is what a calibration readout wants. A click waits for the release and
   * is suppressed entirely if the finger slid off the object, so the one touch most worth seeing —
   * the one that landed in the wrong place — would be the one that reported nothing. */
  lv_obj_add_event_cb(pulse_ui::surface(), on_touch, LV_EVENT_PRESSED, nullptr);

  banner();
}

/* ---------------------------------------------------------------------------------- loop ------- */

void loop() {
  /*
   * `lv_timer_handler()` is the whole runtime: it runs animations, reads the indev and refreshes
   * whatever is invalidated, and it returns the milliseconds until it next wants to be called.
   * Sleeping for that rather than a fixed delay is what keeps an idle screen — which is most of this
   * device's life — off the CPU instead of spinning at the refresh period.
   */
  const uint32_t idle_for = lv_timer_handler();

  /*
   * The feed does its own waiting. `tick()` is millisecond comparisons and a task notification —
   * the fetch itself runs on the other core — so calling it every pass costs nothing and a stalled
   * network cannot freeze the panel. That guarantee is the reason the module was written that way;
   * see `app/feed.h`.
   */
  pulse_wifi::tick();

  /* Polls the PMU on its own slow beat; the battery reading is the only thing on this panel that
   * comes from the board rather than from the network. */
  pulse_power::tick();
  pulse_ui::setBattery(pulse_power::state());

  feed::tick(pulse_wifi::configured(), pulse_wifi::connected(), pulse_wifi::active(),
             pulse_wifi::revision());
  /*
   * Nothing touches the ambient screen while Wi-Fi setup is up.
   *
   * It is a separate LVGL screen rather than an overlay, so writing to `pulse_ui`'s labels
   * underneath would not *look* like anything — which is exactly why it is worth refusing here. The
   * bug it would leave is the one this firmware replaced: a panel drawing something nobody asked for
   * over the thing somebody is using, found only by a person holding it.
   */
  if (!pulse_wifi::active()) {
    if (millis() - last_feed_draw_ms >= 500u) {
      last_feed_draw_ms = millis();
      refresh_feed();
    }
    refresh_age();
  }

  if (millis() - last_health_ms >= HEALTH_MS) {
    last_health_ms = millis();
    report_health();
  }

  delay(idle_for > 20u ? 20u : (idle_for < 1u ? 1u : idle_for));
}
