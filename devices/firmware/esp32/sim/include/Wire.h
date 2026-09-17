#ifndef ANCHOR_SIM_WIRE_H
#define ANCHOR_SIM_WIRE_H

/*
 * I2C, with nothing on the bus — unless a scenario puts one thing on it.
 *
 * `app.ino` scans the bus in its banner and `sensors.cpp` reads the CST820 over it. The scan is
 * kept — it prints, and a banner that prints is a banner a host has to resynchronise past, which is
 * part of what this harness exercises — but every address answers "no device", because inventing a
 * touch controller here would be inventing the one thing on this board that has never been seen to
 * work. Synthetic touch comes in through `sensors_sim.cpp` at the gesture layer instead, which is
 * the seam where a scenario can say "a finger landed at 100,180" and mean it.
 *
 * ## The one exception, and the limits of it
 *
 * 0x34 can be made to answer, off by default and only when `simSetPmu()` says so. The AXP2101 is a
 * different case from the touch controller in the way that matters: it *has* answered on real
 * hardware. `probe/probe.ino` read chip id 0x4A out of register 0x03 on the unit on this desk and
 * `docs/devices-esp32.md` has it in the bus table. So this is a part that is known to be there, with
 * a register map taken from two vendor drivers (cited line by line in `pulse/pulse_power.cpp`), being
 * replayed so that the decode and the screen above it can be exercised without a board.
 *
 * **What it proves:** that `pulse_power.cpp` addresses the registers it says it does, reads the
 * fields out of them the right way round, takes the ADC-enable path only when the bit is clear, and
 * that the battery indicator renders at 4%, 78% and with no cell at all.
 *
 * **What it cannot prove, and this is the sharp edge of the tool:** that any of those registers mean
 * on silicon what the drivers say they mean. The values here are invented — they have to be — so a
 * green run says the firmware is self-consistent and says nothing whatever about the hardware. In
 * particular it cannot tell you that writing bit 0 of 0x10 actually cuts power, which is the one
 * operation in that file that a person will rely on. That claim needs a unit on a cable.
 */

#include <cstdint>
#include <cstring>

#include "Arduino.h"

/* What a scripted AXP2101 says when it is asked. Set from the harness; see `--battery`. */
struct SimPmu {
  bool present = false;
  bool battery = true;
  bool usb = false;
  bool charging = false;
  int percent = 78;
  uint16_t millivolts = 3860;
  /* True once something has written the soft power-off bit. The harness prints it, because a
   * shutdown on the desktop is otherwise completely invisible — the process keeps running. */
  bool powered_off = false;
  /* The ADC channel control register, which starts at the part's reset value of zero so that the
   * enable path in `pulse_power::begin()` is the path a run actually takes. */
  uint8_t adc_ctrl = 0x00;
  /* 0x10, the common configuration. The other seven bits are set to something non-zero on purpose:
   * a `powerOff()` that wrote a bare 0x01 rather than read-modify-writing would clear them, and the
   * harness would be able to see that it had. */
  uint8_t common_config = 0x30;
};

class TwoWire {
 public:
  bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0) {
    (void)sda;
    (void)scl;
    (void)frequency;
    return true;
  }
  void setTimeOut(uint16_t ms) { (void)ms; }
  void beginTransmission(uint8_t address) {
    address_ = address;
    wrote_ = 0;
  }
  size_t write(uint8_t value) {
    if (wrote_ < sizeof(buffer_)) buffer_[wrote_++] = value;
    return 1;
  }
  /* 2 is the core's "address NACK on transmit": nothing answered. 0 is an acknowledged write. */
  uint8_t endTransmission(bool stop = true) {
    (void)stop;
    if (!answers(address_)) return 2;
    if (wrote_ >= 1) pointer_ = buffer_[0];
    if (wrote_ >= 2) writeReg(buffer_[0], buffer_[1]);
    return 0;
  }
  uint8_t requestFrom(uint8_t address, size_t size, bool stop = true) {
    (void)stop;
    pending_ = 0;
    read_at_ = 0;
    if (!answers(address)) return 0;
    if (size > sizeof(buffer_)) size = sizeof(buffer_);
    for (size_t i = 0; i < size; i++) {
      buffer_[i] = readReg((uint8_t)(pointer_ + i));
    }
    pending_ = size;
    return (uint8_t)size;
  }
  int available() { return (int)(pending_ - read_at_); }
  int read() {
    if (read_at_ >= pending_) return -1;
    return buffer_[read_at_++];
  }

  /* --- the harness's side ------------------------------------------------------------------- */

  void simSetPmu(const SimPmu &pmu) { pmu_ = pmu; }
  const SimPmu &simPmu() const { return pmu_; }

 private:
  static constexpr uint8_t PMU_ADDR = 0x34;

  bool answers(uint8_t address) const { return pmu_.present && address == PMU_ADDR; }

  /*
   * The register map, and every number in it is the one `pulse/pulse_power.cpp` cites — this file
   * deliberately repeats the addresses rather than including that header, so that a typo in the
   * driver shows up as a wrong reading here instead of being shared by both sides and cancelling out.
   */
  uint8_t readReg(uint8_t reg) const {
    switch (reg) {
      case 0x00: /* status 1: bit 5 VBUS good, bit 3 battery present */
        return (uint8_t)((pmu_.usb ? 0x20 : 0x00) | (pmu_.battery ? 0x08 : 0x00));
      case 0x01: /* status 2: bits 6:5, 01 charging / 10 discharging / 00 standby */
        return (uint8_t)((pmu_.charging ? 0x01 : (pmu_.battery ? 0x02 : 0x00)) << 5);
      case 0x03:
        return 0x4A;
      case 0x10:
        return pmu_.common_config;
      case 0x30:
        return pmu_.adc_ctrl;
      case 0x34: /* VBAT ADC, high byte; only meaningful once bit 0 of 0x30 is set */
        return (pmu_.adc_ctrl & 0x01) ? (uint8_t)((pmu_.millivolts >> 8) & 0x1F) : 0x00;
      case 0x35:
        return (pmu_.adc_ctrl & 0x01) ? (uint8_t)(pmu_.millivolts & 0xFF) : 0x00;
      case 0xA4: /* fuel gauge state of charge; 0xFF where there is nothing to gauge */
        return pmu_.battery && pmu_.percent >= 0 ? (uint8_t)pmu_.percent : 0xFF;
      default:
        return 0x00;
    }
  }

  void writeReg(uint8_t reg, uint8_t value) {
    switch (reg) {
      case 0x10:
        pmu_.common_config = value;
        if (value & 0x01) pmu_.powered_off = true;
        break;
      case 0x30:
        pmu_.adc_ctrl = value;
        break;
      default:
        break;
    }
  }

  uint8_t address_ = 0;
  uint8_t pointer_ = 0;
  uint8_t buffer_[8] = {0};
  size_t wrote_ = 0;
  size_t pending_ = 0;
  size_t read_at_ = 0;
  SimPmu pmu_;
};

extern TwoWire Wire;

#endif /* ANCHOR_SIM_WIRE_H */
