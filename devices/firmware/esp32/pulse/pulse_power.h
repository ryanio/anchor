#ifndef ANCHOR_PULSE_POWER_H
#define ANCHOR_PULSE_POWER_H

#include <stdint.h>

/*
 * The AXP2101, which nothing in this tree had ever spoken to.
 *
 * ## Why this exists
 *
 * "i cant figure out how to turn the esp32 off maybe holding both buttons for 5s?" — asked while
 * holding a unit, and there was no answer to give, because no firmware here had ever addressed the
 * power-management IC. `probe/probe.ino` found it (0x34 on the SDA=15/SCL=14 bus, chip id 0x4A in
 * register 0x03) and `docs/devices-esp32.md` wrote it into the bus table, and that was the whole of
 * the relationship. A unit handed to somebody at an offsite could not be switched off, could not say
 * how much charge it had left, and could not tell you whether the cable it was on was charging it.
 *
 * ## Where the register numbers come from, which is the whole point of this file
 *
 * AGENTS.md: a register written from memory is how this project once put a touch controller to sleep
 * it could not wake. So every register below is cited, and every one of them is corroborated by two
 * independent vendor drivers that were read rather than remembered:
 *
 *   - **M5Unified**, `src/utility/power/AXP2101_Class.cpp` — M5Stack's own driver for the AXP2101 on
 *     the Cardputer ADV, which is checked out in this very repository at
 *     `devices/firmware/cardputer/.pio/libdeps/cardputer-adv-anchor/M5Unified/`. It is the copy that
 *     drives the *other* device on this desk, so it is a driver with hardware behind it rather than
 *     a search result.
 *   - **XPowersLib**, `lewisxhe/XPowersLib` — `src/REG/AXP2101Constants.h` for the addresses and
 *     `src/XPowersAXP2101.hpp` for what each bit means. This is the library Waveshare's own examples
 *     for this board pull in.
 *
 * Where the two disagree, this file says so at the line and takes the narrower reading. Where only
 * one of them speaks, the comment says which.
 *
 * ## Reading is safe. Writing is not.
 *
 * An I2C write to the wrong register on a PMU can brown the board out or disable a rail that needs a
 * hardware reset to bring back — which on this board means the panel and the touch controller, since
 * the AXP2101's LDOs are what feed them. This file therefore writes **exactly two bits, ever**:
 *
 *   1. `0x30` bit 0, the battery-voltage ADC channel enable, read-modify-written and only when it is
 *      found clear. Without it the VBAT ADC reads nothing at all.
 *   2. `0x10` bit 0, the soft power-off, and only from `powerOff()`.
 *
 * Everything else this firmware wants to know is a read. Charge current (`0x62`), charge termination
 * voltage (`0x64`), the DCDC and LDO rail enables (`0x80`, `0x90`) and the power-key behaviour
 * (`0x22`, `0x27`) are all deliberately left alone: a wrong value in the first two is a cell charged
 * past where it should be, and a wrong value in the next two is a dark panel that a USB replug will
 * not fix. None of it can be verified without a board on the desk, and nothing here is worth bricking
 * a unit two weeks before an offsite.
 *
 * ## What the simulator cannot tell you
 *
 * `sim/include/Wire.h` can be made to answer at 0x34 with a scripted register file, which is enough
 * to render the battery indicator and to exercise the decode in this file. It is not a PMU. It cannot
 * tell you that the ADC enable took, that `0xA4` holds a sane state-of-charge on this board, or that
 * `0x10` bit 0 actually cuts power rather than merely being acknowledged. Those three claims need a
 * unit on a cable and are listed as unverified until somebody has one.
 */
namespace pulse_power {

/*
 * What the PMU says, in the shape a screen can render.
 *
 * `pmu` first, because every other field is meaningless without it, and because "the chip did not
 * answer" and "the battery is at zero" must never be the same picture — that is a plausible number
 * that is not the number it claims to be, which is the failure this project rates above every other.
 */
struct Battery {
	/* The AXP2101 answered, and answered with 0x4A. Nothing below means anything while this is false. */
	bool pmu = false;
	/* A cell is connected (status register 0x00 bit 3). A unit running on USB with no battery fitted
	 * is a perfectly normal state and is not a fault. */
	bool battery = false;
	/* VBUS is present and good (status register 0x00 bit 5). */
	bool usb = false;
	/* Charging right now, as opposed to standby or discharging (status register 0x01 bits 6:5). */
	bool charging = false;
	/* Battery terminal voltage in millivolts, or 0 when it has not been read. */
	uint16_t millivolts = 0;
	/* 0-100, or -1 when unknown. */
	int8_t percent = -1;
	/* True when `percent` came from the voltage curve below rather than from the PMU's own fuel
	 * gauge. A number nobody can check is worse than no number; this is how a caller can say so. */
	bool percent_estimated = false;
};

/*
 * Identify the PMU and enable the one ADC channel this file reads.
 *
 * **Call after the I2C bus is up**, which on this firmware means after `pulse_touch::begin()` —
 * that path runs `sensors::begin()`, which is the only bus configuration in this project that has
 * ever been proved to work on this board (400 kHz, a bounded `Wire.setTimeOut`, TP_INT held at its
 * idle level). This file never calls `Wire.begin` itself, because a second `begin` on a live bus is
 * exactly the class of thing that costs an evening here.
 *
 * Returns whether the chip id read back as 0x4A. False is not fatal: everything else degrades to
 * "unknown" and the UI hides the indicator.
 */
bool begin();

/* Re-read the PMU, at most every few seconds. Cheap to call every pass. */
void tick();

/* The most recent reading. Never null, and `pmu == false` until `begin()` has succeeded. */
const Battery &state();

/*
 * Command the PMU to cut power to the board.
 *
 * This is the thing a person holding the unit needs, and it is a one-way door: the ESP32 stops mid
 * instruction and comes back only when the AXP2101 is told to power on again. Everything guarding it
 * — the deliberate gesture, the confirmation screen, the timeout that cancels it — lives in
 * `pulse_ui.cpp`, because a guard is part of the affordance and not part of the driver.
 *
 * Returns false if the PMU never identified itself, in which case nothing was written.
 */
bool powerOff();

/* One line for the boot banner: what answered, and what it said. Points at a static buffer. */
const char *describe();

}  // namespace pulse_power

#endif /* ANCHOR_PULSE_POWER_H */
