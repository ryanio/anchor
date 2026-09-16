/*
 * The Arduino core, the clock, the cable and the heap — the parts of the board that are not a
 * panel and not a radio.
 */

#include <cstdarg>

#include "Arduino.h"
#include "Wire.h"
#include "esp_heap_caps.h"

SerialShim Serial;
EspClass ESP;
TwoWire Wire;

namespace {

uint32_t clock_ms = 0;
bool psram_present = true;

}  // namespace

/* ---------------------------------------------------------------------------------- clock ---- */

uint32_t millis() {
  return clock_ms;
}

uint32_t micros() {
  return clock_ms * 1000u;
}

void delay(uint32_t ms) {
  clock_ms += ms;
}

void delayMicroseconds(uint32_t us) {
  clock_ms += us / 1000u;
}

void simAdvanceClock(uint32_t ms) {
  clock_ms += ms;
}

void pinMode(uint8_t pin, uint8_t mode) {
  (void)pin;
  (void)mode;
}

/*
 * A GPIO read costs a millisecond of the virtual clock.
 *
 * `te_activity()` spins `while (millis() < until)` reading the tearing line with nothing in the
 * loop that sleeps — on silicon that is fine, on a counted clock it never returns. Charging the
 * read is the honest fix: it is the only thing in that loop that touches hardware, so it is the
 * only thing that could cost time. The alternative — a clock that advances on every `millis()` call
 * — would make every timeout in `wifi_setup.cpp` depend on how often something asked the time.
 *
 * The line alternates, so the banner reports tearing activity rather than a dark panel, which is
 * what the board reports with the 0x35 `app.ino` sends.
 */
int digitalRead(uint8_t pin) {
  (void)pin;
  static int level = 0;
  clock_ms += 1;
  level = level == 0 ? 1 : 0;
  return level;
}

void digitalWrite(uint8_t pin, uint8_t value) {
  (void)pin;
  (void)value;
}

/* ---------------------------------------------------------------------------------- cable ---- */

int SerialShim::available() {
  return (int)(rx_.size() - rx_at_);
}

int SerialShim::read() {
  if (rx_at_ >= rx_.size()) return -1;
  return (unsigned char)rx_[rx_at_++];
}

size_t SerialShim::readBytes(uint8_t *into, size_t want) {
  size_t have = rx_.size() - rx_at_;
  size_t take = want < have ? want : have;
  memcpy(into, rx_.data() + rx_at_, take);
  rx_at_ += take;
  return take;
}

size_t SerialShim::write(const uint8_t *bytes, size_t count) {
  // Writes are discarded when no host has the port open, exactly as HWCDC does — which is the
  // behaviour `setup()`'s wait-for-Serial exists to work around, so a simulator that buffered them
  // would make that paragraph look unnecessary.
  if (!connected_) return count;
  from_device_.append((const char *)bytes, count);
  return count;
}

void SerialShim::simFeed(const uint8_t *bytes, size_t count) {
  // Bytes past the receive buffer are dropped, which is the bug the 64KB buffer in `setup()` was
  // measured into existence to fix. Feeding more than the device promised should shift the stream
  // here the same way it shifted it on the desk.
  size_t room = rx_capacity_ > (rx_.size() - rx_at_) ? rx_capacity_ - (rx_.size() - rx_at_) : 0;
  size_t take = count < room ? count : room;
  rx_.append((const char *)bytes, take);
}

void SerialShim::printf(const char *format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  text_ += line;
  if (connected_) from_device_ += line;
}

void SerialShim::println(const char *s) {
  text_ += s;
  text_ += "\n";
  if (connected_) {
    from_device_ += s;
    from_device_ += "\n";
  }
}

void SerialShim::print(const char *s) {
  text_ += s;
  if (connected_) from_device_ += s;
}

/* ----------------------------------------------------------------------------------- heap ---- */

void *heap_caps_malloc(size_t bytes, uint32_t caps) {
  if ((caps & MALLOC_CAP_SPIRAM) != 0 && !psram_present) return nullptr;
  return malloc(bytes);
}

size_t heap_caps_get_free_size(uint32_t caps) {
  (void)caps;
  return 267000;  // roughly what this part reports with the USB stack up
}

size_t heap_caps_get_largest_free_block(uint32_t caps) {
  (void)caps;
  return 147000;
}

void simSetPsram(int present) {
  psram_present = present != 0;
}

int simPsram() {
  return psram_present ? 1 : 0;
}

uint32_t EspClass::getPsramSize() const {
  return psram_present ? 8u * 1024u * 1024u : 0u;
}

uint32_t EspClass::getFreePsram() const {
  return psram_present ? 7943664u : 0u;
}
