/*
 * The panel, as 368x448 RGB565 in memory.
 *
 * Everything here is a transcription of GFX_Library_for_Arduino rather than an interpretation of
 * it: the glyph table is the library's own header, the character cell is 6x8 times the text size,
 * `write()` wraps where the library wraps and `drawChar()` clips where it clips. That fidelity is
 * the whole value — a layout check against an approximation of the font is a layout check against
 * an approximation of the panel, and the bug being hunted is one where text runs off an edge.
 */

#include <cmath>
#include <cstdio>

#include "Arduino_GFX_Library.h"

#ifndef pgm_read_byte
#define pgm_read_byte(addr) (*(const unsigned char *)(addr))
#endif

/*
 * The library's own 5x7 table, included rather than copied.
 *
 * `sim/run.sh` finds the installed GFX_Library_for_Arduino — the same library `arduino-cli`
 * compiles the firmware against — and passes the path to its font header in. A copy in this tree
 * would be a second source of truth about what the device draws, which is the mistake
 * `docs/devices-esp32.md` spends a section refusing to make about renderers.
 *
 * It arrives as a macro rather than on the include path on purpose: the library also contains a
 * real `Arduino_GFX_Library.h`, and putting its directory on `-I` would let the firmware's own
 * `#include <Arduino_GFX_Library.h>` resolve to the driver stack instead of this shim, depending on
 * flag order. That failure would be a link error on a good day and a subtly different panel on a
 * bad one.
 */
#ifndef ANCHOR_SIM_FONT_HEADER
#error "define ANCHOR_SIM_FONT_HEADER with the path to GFX_Library_for_Arduino/src/font/glcdfont.h"
#endif
#include ANCHOR_SIM_FONT_HEADER

void Arduino_DataBus::writeC8D8(uint8_t command, uint8_t data) {
  written_.push_back((uint16_t)((command << 8) | data));
}

int Arduino_DataBus::simCommandCount(uint8_t command) const {
  int count = 0;
  for (uint16_t entry : written_) {
    if ((entry >> 8) == command) count++;
  }
  return count;
}

Arduino_CO5300::Arduino_CO5300(Arduino_DataBus *bus, int8_t rst, uint8_t rotation, int16_t w,
                               int16_t h, uint8_t col_offset1, uint8_t row_offset1,
                               uint8_t col_offset2, uint8_t row_offset2) {
  (void)bus;
  (void)rst;
  (void)rotation;
  (void)col_offset1;
  (void)row_offset1;
  (void)col_offset2;
  (void)row_offset2;
  width_ = w;
  height_ = h;
  pixels_.assign((size_t)w * (size_t)h, 0);
}

bool Arduino_CO5300::begin(int32_t speed) {
  (void)speed;
  begun_ = true;
  return true;
}

void Arduino_CO5300::writePixel(int16_t x, int16_t y, uint16_t color) {
  if (x < 0 || y < 0 || x >= width_ || y >= height_) return;
  pixels_[(size_t)y * (size_t)width_ + (size_t)x] = color;
}

void Arduino_CO5300::fillScreen(uint16_t color) {
  for (size_t i = 0; i < pixels_.size(); i++) pixels_[i] = color;
  // The text log describes what is on the panel *now*. A fill is the only thing in this firmware
  // that starts a screen over, so it is where the log resets.
  text_.clear();
}

void Arduino_CO5300::fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) {
  for (int16_t row = 0; row < h; row++) {
    for (int16_t col = 0; col < w; col++) writePixel((int16_t)(x + col), (int16_t)(y + row), color);
  }
}

/* Per-row inset from the circle equation: the same shape the library's corner helpers draw. */
void Arduino_CO5300::fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r,
                                   uint16_t color) {
  if (r < 0) r = 0;
  if (r > w / 2) r = (int16_t)(w / 2);
  if (r > h / 2) r = (int16_t)(h / 2);
  for (int16_t row = 0; row < h; row++) {
    int16_t inset = 0;
    const int16_t dy = row < r ? (int16_t)(r - row) : (row >= h - r ? (int16_t)(row - (h - r) + 1) : 0);
    if (dy > 0) {
      const double span = sqrt((double)r * r - (double)(dy - 0.5) * (dy - 0.5));
      inset = (int16_t)(r - (int16_t)(span + 0.5));
      if (inset < 0) inset = 0;
    }
    for (int16_t col = inset; col < w - inset; col++) {
      writePixel((int16_t)(x + col), (int16_t)(y + row), color);
    }
  }
}

void Arduino_CO5300::drawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r,
                                   uint16_t color) {
  if (r < 0) r = 0;
  if (r > w / 2) r = (int16_t)(w / 2);
  if (r > h / 2) r = (int16_t)(h / 2);
  for (int16_t col = r; col < w - r; col++) {
    writePixel((int16_t)(x + col), y, color);
    writePixel((int16_t)(x + col), (int16_t)(y + h - 1), color);
  }
  for (int16_t row = r; row < h - r; row++) {
    writePixel(x, (int16_t)(y + row), color);
    writePixel((int16_t)(x + w - 1), (int16_t)(y + row), color);
  }
  for (int16_t i = 0; i <= r; i++) {
    const int16_t j = (int16_t)(r - (int16_t)(sqrt((double)r * r - (double)i * i) + 0.5));
    writePixel((int16_t)(x + r - i), (int16_t)(y + j), color);
    writePixel((int16_t)(x + w - 1 - r + i), (int16_t)(y + j), color);
    writePixel((int16_t)(x + r - i), (int16_t)(y + h - 1 - j), color);
    writePixel((int16_t)(x + w - 1 - r + i), (int16_t)(y + h - 1 - j), color);
    writePixel((int16_t)(x + j), (int16_t)(y + r - i), color);
    writePixel((int16_t)(x + j), (int16_t)(y + h - 1 - r + i), color);
    writePixel((int16_t)(x + w - 1 - j), (int16_t)(y + r - i), color);
    writePixel((int16_t)(x + w - 1 - j), (int16_t)(y + h - 1 - r + i), color);
  }
}

void Arduino_CO5300::draw16bitRGBBitmap(int16_t x, int16_t y, uint16_t *bitmap, int16_t w,
                                        int16_t h) {
  for (int16_t row = 0; row < h; row++) {
    for (int16_t col = 0; col < w; col++) {
      writePixel((int16_t)(x + col), (int16_t)(y + row), bitmap[(size_t)row * (size_t)w + col]);
    }
  }
}

void Arduino_CO5300::setTextSize(uint8_t s) {
  textsize_ = s > 0 ? s : 1;
}

void Arduino_CO5300::setBrightness(uint8_t brightness) {
  brightness_ = brightness;
}

/*
 * One character, at the library's own geometry: five columns of the glyph plus a sixth of
 * background, eight rows, each scaled by the text size. The clip tests are the library's — a
 * character that would start past the right or bottom edge is dropped entirely, and one that
 * straddles the edge loses the columns past it.
 */
void Arduino_CO5300::drawChar(int16_t x, int16_t y, unsigned char c, uint16_t color, uint16_t bg,
                              bool *clipped) {
  const int16_t max_x = (int16_t)(width_ - 1);
  const int16_t max_y = (int16_t)(height_ - 1);
  const int16_t block_w = (int16_t)(6 * textsize_);
  const int16_t block_h = (int16_t)(8 * textsize_);
  if (x > max_x || y > max_y || (x + block_w - 1) < 0 || (y + block_h - 1) < 0) {
    if (clipped != nullptr) *clipped = true;
    return;
  }
  if ((x + block_w - 1) > max_x || (y + block_h - 1) > max_y) {
    if (clipped != nullptr) *clipped = true;
  }
  int16_t cur_x = x;
  for (int8_t i = 0; i < 5; ++i, cur_x = (int16_t)(cur_x + textsize_)) {
    if ((cur_x + textsize_ - 1) > max_x) continue;
    uint8_t line = pgm_read_byte(&font[c * 5 + i]);
    int16_t cur_y = y;
    for (int8_t j = 0; j < 8; j++, line >>= 1, cur_y = (int16_t)(cur_y + textsize_)) {
      if ((cur_y + textsize_ - 1) > max_y) continue;
      const uint16_t use = (line & 1) ? color : bg;
      if ((line & 1) == 0 && bg == color) continue;
      for (uint8_t dy = 0; dy < textsize_; dy++) {
        for (uint8_t dx = 0; dx < textsize_; dx++) {
          writePixel((int16_t)(cur_x + dx), (int16_t)(cur_y + dy), use);
        }
      }
    }
  }
  if (bg != color) {  // the sixth column, which is what makes the background opaque
    cur_x = (int16_t)(x + 5 * textsize_);
    if ((cur_x + textsize_ - 1) <= max_x) {
      for (int16_t row = 0; row < block_h; row++) {
        if ((y + row) > max_y) break;
        for (uint8_t dx = 0; dx < textsize_; dx++) {
          writePixel((int16_t)(cur_x + dx), (int16_t)(y + row), bg);
        }
      }
    }
  }
}

void Arduino_CO5300::write(uint8_t c) {
  if (c == '\n') {
    cursor_x_ = 0;
    cursor_y_ = (int16_t)(cursor_y_ + textsize_ * 8);
    return;
  }
  if (c == '\r') return;
  if (wrap_ && ((cursor_x_ + (textsize_ * 6) - 1) > (width_ - 1))) {
    cursor_x_ = 0;
    cursor_y_ = (int16_t)(cursor_y_ + textsize_ * 8);
    if (!text_.empty()) text_.back().wrapped = true;
  }
  bool clipped = false;
  drawChar(cursor_x_, cursor_y_, c, textcolor_, textbgcolor_, &clipped);
  if (clipped && !text_.empty()) text_.back().clipped = true;
  cursor_x_ = (int16_t)(cursor_x_ + textsize_ * 6);
}

void Arduino_CO5300::print(const char *s) {
  GfxTextDraw draw;
  draw.x = cursor_x_;
  draw.y = cursor_y_;
  draw.size = textsize_;
  draw.text = s == nullptr ? "" : s;
  text_.push_back(draw);
  for (const char *p = s; p != nullptr && *p != '\0'; p++) write((uint8_t)*p);
}

/*
 * The frame, as a PPM.
 *
 * Plain 24-bit triplets and a three line header: the same format the Cardputer simulator writes,
 * because it needs no library and `magick` turns it into a PNG in one step. RGB565 expands with the
 * high bits replicated into the low ones, which is what the panel does and what keeps white white
 * rather than 248,252,248.
 */
bool Arduino_CO5300::simWritePpm(const char *path) const {
  FILE *out = fopen(path, "wb");
  if (out == nullptr) return false;
  fprintf(out, "P6\n%d %d\n255\n", (int)width_, (int)height_);
  for (size_t i = 0; i < pixels_.size(); i++) {
    const uint16_t p = pixels_[i];
    const uint8_t r = (uint8_t)((p >> 11) & 0x1F);
    const uint8_t g = (uint8_t)((p >> 5) & 0x3F);
    const uint8_t b = (uint8_t)(p & 0x1F);
    const uint8_t rgb[3] = {(uint8_t)((r << 3) | (r >> 2)), (uint8_t)((g << 2) | (g >> 4)),
                            (uint8_t)((b << 3) | (b >> 2))};
    fwrite(rgb, 1, 3, out);
  }
  fclose(out);
  return true;
}
