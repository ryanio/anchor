/*
 * `pulse/pulse.ino`, compiled as itself.
 *
 * The same move `app_ino.cpp` makes for the blitter firmware, and for the same reason: a simulator
 * that ran a transcription of the firmware would answer questions about the transcription. Arduino
 * concatenates a sketch into one translation unit and hoists prototypes; this file is that step,
 * done by hand, for a sketch whose functions are all defined before they are used.
 *
 * So what runs on the desktop is the real `setup()` and the real `loop()`: the real LVGL, configured
 * by the real `pulse/lv_conf.h`, building the real screen out of `pulse_ui.cpp`, flushing through
 * the real `flush_cb` into a panel object that happens to be a framebuffer instead of a QSPI bus.
 * The only substitution is `pulse_touch.cpp` — `pulse_touch_sim.cpp` stands in for it, because the
 * thing it talks to is an I2C part that has never once answered with a coordinate on real hardware,
 * and simulating that would put an invention underneath every touch this harness delivers.
 */

#include "../../pulse/pulse.ino"

/*
 * The panel, handed to the harness.
 *
 * `panel` is file-static in the sketch, which is correct — nothing on the device has any business
 * reaching for it — so the accessor lives here, in the same translation unit, rather than in a
 * change to `pulse.ino` that exists only to be photographed.
 */
Arduino_CO5300 *simPanel() {
  return panel;
}
