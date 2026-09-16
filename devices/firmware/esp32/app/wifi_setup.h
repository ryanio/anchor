#ifndef ANCHOR_PULSE_WIFI_SETUP_H
#define ANCHOR_PULSE_WIFI_SETUP_H

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

#include "sensors.h"

/*
 * A touch keyboard on a device whose whole design is "no fonts, no layout, the host renders."
 *
 * `docs/devices-esp32.md` argues that case in full and picks a QR code for the identity screen
 * specifically *because* it needs no font. This module is the deliberate, reasoned exception to
 * that rule, made the same way `standalone.h`'s OPENSEA_API_KEY is one on the Cardputer side: typed
 * on the unit rather than compiled in, because the alternative — a phone-facing captive portal — is
 * more in the spirit of the architecture but not what carrying a unit away from a desk and joining a
 * strange WiFi network actually wants to be. Ryan chose this with the trade-off named, not by
 * default.
 *
 * Kept narrow on purpose: this module draws exactly one thing — pick a network, type its passphrase,
 * see whether it joined — and nothing else here grows a font, a palette or a general layout engine.
 * Anything past WiFi (a standalone renderer for actual portfolio data) is a separate, larger decision
 * `docs/devices-esp32.md` explicitly leaves open, and this module does not pre-empt it.
 *
 * Ownership while active: this module takes the panel and every touch event, the same way `probe/`,
 * `panel/` and `sensors/` each own the board outright as a sketch. The difference is this lives
 * inside `app/` and hands control back the moment a host is present — a cable that is plugged in (or
 * plugged back in mid-setup) always wins, because being a good blitter for a host is this firmware's
 * first job and WiFi setup is only for the moments nobody is offering it one.
 */
namespace wifi_setup {

/*
 * Call once, after `panel->begin()` has succeeded and after `sensors::begin()`.
 *
 * Loads any saved network from NVS and, if one exists, starts an opportunistic station connect in
 * the background — it costs nothing to have joined WiFi by the time something wants it, and showing
 * the result is how "present" becomes "measured" per AGENTS.md rather than an assumption nobody
 * checked. Draws nothing yet: whether this module ever takes the panel is `tick()`'s decision.
 */
void begin(Arduino_CO5300 *gfx, uint16_t width, uint16_t height);

/*
 * True while this module owns the panel and touch input. `app.ino`'s loop checks this before routing
 * a touch event to the protocol path, and skips its own idle-screen assumptions while it holds.
 */
bool active();

/*
 * Call every `loop()` pass, host-connected or not. Internally a no-op past its own throttle except
 * while `active()`, so calling it unconditionally costs a few comparisons on every pass that isn't
 * drawing anything.
 *
 * `hostLinked` is `(bool)Serial` from `app.ino` — the same connection signal the protocol loop
 * already trusts for "is a cable actually open right now". Setup can only ever be entered without
 * one, and a link appearing mid-flow ends it immediately, mid-screen if it has to: a device that
 * blits for a host that just showed up should not keep drawing over what the host is about to send.
 */
void tick(bool hostLinked);

/*
 * Route one touch event to this module. Only meaningful while `active()`; harmless otherwise. Also
 * where the corner-tap gesture that re-opens setup with an existing saved network is recognised, so
 * `app.ino` should offer this every gesture regardless of `active()`'s current value.
 */
void handleTouch(const sensors::Event &event);

}  // namespace wifi_setup

#endif /* ANCHOR_PULSE_WIFI_SETUP_H */
