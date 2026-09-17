#include "pulse_power.h"

#include <Arduino.h>
#include <Wire.h>
#include <stdio.h>

namespace pulse_power {

namespace {

/* ------------------------------------------------------------------------------ the registers -- */

/*
 * Every number in this block is cited. The two sources are the ones named in the header:
 *
 *   [M5]  M5Unified `src/utility/power/AXP2101_Class.cpp`, checked out in this repository at
 *         `devices/firmware/cardputer/.pio/libdeps/cardputer-adv-anchor/M5Unified/`.
 *   [XP]  lewisxhe/XPowersLib, `src/REG/AXP2101Constants.h` and `src/XPowersAXP2101.hpp`.
 *
 * Nothing here was typed from memory and nothing here was inferred from a neighbouring address.
 */

constexpr uint8_t PMU_ADDR = 0x34; /* probe/probe.ino, and docs/devices-esp32.md's bus table. */

/*
 * 0x00 — PMU status 1.
 *
 *   bit 5  VBUS good.        [XP] `isVbusGood()` is `getRegisterBit(STATUS1, 5)`.
 *                            [M5] `isVBUS()` is `readRegister8(0x00) & 0x20`. Same bit, two files.
 *   bit 3  battery present.  [XP] `isBatteryConnect()` is `getRegisterBit(STATUS1, 3)`.
 *                            [M5] `getBatState()` is `readRegister8(0x00) & 0x08`. Same bit.
 */
constexpr uint8_t REG_STATUS1 = 0x00;
constexpr uint8_t STATUS1_VBUS_GOOD = 1u << 5;
constexpr uint8_t STATUS1_BAT_PRESENT = 1u << 3;

/*
 * 0x01 — PMU status 2. Bits 6:5 are the charge state.
 *
 * [M5] `getChargeStatus()`: `(readRegister8(0x01) >> 5) & 0b11`, commented "0b01:charge /
 * 0b10:discharge / 0b00:standby", and `isCharging()` is the same field compared against 0b01.
 * [XP] `isCharging()`: `(readRegister(STATUS2) >> 5) == 0x01`. Identical field, identical meaning.
 */
constexpr uint8_t REG_STATUS2 = 0x01;
constexpr uint8_t STATUS2_CHARGE_SHIFT = 5;
constexpr uint8_t STATUS2_CHARGE_MASK = 0x03;
constexpr uint8_t CHARGE_CHARGING = 0x01;

/*
 * 0x03 — chip id, which reads 0x4A on an AXP2101.
 *
 * [M5] `AXP2101_Class::begin()` reads 0x03 and requires `val == 0x4A`.
 * [XP] `XPOWERS_AXP2101_IC_TYPE` is 0x03.
 * And independently measured on the unit on this desk: `probe/probe.ino` prints
 * "0x34 pmu chip id 0x4a". Three sources for one byte, which is the right number of sources for the
 * byte that decides whether anything else in this file is addressed at a PMU at all.
 */
constexpr uint8_t REG_CHIP_ID = 0x03;
constexpr uint8_t CHIP_ID_AXP2101 = 0x4A;

/*
 * 0x10 — common configuration. Bit 0 is the soft power-off.
 *
 * [XP] `shutdown()` is exactly `setRegisterBit(XPOWERS_AXP2101_COMMON_CONFIG, 0)`, and
 *      `XPOWERS_AXP2101_COMMON_CONFIG` is 0x10 in `AXP2101Constants.h`.
 * [M5] `powerOff()` is exactly `bitOn(0x10, 0x01)`.
 *
 * Two drivers, one bit, no ambiguity — which is the only reason this file writes it at all. It is
 * also the single most dangerous line here: it stops the board.
 */
constexpr uint8_t REG_COMMON_CONFIG = 0x10;
constexpr uint8_t COMMON_SOFT_POWEROFF = 1u << 0;

/*
 * 0x30 — ADC channel control. Bit 0 enables the battery-voltage channel.
 *
 * [XP] `XPOWERS_AXP2101_ADC_CHANNEL_CTRL` is 0x30, and `enableBattVoltageMeasure()` is
 * `setRegisterBit(ADC_CHANNEL_CTRL, 0)`. The bit map XPowersLib documents for this register is
 * 0=battery voltage, 1=TS pin, 2=VBUS voltage, 3=system voltage, 4=die temperature, 5=general ADC.
 * [M5] `setAdcState(true)` writes 0b111111 to 0x30 — the same six channels, all at once.
 *
 * **This file takes XPowersLib's narrower move on purpose.** M5Unified writes the whole byte, which
 * is fine for a board whose bring-up it owns and wrong for a board whose bring-up somebody else's
 * firmware may already have done: it would silently turn on four channels nobody here reads and
 * discard whatever the vendor had configured. So this is a read-modify-write of one bit, and it is
 * skipped entirely when the bit is already set — a unit that arrives with the ADC running is never
 * written to at all.
 */
constexpr uint8_t REG_ADC_CHANNEL_CTRL = 0x30;
constexpr uint8_t ADC_CH_BATTERY_VOLTAGE = 1u << 0;

/*
 * 0x34/0x35 — the battery-voltage ADC result, high byte first, in millivolts.
 *
 * [XP] `XPOWERS_AXP2101_ADC_DATA_RELUST0` is 0x34 and `RELUST1` is 0x35; `getBattVoltage()` reads
 * them with `readRegisterH5L8`, i.e. **five** significant bits of the high byte.
 * [M5] `getBatteryVoltage()` reads the same pair with a 14-bit helper — **six** bits of the high
 * byte — and divides by 1000.
 *
 * They disagree about one bit, and this file takes the narrower of the two (0x1F). A lithium cell
 * lives between roughly 3000 and 4400 mV, so within the range that can physically occur the two
 * readings are identical; the only thing the extra bit can do is add 8192 mV to a value that has a
 * stray bit set in a field one driver calls reserved. Taking the narrow mask makes that impossible.
 * `plausible()` below is the second belt.
 */
constexpr uint8_t REG_ADC_VBAT_H = 0x34;
constexpr uint16_t ADC_VBAT_H_MASK = 0x1F;

/*
 * 0xA4 — the fuel gauge's state of charge, 0-100, one byte.
 *
 * [XP] `XPOWERS_AXP2101_BAT_PERCENT_DATA` is 0xA4, and `getBatteryPercent()` returns `readRegister`
 * of it, after refusing when no battery is connected.
 * [M5] `getBatteryLevel()` is `readRegister8(0xA4)`, documented "0-100 level".
 *
 * Read, never written. The gauge's own control register (0xA2 in XPowersLib) is left alone: a fuel
 * gauge reset on a board whose battery profile this firmware does not know is a worse number than
 * the one it replaced.
 */
constexpr uint8_t REG_BAT_PERCENT = 0xA4;

/* ----------------------------------------------------------------------------------- the bus --- */

Battery latest;
bool identified = false;
uint32_t last_read_at = 0;
char banner[96] = "power: not started";

/*
 * How often the PMU is asked. A battery moves on the scale of minutes and the I2C bus is shared with
 * the touch controller, which LVGL polls every refresh period — so this is deliberately slow enough
 * to be invisible to a finger.
 */
constexpr uint32_t READ_INTERVAL_MS = 5000;

bool writeReg(uint8_t reg, uint8_t value)
{
	Wire.beginTransmission(PMU_ADDR);
	Wire.write(reg);
	Wire.write(value);
	return Wire.endTransmission(true) == 0;
}

/*
 * One register, with a stop between the address and the read.
 *
 * The same access pattern `app/sensors.cpp` proved on this bus, and it is not a stylistic
 * preference: the CST820 on this board refuses a repeated-start burst while answering the identical
 * registers one at a time. Nothing says the AXP2101 shares that, but the pattern that is known to
 * work on this silicon is the one to start from.
 */
int readReg(uint8_t reg)
{
	Wire.beginTransmission(PMU_ADDR);
	Wire.write(reg);
	if (Wire.endTransmission(true) != 0) return -1;
	if (Wire.requestFrom((uint8_t)PMU_ADDR, (size_t)1, true) != 1) return -1;
	const int value = Wire.read();
	return value;
}

/*
 * A two-register ADC result, as one transaction where the part allows it.
 *
 * Both vendor drivers read the pair in a single burst, and there is a reason beyond speed: the
 * result latches on the high byte, so two separate transactions can straddle a conversion and
 * produce a voltage that never existed. The burst is tried first for that reason. If it does not
 * answer — which is exactly what the CST820 on this same bus does — it falls back to two single
 * reads and accepts the small chance of a torn sample, because a slightly wrong voltage every few
 * seconds is better than no voltage at all. Which of the two paths this board takes is unknown until
 * somebody runs it on hardware; both are implemented rather than guessed between.
 */
int readAdcPair(uint8_t reg_high, uint16_t high_mask)
{
	Wire.beginTransmission(PMU_ADDR);
	Wire.write(reg_high);
	if (Wire.endTransmission(true) == 0 && Wire.requestFrom((uint8_t)PMU_ADDR, (size_t)2, true) == 2) {
		const int high = Wire.read();
		const int low = Wire.read();
		if (high >= 0 && low >= 0) {
			return (int)(((uint16_t)high & high_mask) << 8 | (uint16_t)low);
		}
	}
	const int high = readReg(reg_high);
	const int low = readReg((uint8_t)(reg_high + 1));
	if (high < 0 || low < 0) return -1;
	return (int)(((uint16_t)high & high_mask) << 8 | (uint16_t)low);
}

/* A single-cell lithium battery cannot be outside this, so a reading that is says the channel is off
 * or the decode is wrong — and either way it must not be shown as a voltage. */
bool plausible(int millivolts)
{
	return millivolts >= 2500 && millivolts <= 4600;
}

/*
 * A state of charge from the terminal voltage, for when the gauge has nothing to say.
 *
 * This is an approximation and is flagged as one in `Battery::percent_estimated`, because it is: a
 * lithium cell's open-circuit curve is flat through the middle of its range and the terminal voltage
 * under load sags by an amount that depends on the load. The table below is the usual single-cell
 * shape — 4.20 V full, 3.70 V around half, 3.30 V empty — and it is here so that a unit whose gauge
 * has not settled still shows *something* ordered correctly, not so that anybody reads it as a
 * measurement. The gauge at 0xA4 is preferred whenever it answers with a value in range.
 */
int8_t percentFromVoltage(uint16_t mv)
{
	struct Point {
		uint16_t mv;
		int8_t pct;
	};
	static const Point curve[] = {{3300, 0},  {3600, 10}, {3700, 25}, {3750, 40},
	                              {3850, 60}, {3950, 75}, {4100, 90}, {4200, 100}};
	if (mv <= curve[0].mv) return 0;
	const size_t count = sizeof(curve) / sizeof(curve[0]);
	for (size_t i = 1; i < count; i++) {
		if (mv <= curve[i].mv) {
			const int32_t span_mv = (int32_t)curve[i].mv - (int32_t)curve[i - 1].mv;
			const int32_t span_pct = (int32_t)curve[i].pct - (int32_t)curve[i - 1].pct;
			const int32_t into = (int32_t)mv - (int32_t)curve[i - 1].mv;
			return (int8_t)(curve[i - 1].pct + (into * span_pct) / span_mv);
		}
	}
	return 100;
}

void refresh()
{
	if (!identified) return;

	Battery next;
	next.pmu = true;

	const int status1 = readReg(REG_STATUS1);
	if (status1 < 0) {
		/* The chip identified itself once and has now stopped answering. That is a different fact from
		 * "there is no PMU", and it is reported as one rather than being smoothed into a zero. */
		latest = Battery();
		snprintf(banner, sizeof(banner), "power: AXP2101 stopped answering at 0x%02X", PMU_ADDR);
		return;
	}
	next.usb = (status1 & STATUS1_VBUS_GOOD) != 0;
	next.battery = (status1 & STATUS1_BAT_PRESENT) != 0;

	const int status2 = readReg(REG_STATUS2);
	if (status2 >= 0) {
		next.charging = ((status2 >> STATUS2_CHARGE_SHIFT) & STATUS2_CHARGE_MASK) == CHARGE_CHARGING;
	}

	if (next.battery) {
		const int raw = readAdcPair(REG_ADC_VBAT_H, ADC_VBAT_H_MASK);
		if (raw >= 0 && plausible(raw)) next.millivolts = (uint16_t)raw;

		const int gauge = readReg(REG_BAT_PERCENT);
		if (gauge >= 0 && gauge <= 100) {
			next.percent = (int8_t)gauge;
		} else if (next.millivolts != 0) {
			next.percent = percentFromVoltage(next.millivolts);
			next.percent_estimated = true;
		}
	}

	latest = next;

	if (!next.battery) {
		snprintf(banner, sizeof(banner), "power: AXP2101, no battery fitted, %s",
		         next.usb ? "on USB" : "on an unknown supply");
	} else {
		snprintf(banner, sizeof(banner), "power: AXP2101, %d%%%s, %u mV, %s", (int)next.percent,
		         next.percent_estimated ? " (from voltage)" : "", (unsigned)next.millivolts,
		         next.charging ? "charging" : (next.usb ? "on USB" : "on battery"));
	}
}

}  // namespace

bool begin()
{
	identified = false;
	latest = Battery();

	const int id = readReg(REG_CHIP_ID);
	if (id < 0) {
		snprintf(banner, sizeof(banner), "power: nothing answered at 0x%02X", PMU_ADDR);
		return false;
	}
	if (id != CHIP_ID_AXP2101) {
		/*
		 * Something is at 0x34 and it is not the part this file's register map describes. Stopping
		 * here is the whole safety argument: every write below is correct for an AXP2101 and for
		 * nothing else, and "an unexpected id is probably fine" is how a register map gets applied to
		 * the wrong silicon.
		 */
		snprintf(banner, sizeof(banner), "power: 0x%02X answered 0x%02X, not an AXP2101 (0x4A)",
		         PMU_ADDR, (unsigned)id);
		return false;
	}
	identified = true;

	/*
	 * The one non-shutdown write in this file, and it is skipped when it is not needed.
	 *
	 * The AXP2101 comes out of reset with its ADC channels off, so without this the battery-voltage
	 * registers read zero forever and the panel would show a confident 0.00 V. Reading 0x30 first and
	 * writing only when bit 0 is clear means a unit whose vendor bring-up already enabled it is never
	 * written to at all — and a read that fails writes nothing, rather than writing a byte computed
	 * from a failed read, which is the shape of the mistake that disables a rail.
	 */
	const int adc = readReg(REG_ADC_CHANNEL_CTRL);
	if (adc >= 0 && (adc & ADC_CH_BATTERY_VOLTAGE) == 0) {
		writeReg(REG_ADC_CHANNEL_CTRL, (uint8_t)((uint8_t)adc | ADC_CH_BATTERY_VOLTAGE));
	}

	refresh();
	last_read_at = millis();
	return true;
}

void tick()
{
	if (!identified) return;
	const uint32_t now = millis();
	if (now - last_read_at < READ_INTERVAL_MS) return;
	last_read_at = now;
	refresh();
}

const Battery &state()
{
	return latest;
}

bool powerOff()
{
	if (!identified) return false;

	/*
	 * Read, set one bit, write back — never a bare byte.
	 *
	 * 0x10 is the common configuration register and bit 0 is only its power-off request; the other
	 * seven bits are the part's own configuration and belong to whoever set them. Writing 0x01 into
	 * it, which would also "work", would clear all of them on the way out. A refused read is a
	 * refused shutdown: this returns false rather than falling back to a blind write, because a blind
	 * write to a PMU configuration register is the exact thing the header promises not to do.
	 */
	const int current = readReg(REG_COMMON_CONFIG);
	if (current < 0) return false;
	return writeReg(REG_COMMON_CONFIG, (uint8_t)((uint8_t)current | COMMON_SOFT_POWEROFF));
}

const char *describe()
{
	return banner;
}

}  // namespace pulse_power
