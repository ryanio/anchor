#ifndef ANCHOR_SIM_ARDUINO_H
#define ANCHOR_SIM_ARDUINO_H

/*
 * Enough of Arduino to build this firmware's own sources on a desktop.
 *
 * The rule is flint's, and it is the reason its simulator is trustworthy: only what `app/` actually
 * calls is here. A shim that grows past the code it stands in for is a shim nobody can trust,
 * because the next person cannot tell which half is the device and which half is an invention.
 *
 * Nothing in `app/` knows this file exists. Every difference between the board and the desktop is
 * behind one of these declarations, exactly as `flint/sim/include/Arduino.h` does it for the
 * Cardputer — the alternative, a `#ifdef SIMULATOR` in the firmware, is how a simulator and a
 * device stop agreeing about what the firmware does.
 */

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif

#define INPUT 0x01
#define OUTPUT 0x03
#define HIGH 0x1
#define LOW 0x0

/*
 * The virtual clock.
 *
 * Time here is counted, not measured: `delay()` advances it, the driver advances it once per
 * `loop()` pass, and `digitalRead()` charges a millisecond because the one busy-wait in this
 * firmware — `te_activity()`, which spins on the tearing line without sleeping — would otherwise
 * never terminate against a clock that only moves when somebody sleeps. A counted clock is what
 * makes a five second grace period cost nothing and a run reproducible: the same arguments produce
 * the same frames, which a wall clock cannot promise.
 */
uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);
void simAdvanceClock(uint32_t ms);

void pinMode(uint8_t pin, uint8_t mode);
int digitalRead(uint8_t pin);
void digitalWrite(uint8_t pin, uint8_t value);

/* Arduino's String, over std::string. Only the members `app/` uses. */
class String : public std::string {
 public:
  String() = default;
  String(const char *s) : std::string(s == nullptr ? "" : s) {}
  String(const std::string &s) : std::string(s) {}

  bool isEmpty() const { return empty(); }
  void remove(size_t index) {
    if (index < size()) erase(index);
  }
  void remove(size_t index, size_t count) {
    if (index < size()) erase(index, count);
  }
  String substring(size_t from) const {
    return from >= size() ? String() : String(std::string::substr(from));
  }
  String substring(size_t from, size_t to) const {
    if (from >= size() || to <= from) return String();
    if (to > size()) to = size();
    return String(std::string::substr(from, to - from));
  }
};

inline String operator+(const String &a, const char *b) {
  return String(std::string(a) + (b == nullptr ? "" : b));
}

class IPAddress {
 public:
  IPAddress() = default;
  IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : a_(a), b_(b), c_(c), d_(d) {}
  String toString() const {
    char text[16];
    snprintf(text, sizeof(text), "%u.%u.%u.%u", a_, b_, c_, d_);
    return String(text);
  }

 private:
  uint8_t a_ = 0, b_ = 0, c_ = 0, d_ = 0;
};

/*
 * The USB CDC endpoint, which on this device *is* the protocol.
 *
 * Two halves, and keeping them apart is the point. Writes are the device talking: they go to a
 * capture buffer the driver can dump, never to stdout, because a banner mixed into the protocol
 * stream is the exact bug `app.ino` spends three paragraphs avoiding and a simulator that printed
 * both to one place could not show it. Reads come from whatever the driver queued — a captured
 * frame from the real host adapter, or nothing at all, which is the case Wi-Fi setup exists for.
 *
 * `operator bool` is the CDC connection state, the one signal `app.ino` uses to decide whether a
 * host is on the cable at all. The driver owns it, so "no host attached" is a scenario rather than
 * an unplugged cable.
 */
/*
 * `Stream`, as a name only.
 *
 * `app/feed.h` declares `parseTrending(Stream &, ...)` — a deliberately pure function over a byte
 * source, so that the parser can be exercised against a captured payload without a network. Nothing
 * in the LVGL firmware calls it: the feed's own worker does, on the device, on the other core. So
 * the simulator needs the type to exist for the header to compile and needs nothing else from it,
 * and an empty class says exactly that. Giving it invented read semantics here would be inventing a
 * second, quieter implementation of the thing `feed.cpp` already does for real.
 */
class Stream {};

class SerialShim {
 public:
  void begin(unsigned long = 115200) {}
  void end() {}
  size_t setRxBufferSize(size_t bytes) {
    rx_capacity_ = bytes;
    return bytes;
  }
  void setTxTimeoutMs(uint32_t) {}
  explicit operator bool() const { return connected_; }

  int available();
  int read();
  size_t readBytes(uint8_t *into, size_t want);
  size_t readBytes(char *into, size_t want) { return readBytes((uint8_t *)into, want); }
  size_t write(const uint8_t *bytes, size_t count);
  size_t write(uint8_t byte) { return write(&byte, 1); }
  void flush() {}
  void printf(const char *format, ...);
  void println(const char *s = "");
  void print(const char *s);

  /* The driver's half. Not Arduino, and deliberately named so it reads as the simulator's. */
  void simConnect(bool connected) { connected_ = connected; }
  void simFeed(const uint8_t *bytes, size_t count);
  const std::string &simFromDevice() const { return from_device_; }
  const std::string &simText() const { return text_; }
  size_t simRxCapacity() const { return rx_capacity_; }

 private:
  bool connected_ = false;
  size_t rx_capacity_ = 256;
  std::string rx_;
  size_t rx_at_ = 0;
  std::string from_device_;  // every byte the firmware wrote, protocol and banner alike
  std::string text_;         // the printf/println half, for a human to read
};

extern SerialShim Serial;

/* The chip report the banner prints. Numbers from the real board, so the banner reads the same. */
class EspClass {
 public:
  const char *getChipModel() const { return "ESP32-S3"; }
  int getChipRevision() const { return 2; }
  int getChipCores() const { return 2; }
  int getCpuFreqMHz() const { return 240; }
  uint32_t getFlashChipSize() const { return 16u * 1024u * 1024u; }
  uint32_t getPsramSize() const;
  uint32_t getFreePsram() const;
};

extern EspClass ESP;

#endif /* ANCHOR_SIM_ARDUINO_H */
