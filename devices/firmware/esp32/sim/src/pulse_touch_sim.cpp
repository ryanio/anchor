/*
 * Touch, injected — at the level LVGL reads, not at the level I2C answers.
 *
 * `sensors_sim.cpp` makes this argument for the blitter firmware and it holds here unchanged: the
 * CST820 on this board answers its identity registers and has never answered with a coordinate, so
 * simulating its register map would be building a model of behaviour nobody has observed and then
 * testing against the model. What this file stands in for is one function — "is a finger down, and
 * where" — which is exactly the vocabulary `pulse.ino`'s indev callback speaks.
 *
 * Which means everything above this seam is the firmware's own code running unmodified: the indev
 * registration, the held-coordinate-across-release rule, LVGL's own press/click/release state
 * machine, and whatever the screen does about it. What stays unproven is the half below — whether a
 * finger on the lit glass ever becomes one of these — and no simulator can answer that.
 *
 * ## A press has a duration here, and that is not decoration
 *
 * `sensors_sim.cpp` queues an *event*: one `Tap`, consumed once. LVGL reads a *level*, every
 * `LV_DEF_REFR_PERIOD` (33 ms), and needs to see the same finger on at least two consecutive reads
 * before it raises a click at all. A simulated touch that was down for one read would be silently
 * ignored, and a scenario written against it would look like a firmware that drops taps. So a
 * scripted tap here is held for `HOLD_MS` and then released, which is what a finger does.
 */

#include "../../pulse/pulse_touch.h"

#include <deque>

#include "Arduino.h"
#include "sim_touch.h"

namespace pulse_touch {

namespace {

/*
 * 160 ms down.
 *
 * Long enough that LVGL sees five reads of it at the 33 ms refresh period — comfortably past the two
 * it needs — and short enough that it cannot be mistaken for the long-press LVGL raises at 400 ms by
 * default. Both ends of that range matter: too short and taps vanish, too long and every scripted
 * tap is also a long press, and a scenario cannot tell you which one the firmware answered.
 */
constexpr uint32_t HOLD_MS = 160;

struct Press {
	int16_t x = 0;
	int16_t y = 0;
	uint32_t hold = HOLD_MS;
	uint32_t until = 0;
	bool started = false;
};

std::deque<Press> queued;
bool seen = false;

}  // namespace

void begin() {}

bool read(int16_t *x, int16_t *y) {
	if (queued.empty()) return false;
	Press &press = queued.front();
	if (!press.started) {
		press.started = true;
		press.until = millis() + press.hold;
	}
	if (millis() >= press.until) {
		queued.pop_front();
		return false;
	}
	seen = true;
	if (x != nullptr) *x = press.x;
	if (y != nullptr) *y = press.y;
	return true;
}

bool everSeen() {
	return seen;
}

void simQueuePress(int16_t x, int16_t y, uint32_t hold_ms) {
	Press press;
	press.x = x;
	press.y = y;
	if (hold_ms > 0) press.hold = hold_ms;
	queued.push_back(press);
}

}  // namespace pulse_touch
