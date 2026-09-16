/*
 * `app.ino`, compiled as itself.
 *
 * Included rather than copied, and that is the whole design: a simulator that ran a transcription
 * of the firmware would answer questions about the transcription. Arduino concatenates sketches
 * into one translation unit and hoists prototypes; this file is that step, done by hand, for a
 * sketch whose functions are all defined before they are used.
 *
 * `app/sensors.cpp` is the one source deliberately left out of the build — `sensors_sim.cpp` stands
 * in for it, for the reason written at the top of that file — exactly the swap the Cardputer's
 * simulator makes for `cable.cpp` and `standalone.cpp`.
 */

#include "../../app/app.ino"

/*
 * The panel, handed to the harness.
 *
 * `panel` is file-static in the sketch, which is correct — nothing on the device has any business
 * reaching for it — so the accessor lives here, in the same translation unit, rather than in a
 * change to `app.ino` that exists only to be photographed.
 */
Arduino_CO5300 *simPanel() {
  return panel;
}
