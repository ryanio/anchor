/*
 * `app/sensors.cpp`, compiled into this sketch rather than copied into it.
 *
 * `pulse_touch.cpp` calls `sensors::begin()` for the TCA9554 touch-reset release, which is the one
 * piece of bring-up on this board that nobody would arrive at by reading a datasheet. Arduino only
 * compiles sources inside the sketch directory, so the choice was a copy or a one-line include, and
 * a copy of a driver is a second place for the next hardware finding to have to land. `sim/` already
 * makes exactly this move in `app_ino.cpp`, for the same reason and with the same shape.
 *
 * `app/` is read-only to this sketch — it is the firmware that currently works and there is a
 * deadline on it — so this is the whole of the coupling: one include, no edits, and if something in
 * `sensors.cpp` ever needs to change for LVGL's sake, that is a report to a human rather than a
 * patch from here.
 */

#include "../app/sensors.cpp"
