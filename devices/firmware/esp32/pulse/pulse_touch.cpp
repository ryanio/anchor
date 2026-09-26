#include "pulse_touch.h"

#include <Arduino.h>
#include <Wire.h>

#include "../app/sensors.h"

namespace pulse_touch {

namespace {

constexpr uint8_t TOUCH_ADDR = 0x15;

/*
 * The register map, spelled the way `app/sensors.cpp` spells it so the two can be compared at a
 * glance: 0x01 is the gesture register, 0x02 the finger count, and 0x03..0x06 the twelve-bit x and
 * y as high nibble / low byte pairs. The gesture register itself is deliberately unread — parts in
 * this family differ over whether it is populated at all without extra configuration, while the
 * coordinates are always there, which is the finding `sensors/` came back with.
 */
constexpr uint8_t REG_FINGERS = 0x02;
constexpr uint8_t REG_XH = 0x03;
constexpr uint8_t REG_XL = 0x04;
constexpr uint8_t REG_YH = 0x05;
constexpr uint8_t REG_YL = 0x06;

/*
 * The identity mapping, and the reason it is written out as one.
 *
 * Nothing here rotates, flips or scales the controller's numbers, because there is no measurement
 * to base a transform on: `docs/devices-esp32.md` records this part answering its identity registers
 * and never answering with a coordinate. Writing `x` and `y` straight through is the honest default
 * — it is at least correct if the controller and the panel agree, and when they do not, the failure
 * is a tap landing in the wrong place, which is obvious the first time a person uses it.
 *
 * What would be dishonest is a plausible-looking `PANEL_H - 1 - y` here, which would be a guess
 * wearing the clothes of a calibration. If the raw samples `pulse.ino` prints turn out mirrored,
 * this is the one function to change.
 */
inline int16_t mapX(int16_t raw) { return raw; }
inline int16_t mapY(int16_t raw) { return raw; }

bool seen = false;

/*
 * One register, with a stop rather than a repeated start between the address and the read.
 *
 * Copied in shape, not in code, from `app/sensors.cpp` — which cannot be called into for this
 * because the read there is file-static inside its anonymous namespace and `app/` is not this
 * sketch's to change. The comment there is the measurement: `sensors/` tried the six-byte burst
 * first, because that is the obvious way to read a coordinate pair, and this part would not serve
 * it while answering the identical registers singly. Four extra transactions on a 400 kHz bus is
 * tens of microseconds, which is a price worth paying for an access pattern this chip has actually
 * demonstrated over one it refused.
 */
int readReg(uint8_t reg)
{
	Wire.beginTransmission(TOUCH_ADDR);
	Wire.write(reg);
	if (Wire.endTransmission(true) != 0) return -1;
	if (Wire.requestFrom((int)TOUCH_ADDR, 1) != 1) return -1;
	return Wire.read();
}

}  // namespace

void begin()
{
	/*
	 * Everything this needs from the bus, `sensors::begin()` already does — and one thing it does
	 * that nothing else in this tree knows to do.
	 *
	 * It brings `Wire` up on SDA=15/SCL=14 at 400 kHz (the pins `probe/` measured, not the Arduino
	 * defaults that once had this project reporting a board with a screen on it as having none),
	 * bounds the I2C timeout at 20 ms, holds TP_INT at its idle level, and then releases the touch
	 * controller's reset through the TCA9554 expander at 0x20. That last one is the whole reason
	 * this call is here rather than three lines of `Wire.begin()`: the reset is not a GPIO, nothing
	 * in this firmware had any other reason to talk to that expander, and without it the part sits
	 * with its interface alive and its panel scan never started — which looks exactly like a working
	 * driver reading a chip that has nothing to say.
	 */
	sensors::begin();
}

/*
 * A lift is only believed after 40ms of no finger, and the rest of the time the last coordinate
 * stands.
 *
 * This part reports a momentary zero finger count in the middle of a contact that never ended.
 * `app/sensors.cpp` found that on this exact controller and says so — its `LIFT_SETTLE_MS` exists
 * for no other reason — and this driver, written fresh for LVGL because `sensors::poll()` reports
 * gestures rather than raw state, did not inherit the finding. Reading the register straight through
 * is what a datasheet would suggest and it is wrong on this silicon.
 *
 * What that cost, on the glass: LVGL takes each dropout as a release, so a press and hold became
 * press, release, press, release several times a second. The popover that magnifies the key under a
 * fingertip never survived long enough to be drawn — reported from the desk as "tap and hold does
 * nothing" — and the same flicker would have made list scrolling and any future drag unreliable, in
 * ways far harder to attribute than a missing popover.
 *
 * So a dropout holds the previous coordinate rather than ending the touch, and only 40ms of silence
 * ends it. The cost of being wrong in this direction is a release reported 40ms late, against a tap
 * that silently becomes four.
 */
constexpr uint32_t LIFT_SETTLE_MS = 40;

/*
 * While a lift is being settled, the finger keeps moving at its last speed rather than standing still.
 *
 * LVGL's fling is a running average of the last few reads' movement, halved at every read
 * (`scroll_throw_vect` in `lv_indev.c`). Holding the last coordinate through the settle window fed it
 * two or three reads of zero movement at 15 ms each, which cut a flick to a quarter or an eighth of
 * its speed before the release arrived: the Wi-Fi list barely moved after a swipe, reported from the
 * desk as "doesn't scroll smoothly or a lot". Carrying the last step forward keeps the speed the
 * finger actually had. A finger that was holding still has a zero step, so a press-and-hold is
 * unchanged, and a dropout that turns out to be spurious is corrected by the next real sample.
 */

bool read(int16_t *x, int16_t *y)
{
	static bool down = false;
	static int16_t last_x = 0;
	static int16_t last_y = 0;
	static int16_t step_x = 0;
	static int16_t step_y = 0;
	static uint32_t quiet_since = 0;

	const int fingers = readReg(REG_FINGERS);
	const bool answered = fingers > 0;

	if (!answered) {
		/* No answer and no finger are still the same answer — but neither one ends a contact until
		 * it has persisted. See above. */
		if (!down) return false;
		if (quiet_since == 0) quiet_since = millis();
		if (millis() - quiet_since < LIFT_SETTLE_MS) {
			last_x = (int16_t)(last_x + step_x);
			last_y = (int16_t)(last_y + step_y);
			if (x != nullptr) *x = last_x;
			if (y != nullptr) *y = last_y;
			return true;
		}
		down = false;
		quiet_since = 0;
		step_x = 0;
		step_y = 0;
		return false;
	}

	const int xh = readReg(REG_XH);
	const int xl = readReg(REG_XL);
	const int yh = readReg(REG_YH);
	const int yl = readReg(REG_YL);
	if (xh < 0 || xl < 0 || yh < 0 || yl < 0) {
		/* A finger is there and the coordinate registers did not answer. Holding the last position
		 * is better than dropping the contact for one bad read, for the same reason as above. */
		if (!down) return false;
		if (x != nullptr) *x = last_x;
		if (y != nullptr) *y = last_y;
		return true;
	}

	/* Twelve bits: the low nibble of the high byte carries bits 11..8. */
	const int16_t raw_x = (int16_t)(((xh & 0x0F) << 8) | xl);
	const int16_t raw_y = (int16_t)(((yh & 0x0F) << 8) | yl);
	seen = true;
	const int16_t now_x = mapX(raw_x);
	const int16_t now_y = mapY(raw_y);
	/* The controller can report the same sample to two reads in a row; keep the last real step
	 * rather than letting a repeat zero it. A new contact starts with no step. */
	if (!down) {
		step_x = 0;
		step_y = 0;
	} else if (now_x != last_x || now_y != last_y) {
		step_x = (int16_t)(now_x - last_x);
		step_y = (int16_t)(now_y - last_y);
	}
	down = true;
	quiet_since = 0;
	last_x = now_x;
	last_y = now_y;
	if (x != nullptr) *x = last_x;
	if (y != nullptr) *y = last_y;
	return true;
}

bool everSeen()
{
	return seen;
}

}  // namespace pulse_touch
