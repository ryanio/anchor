#ifndef ANCHOR_PULSE_SENSORS_H
#define ANCHOR_PULSE_SENSORS_H

#include <Arduino.h>

/*
 * The touch panel this board has had all along.
 *
 * `probe/` found a CST820 at 0x15 and a QMI8658 IMU at 0x6B by asking each address for its identity
 * register, and `sensors/` then checked what they say when a person actually uses them. The IMU
 * came back immediately: WHO_AM_I 0x05, revision 0x7C, configuration registers reading back exactly
 * as written, and a clean 1.05g gravity vector at the ±2g scale factor. The touch controller
 * identified itself (chip 0xB7, vendor 0x41) and then produced no coordinates at all — which is
 * why the reads below are written to be *survivable* rather than trusted: the numbers in this file
 * are the family's documented register map, and whether this part serves them is the open question
 * this code exists to answer with the screen still lit.
 *
 * Two rules it must never break, both of which cost a debugging round on this device already:
 *
 *   1. **Never block the protocol loop.** `Serial` here is the wire, and the decoder is fed from
 *      `loop()`. An I2C transaction that stalls is a frame that arrives late, and a frame that
 *      arrives late enough is a fault. Every read here is bounded and throttled.
 *   2. **Never print.** Anything written to `Serial` after the banner lands in the middle of the
 *      protocol stream and is correctly read as a device talking nonsense.
 *
 * The IMU is deliberately *not* wired to an input. It works — it is the one of the two that is
 * proven — but this display's job is to sit still on a desk and be glanced at, and a page that
 * turns because somebody set a mug down next to it is a worse device, not a richer one. The
 * Cardputer is the unit that gets tilt, because it is the one already in a hand. This is a
 * judgement about what the device is for, not a limit of what it can do.
 */
namespace sensors {

/* What a gesture came out as. `None` is the ordinary answer and costs nothing to receive. */
enum class Kind : uint8_t { None, Tap, Swipe };

struct Event {
	Kind kind = Kind::None;
	/* Tap: where. Swipe: `a` is where the finger went down and `b` where it came up, in panel x. */
	int16_t a = 0;
	int16_t b = 0;
};

/*
 * Wake what needs waking, once, after `Wire.begin()`. Safe to call on a board with neither chip on
 * it: every read is checked and a missing device simply never produces an event.
 */
void begin();

/*
 * Poll on the caller's beat and return at most one gesture.
 *
 * Recognition is done here from raw coordinates rather than read out of the controller's own
 * gesture register, because parts in this family differ over whether that register is populated at
 * all without extra configuration, while the coordinates are always there. A finger that goes down
 * and comes up near where it started is a tap; one that travels far enough sideways is a swipe. The
 * in-between case is deliberately neither: a smudge should not page a display.
 */
Event poll();

/* Whether the touch controller has ever answered with a coordinate. For the banner, before READY. */
bool touchSeen();

}  // namespace sensors

#endif /* ANCHOR_PULSE_SENSORS_H */
