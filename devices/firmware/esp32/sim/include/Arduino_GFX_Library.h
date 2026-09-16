#ifndef ANCHOR_SIM_ARDUINO_GFX_LIBRARY_H
#define ANCHOR_SIM_ARDUINO_GFX_LIBRARY_H

/*
 * Arduino_GFX, reduced to the primitives this firmware actually draws with, over a plain RGB565
 * framebuffer that can be written out as an image.
 *
 * Shimming the library rather than the panel is a deliberate choice about *where* the seam goes.
 * The Cardputer's simulator compiles the real M5GFX because M5GFX ships an SDL backend; Arduino_GFX
 * has none, so the alternative to this file is either porting a QSPI driver to the desktop — which
 * would simulate the one part of the path that has already been proven on glass — or teaching
 * `wifi_setup.cpp` that it is being simulated, which is the thing a simulator exists to avoid.
 *
 * Two properties make what this draws worth looking at rather than merely worth compiling:
 *
 *   1. **The font is the library's own.** `font/glcdfont.h` is included from the installed
 *      GFX_Library_for_Arduino, not copied here, so the glyphs and the 6x8-per-`textSize` advance
 *      are the panel's rather than an approximation of them. A layout check against a made-up font
 *      is a layout check against a made-up panel.
 *   2. **`print()` wraps exactly where the library wraps.** `Arduino_GFX::write` resets the cursor
 *      to the left margin and drops a line whenever the next character would cross `_max_text_x`,
 *      and `drawChar` clips at the panel edge. Both are transcribed below, because text running off
 *      the right edge is the failure mode a keyboard screen has, and a shim that silently clipped
 *      instead of wrapping would hide exactly the bug the harness is for.
 *
 * Source: GFX_Library_for_Arduino, `src/Arduino_GFX.cpp` (`write`, `drawChar`, the glcdfont path).
 */

#include <cstdint>
#include <string>
#include <vector>

#include "Arduino.h"

#define GFX_NOT_DEFINED (-1)

#define RGB565(r, g, b) ((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
#define RGB565_BLACK RGB565(0, 0, 0)
#define RGB565_WHITE RGB565(248, 252, 248)
#define RGB565_RED RGB565(248, 0, 0)
#define RGB565_GREEN RGB565(0, 128, 0)
#define RGB565_CYAN RGB565(0, 252, 248)
#define RGB565_YELLOW RGB565(248, 252, 0)

/*
 * The bus. `app.ino` writes one command down it — 0x35, the tearing-effect enable the driver's own
 * init does not send — and nothing here has a panel to send it to, so it is recorded and counted.
 * Recorded rather than dropped because "did the firmware enable tearing" is a question this file
 * can answer for free, and a dropped write answers it wrongly and silently.
 */
class Arduino_DataBus {
 public:
  virtual ~Arduino_DataBus() = default;
  void beginWrite() {}
  void endWrite() {}
  void writeC8D8(uint8_t command, uint8_t data);
  int simCommandCount(uint8_t command) const;

 private:
  std::vector<uint16_t> written_;
};

class Arduino_ESP32QSPI : public Arduino_DataBus {
 public:
  Arduino_ESP32QSPI(int8_t cs, int8_t sck, int8_t d0, int8_t d1, int8_t d2, int8_t d3) {
    (void)cs;
    (void)sck;
    (void)d0;
    (void)d1;
    (void)d2;
    (void)d3;
  }
};

/* One text draw, kept so a headless run can say what the panel says without anyone opening a PNG. */
struct GfxTextDraw {
  int16_t x = 0;
  int16_t y = 0;
  uint8_t size = 1;
  bool clipped = false;  // some of it fell off the right edge
  bool wrapped = false;  // the library dropped it onto the next line mid-string
  std::string text;
};

class Arduino_CO5300 {
 public:
  Arduino_CO5300(Arduino_DataBus *bus, int8_t rst, uint8_t rotation, int16_t w, int16_t h,
                 uint8_t col_offset1 = 0, uint8_t row_offset1 = 0, uint8_t col_offset2 = 0,
                 uint8_t row_offset2 = 0);

  bool begin(int32_t speed = GFX_NOT_DEFINED);

  void fillScreen(uint16_t color);
  void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color);
  void fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t radius, uint16_t color);
  void drawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t radius, uint16_t color);
  void draw16bitRGBBitmap(int16_t x, int16_t y, uint16_t *bitmap, int16_t w, int16_t h);

  void setTextSize(uint8_t s);
  void setTextColor(uint16_t c) { textcolor_ = textbgcolor_ = c; }
  void setTextColor(uint16_t c, uint16_t bg) {
    textcolor_ = c;
    textbgcolor_ = bg;
  }
  void setCursor(int16_t x, int16_t y) {
    cursor_x_ = x;
    cursor_y_ = y;
  }
  void setTextWrap(bool w) { wrap_ = w; }
  void print(const char *s);
  void print(const String &s) { print(s.c_str()); }

  void setBrightness(uint8_t brightness);

  /* ------------------------------------------------------------------ the simulator's half ---- */

  int16_t simWidth() const { return width_; }
  int16_t simHeight() const { return height_; }
  uint8_t simBrightness() const { return brightness_; }
  const uint16_t *simPixels() const { return pixels_.data(); }
  /* Cleared by `fillScreen`, so the log is what is on the panel now rather than what ever was. */
  const std::vector<GfxTextDraw> &simText() const { return text_; }
  /* True once `begin()` has run. `app.ino` claims `nopanel` in its HELLO id when it has not. */
  bool simBegun() const { return begun_; }
  bool simWritePpm(const char *path) const;

 private:
  void writePixel(int16_t x, int16_t y, uint16_t color);
  void drawChar(int16_t x, int16_t y, unsigned char c, uint16_t color, uint16_t bg, bool *clipped);
  void write(uint8_t c);

  int16_t width_ = 0;
  int16_t height_ = 0;
  std::vector<uint16_t> pixels_;
  bool begun_ = false;
  uint8_t brightness_ = 0;

  int16_t cursor_x_ = 0;
  int16_t cursor_y_ = 0;
  uint8_t textsize_ = 1;
  uint16_t textcolor_ = 0xFFFF;
  uint16_t textbgcolor_ = 0xFFFF;
  bool wrap_ = true;

  std::vector<GfxTextDraw> text_;
};

#endif /* ANCHOR_SIM_ARDUINO_GFX_LIBRARY_H */
