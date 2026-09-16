#ifndef ANCHOR_SIM_WIRE_H
#define ANCHOR_SIM_WIRE_H

/*
 * I2C, with nothing on the bus.
 *
 * `app.ino` scans the bus in its banner and `sensors.cpp` reads the CST820 over it. The scan is
 * kept — it prints, and a banner that prints is a banner a host has to resynchronise past, which is
 * part of what this harness exercises — but every address answers "no device", because inventing a
 * touch controller here would be inventing the one thing on this board that has never been seen to
 * work. Synthetic touch comes in through `sensors_sim.cpp` at the gesture layer instead, which is
 * the seam where a scenario can say "a finger landed at 100,180" and mean it.
 */

#include <cstdint>

#include "Arduino.h"

class TwoWire {
 public:
  bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0) {
    (void)sda;
    (void)scl;
    (void)frequency;
    return true;
  }
  void setTimeOut(uint16_t ms) { (void)ms; }
  void beginTransmission(uint8_t address) { address_ = address; }
  /* 2 is the core's "address NACK on transmit": nothing answered. */
  uint8_t endTransmission(bool stop = true) {
    (void)stop;
    return 2;
  }
  uint8_t requestFrom(uint8_t address, size_t size, bool stop = true) {
    (void)address;
    (void)size;
    (void)stop;
    return 0;
  }
  size_t write(uint8_t value) {
    (void)value;
    return 1;
  }
  int available() { return 0; }
  int read() { return -1; }

 private:
  uint8_t address_ = 0;
};

extern TwoWire Wire;

#endif /* ANCHOR_SIM_WIRE_H */
