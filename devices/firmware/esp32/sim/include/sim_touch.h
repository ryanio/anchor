#ifndef ANCHOR_SIM_TOUCH_H
#define ANCHOR_SIM_TOUCH_H

/* The injection half of `sensors_sim.cpp`, kept out of `app/sensors.h` so the firmware's own
 * header stays the device's and nothing in `app/` can reach for a simulator-only call. */

#include <cstdint>

namespace sensors {
void simQueueTap(int16_t x, int16_t y);
void simQueueSwipe(int16_t from, int16_t to);
}  // namespace sensors

/*
 * And the same for the LVGL firmware, which reads a level rather than a gesture.
 *
 * Two injection points rather than one because the two firmwares genuinely ask their touch layer
 * different questions — `pulse_touch.h` has the argument for why LVGL cannot be fed from
 * `sensors::poll()`. A single shared queue would have to answer both, which means inventing the
 * translation this repo deliberately does not have.
 */
namespace pulse_touch {
/*
 * `hold_ms` of 0 means the default tap length. It is a parameter at all because LVGL's press state
 * machine measures duration and some behaviour is defined in terms of it: `pulse_wifi`'s way back
 * into Wi-Fi setup is a hold of about 1.4 s — `LV_EVENT_LONG_PRESSED` at 400 ms plus ten
 * `LV_EVENT_LONG_PRESSED_REPEAT`s — and a harness that could only produce 160 ms taps could not
 * drive it at all, which is the same "the test cannot reach the behaviour" hole that left the old
 * module's failure screen unexercised.
 */
void simQueuePress(int16_t x, int16_t y, uint32_t hold_ms = 0);
}  // namespace pulse_touch

#endif /* ANCHOR_SIM_TOUCH_H */
