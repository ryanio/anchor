#ifndef ANCHOR_PULSE_WIFI_H
#define ANCHOR_PULSE_WIFI_H

#include <lvgl.h>

/*
 * Joining a Wi-Fi network from the glass, in LVGL's own widgets.
 *
 * This replaces `app/wifi_setup.cpp` for the `pulse/` firmware. That module is the requirements
 * document for this one — pick a network, type its passphrase, see whether it joined, remember it —
 * and it is also the argument for not writing a second one the same way. It hand-drew a keyboard and
 * a network list against Arduino_GFX, and a single afternoon in `sim/` found seven bugs in it, of
 * which five were not logic mistakes at all but consequences of owning the drawing and the
 * hit-testing separately:
 *
 *   - the join *result* was never drawn, because the redraw condition was a hand-maintained list of
 *     "things that changed" and `connectResultKnown` was not on it. A unit that joined the network
 *     and wrote its credentials to NVS went on showing "connecting" with a frozen spinner.
 *   - the passphrase that got persisted was whatever was in the keyboard buffer, not the one the
 *     radio was handed — type three characters, back out, tap an *open* network, and those three
 *     characters were saved as that network's password.
 *   - `WL_CONNECT_FAILED` was ignored, so the one mistake this screen exists to let somebody correct
 *     took the full twenty-second timeout to be reported.
 *   - a third of the panel below the drawn keys still fired JOIN and DEL, so a palm at (320,420)
 *     submitted a passphrase.
 *   - a 32-character SSID is 384 px at text size 2 on a 368 px panel, and Arduino_GFX wraps rather
 *     than clips, so the network's name landed across the top row of keys.
 *   - "the strongest six networks" were the first six the radio returned, because the collect loop
 *     stopped at six before sorting.
 *   - and entries past the sixth were collected into a list that could not scroll, so they were
 *     sorted, stored, and unreachable.
 *
 * `lv_keyboard`, `lv_textarea` and `lv_list` are tested code that already own hit-testing, scrolling,
 * shift state, password masking and text entry. Four of those seven cannot be written again here:
 * LVGL invalidates what changed rather than being told to, a control exists exactly where it is
 * drawn because the object *is* the hit target, a label with a width ellipsizes instead of wrapping
 * onto its neighbour, and a list scrolls. The other three are this file's to get right, and the notes
 * in `pulse_wifi.cpp` say where.
 *
 * ## What this owns, and what it does not
 *
 * It owns **its own LVGL screen**, not a region of somebody else's. `open()` remembers whatever
 * screen was active, loads this one, and `close()` puts the old one back — so the ambient readout in
 * `pulse_ui.cpp` is never rebuilt, never partly overdrawn, and does not have to know this module
 * exists. That is also why the whole thing is four calls from `pulse.ino`.
 *
 * It does **not** decide when the device wants a network. `tick()` opens setup by itself in exactly
 * one case — nothing is saved, so there is no other way in — and every other transition is the
 * caller's or the user's. In particular a *saved* network that fails to join does not steal the
 * screen: it keeps retrying quietly and says so through `status()`, because a display that is
 * working is worth more than a setup screen nobody asked for, and an AP that drops for ten seconds
 * is not a provisioning problem.
 *
 * Up to four successfully joined networks land in NVS under `anchor-wifi`. The active profile is
 * also written to the legacy `ssid` and `pass` keys so `app/wifi_setup.cpp` and older firmware keep
 * booting on the same network. A failed replacement never overwrites the last known good profile.
 */
namespace pulse_wifi {

/*
 * Load the saved network and start joining it in the background. Call once, after `lv_init()`, after
 * a display exists, and after whatever screen the device shows at rest has been built.
 *
 * Draws nothing. Whether this module ever takes the screen is `tick()`'s decision, and on a unit
 * that already has a network it never does.
 */
void begin();

/*
 * Call every `loop()` pass. Cheap when nothing is happening: a couple of comparisons against
 * `millis()` and, while a scan or a join is outstanding, one status read.
 */
void tick();

/* True while this module owns the screen. The caller should skip whatever it does to its own screen
 * while this holds — a footer ticking against a screen that is not loaded is work for nobody. */
bool active();

/* Enter setup deliberately. Safe to call at any time, including while already active. */
void open();

/* Leave setup and put back the screen that was loaded when `open()` ran. */
void close();

/* Whether the station is associated right now. Read from the radio, not from a flag this module set
 * when it thought it had succeeded — "present is not works", and a join that dropped an hour ago
 * should not still be reported as a connection. */
bool connected();

/* Whether at least one successfully joined network is saved on this unit. */
bool configured();

/* Changes whenever the intended network changes. Feed requests carry this value so a completion
 * from the previous network cannot publish after setup, switching, or clearing. */
uint32_t revision();

/* Forget every remembered network and disconnect. Safe while offline. The setup screen remains the
 * path back in, and no failed join ever calls this or overwrites a last known good profile. */
bool clearSaved();

/*
 * One line about where this module actually is, for a footer or a boot log.
 *
 * It always says something, including in the two cases the old module was silent about: no
 * credentials saved at all, and a saved network that is not answering. A screen that says nothing
 * about why it is empty is the failure AGENTS.md names outright, and "no network" is precisely the
 * state a person standing next to the device needs told.
 *
 * The pointer is to a static buffer owned here; copy it if you need to keep it.
 */
const char *status();

/*
 * Make a long press on `target` open setup.
 *
 * `app/wifi_setup.cpp` used five taps in a corner within three seconds, which needed a ring buffer
 * of timestamps, a window, and a 64x64 zone that only the drawing code knew about. LVGL already runs
 * the press state machine this needs, so the gesture is a hold: `LV_EVENT_LONG_PRESSED` at 400 ms
 * followed by ten `LV_EVENT_LONG_PRESSED_REPEAT`s at 100 ms, which is about 1.4 s of deliberate
 * contact. It is better than the tap count on three counts — it cannot be produced by a brush or by
 * somebody picking the unit up, it has no coordinate that can drift out of step with what is drawn,
 * and it works anywhere on the object rather than in a corner nobody can see.
 *
 * What it costs: it is not discoverable. Neither was five corner taps. The discoverable path is that
 * a unit with nothing saved opens setup on its own.
 */
void attachOpenGesture(lv_obj_t *target);

}  // namespace pulse_wifi

#endif /* ANCHOR_PULSE_WIFI_H */
