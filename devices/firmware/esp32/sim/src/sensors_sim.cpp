/*
 * Touch, injected.
 *
 * `app/sensors.cpp` is a CST820 driver, and the CST820 on this board has never answered with a
 * coordinate — `docs/devices-esp32.md` says so in the section that keeps measured and assumed
 * apart. So the driver is exactly the wrong thing to run here: simulating an I2C part whose real
 * behaviour is unknown would put an invention underneath every touch this harness delivers.
 *
 * The seam is one layer up, at `sensors::Event`, which is the vocabulary `app.ino` and
 * `wifi_setup.cpp` actually speak: a kind and two numbers. A scenario says "a tap landed at
 * 100,180" and everything above that point — the routing in `loop()`, the hit tests, the state
 * machine — is the firmware's own code running unmodified. What stays unproven is the half below:
 * whether a finger on the glass ever becomes one of these. Nothing here can answer that, and
 * pretending otherwise is the failure this file is named after in the design doc.
 */

#include "sensors.h"

#include <deque>

namespace sensors {

namespace {

std::deque<Event> queued;
bool seen = false;

}  // namespace

void begin() {}

Event poll() {
  if (queued.empty()) return Event{};
  const Event event = queued.front();
  queued.pop_front();
  seen = true;
  return event;
}

bool touchSeen() {
  return seen;
}

void simQueueTap(int16_t x, int16_t y) {
  Event event;
  event.kind = Kind::Tap;
  event.a = x;
  event.b = y;
  queued.push_back(event);
}

void simQueueSwipe(int16_t from, int16_t to) {
  Event event;
  event.kind = Kind::Swipe;
  event.a = from;
  event.b = to;
  queued.push_back(event);
}

}  // namespace sensors
