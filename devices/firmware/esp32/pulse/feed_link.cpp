/*
 * `app/feed.cpp`, compiled into this sketch rather than copied into it.
 *
 * The same move `sensors_link.cpp` makes, for the same reason: Arduino only compiles sources inside
 * the sketch directory, and a copy of the data layer would be a second place for the next finding
 * about OpenSea's response shape to have to land. `app/` stays read-only to this sketch.
 *
 * Note what this drags in — HTTPClient, NetworkClientSecure, a FreeRTOS task and the certificate
 * bundle — and note that none of it reaches `pulse_ui.cpp` or `pulse_feed_view.cpp`. That is
 * deliberate: those two are the pieces the desktop simulator compiles, and shimming a TLS stack to
 * look at a screen would be a day spent on the wrong problem. `pulse.ino` is the only file in this
 * sketch that knows the feed exists, and the simulator substitutes its own `pulse_ino.cpp`.
 */

#include "../app/feed.cpp"
