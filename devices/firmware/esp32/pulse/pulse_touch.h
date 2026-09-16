#ifndef ANCHOR_PULSE_TOUCH_H
#define ANCHOR_PULSE_TOUCH_H

#include <stdint.h>

/*
 * The CST820, as the raw pressed/released stream LVGL wants.
 *
 * ## Why this is not `sensors::poll()`
 *
 * The task this file exists to do was first tried the obvious way — call `sensors::poll()` from the
 * indev read callback and turn a `Tap` into a press. It does not work, and the reason is a genuine
 * mismatch rather than a missing line:
 *
 *   - **`sensors.h` reports gestures; LVGL reads a level.** `poll()` returns `Kind::None` for the
 *     whole time a finger is on the glass and emits exactly one `Tap` at the lift, 40 ms after the
 *     controller last reported a finger (`LIFT_SETTLE_MS`, which is there because this part reports
 *     a spurious zero-finger frame mid-contact). LVGL calls its read callback every
 *     `LV_DEF_REFR_PERIOD` and asks "is it down, and where" — an indev fed from `poll()` would see
 *     RELEASED for the entire contact and then a single sample that is PRESSED and RELEASED at the
 *     same instant. LVGL needs at least two consecutive reads to raise a click at all, so most taps
 *     would land on nothing, and press-and-hold, drag, scroll and the pressed-state highlight — the
 *     things a touch UI is made of — have no input to work from whatsoever.
 *   - **It would also be wrong about the coordinate.** A `Swipe` event carries `a` and `b` as two
 *     *x* values with no y at all, which is the right shape for "turn the page" and the wrong shape
 *     for "which widget is under the finger".
 *   - **`poll()` has one consumer by contract.** `app/app.ino` says so in a comment and routes the
 *     single event to either the host session or Wi-Fi setup. Adding a second caller silently halves
 *     the gestures each of them sees.
 *
 * So the gestures are not forced through an API that wants raw state. This reads the controller
 * directly — with the *same* access pattern `app/sensors.cpp` proved on this silicon, single
 * registers with a stop between the address and the read, because this part refused a six-byte burst
 * from 0x01 while answering the identical registers one at a time — and hands LVGL a level.
 *
 * ## What is emphatically not reinvented
 *
 * `begin()` below calls `sensors::begin()` and does nothing else to the bus, because that function
 * carries the single non-obvious fact this board has produced: **the CST820's reset line is not a
 * GPIO.** It hangs off a TCA9554 IO expander at 0x20, bit 2, and until somebody found that, the
 * controller answered every identity read and never once reported a coordinate. It also sets the
 * bus to 400 kHz, bounds `Wire.setTimeOut` so a stalled slave cannot take the UI thread down with
 * it, and holds TP_INT at its idle level. Losing any of that is losing the only touch bring-up this
 * project has that works, so it is called rather than copied.
 *
 * ## What no desk can tell you
 *
 * Whether the raw coordinates need flipping or swapping to land on the pixel under the finger.
 * `docs/devices-esp32.md` records that this controller has never answered with a coordinate on this
 * board at all, so orientation is not merely unverified — the thing that would produce the number
 * has not been seen to produce one. `ORIENTATION` below is the identity mapping and says so; it is
 * the first thing to check with a finger on lit glass, and `pulse.ino` prints every raw sample so
 * that check costs one flash and no code.
 */
namespace pulse_touch {

/* Wake the controller. Must run after `Wire` exists; `sensors::begin()` does the rest. */
void begin();

/*
 * Is there a finger on the glass right now, and where.
 *
 * Returns false when nothing is down *or* when the bus did not answer — which are deliberately the
 * same answer here. A controller that has gone quiet is not a controller reporting a press, and a
 * UI that latches "pressed" because an I2C read failed is a UI that fires whatever is under the
 * last coordinate.
 */
bool read(int16_t *x, int16_t *y);

/* Has this ever returned a coordinate? For the boot banner, and for the honest half of the report
 * above: on this board, as of writing, nothing has ever made it true. */
bool everSeen();

}  // namespace pulse_touch

#endif /* ANCHOR_PULSE_TOUCH_H */
