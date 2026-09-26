#ifndef ANCHOR_PULSE_SETTINGS_H
#define ANCHOR_PULSE_SETTINGS_H

#include "pulse_face.h"

/*
 * Settings, and the one setting that is a matter of taste: which face the companion wears.
 *
 * The choice is kept in NVS by name ("halo", "visor"...), so reordering `pulse_face::Style` never
 * changes somebody's face. A unit that has never been asked wears Halo, and `faceChosen()` stays
 * false until a person picks, which is how setup knows to offer the picker once, after the first
 * network joins, and never again.
 *
 * Both screens are built when opened and deleted when left: the picker holds a 105 KB canvas in
 * PSRAM and a timer, and neither has any business existing while nobody is looking at it.
 */
namespace pulse_settings {

using Action = void (*)();

void begin(Action openWifi);

pulse_face::Style face();
bool faceChosen();

void openSettings();
/* `firstRun` words the picker as a setup step rather than a setting. */
void openFacePicker(bool firstRun);

}  // namespace pulse_settings

#endif /* ANCHOR_PULSE_SETTINGS_H */
