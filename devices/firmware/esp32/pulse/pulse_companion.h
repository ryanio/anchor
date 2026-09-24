#ifndef ANCHOR_PULSE_COMPANION_H
#define ANCHOR_PULSE_COMPANION_H

#include <lvgl.h>

#include "pulse_companion_model.h"

/*
 * The companion, drawn: a character on its own LVGL screen that blinks, breathes, reacts to the
 * readings, and says one of them each time it is tapped. See `pulse_companion_model.h` for what it
 * reacts to and why none of it is invented.
 *
 * It owns its screen the way Explore does. `open()` loads it; Explore's Back returns to it because
 * Explore remembers whichever screen opened it.
 */
namespace pulse_companion {

using Action = void (*)();

void begin(Action openExplore, Action openWifi);
void open();
bool active();

/* The empty glass behind the character, for gestures such as the Wi-Fi hold that belong on the home
 * screen. Builds the screen if it is not built yet. */
lv_obj_t *surface();

/* Called on each feed refresh with the latest readings. Cheap when nothing changed. */
void update(const Inputs &inputs);

/* The mood currently drawn, for tests and the simulator. */
Mood mood();

}  // namespace pulse_companion

#endif /* ANCHOR_PULSE_COMPANION_H */
