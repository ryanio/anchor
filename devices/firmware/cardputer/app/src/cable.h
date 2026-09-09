#pragma once

#include <stddef.h>
#include <stdint.h>

// The host link: newline delimited JSON over the USB C cable.
//
// This is Anchor's transport, not flint's. It lived in flint while Anchor was
// a view in that tree; it moved here with the view, because a firmware that
// nobody speaks NDJSON to has no use for it and Anchor is the only program on
// either end. flint's own seams are net and rest, over WiFi.
//
// The fourth transport in the firmware, beside WiFi, the IMU and the keyboard,
// and the only one where the other end is a program on a desktop rather than a
// public API. An app that reads it gets lines and sends lines, and never sees
// a Serial object: on a unit this is the USB CDC port, and in the simulator it
// is a replayed capture, which is what lets a view that needs a host be seen
// with nothing plugged in.
//
// Why a cable and not the network, since flint already speaks TLS. The first
// app to use this is Anchor, whose data service binds 127.0.0.1 and never the
// LAN. Reaching it from a Cardputer over WiFi would mean binding that service
// somewhere else, which is a decision with a person's name on it rather than
// an implementation detail. A cable keeps the unit exactly as trusted as a
// keyboard: a thing on the end of a wire, holding no credential of its own.
//
// The framing is safe rather than merely convenient. Every line is one JSON
// document, and a JSON encoder escapes every newline it could emit, so a
// message can never contain the byte that ends it. That matters because some
// of what arrives is a collection name somebody else chose.
namespace cable {

// A line longer than this is a fault rather than a message, and is dropped
// whole. The largest thing the Anchor host sends is a full repaint of ten
// slots, which measures about 1.4KB.
constexpr size_t MAX_LINE = 3072;

// Open the port. Safe to call more than once.
void begin();

// Throw away anything buffered and resync to the next newline.
//
// An app reads this port only while it is on screen, so what arrived while
// somebody was in the menu is stale by definition, and the front of it is
// probably half a line. Call this when the view opens.
void drain();

// The next complete line, without its terminator, or false when there is not
// one yet. Never blocks.
bool readLine(char *out, size_t n);

// Send one line. The terminator is added here so no caller has to remember it.
void writeLine(const char *line);

}  // namespace cable
