#include <stdio.h>
#include <string.h>

#include <Arduino.h>

#include "cable.h"

// The simulator's half of the host link.
//
// Built instead of ../src/cable.cpp by the sim environment, which is the same
// swap flint makes for net.cpp. Both halves live in this repository because
// the protocol does.
//
// A unit reads a desktop over USB CDC. There is no cable here, so this replays
// a capture instead: real bytes, written by the real Anchor adapter against
// its real panel config, taken with
//
//   node scripts/cardputer-session.ts --page anchor
//
// in the Anchor checkout. A hand typed approximation would be a fixture that
// agrees with whatever the view happens to draw, which is the one thing a
// fixture must never do. The session below is the Anchor page with the data
// service stopped, which is worth seeing on its own: every reading is a dash
// rather than a zero, because a zero is a reading and there is nothing to read.
//
// Anything the view sends is printed rather than dropped, so the key protocol
// can be read from a terminal with no unit attached.

namespace {

const char SESSION[] = R"NDJSON(
{"t":"hello","proto":1}
{"t":"theme","name":"Catppuccin","dark":true,"tokens":{"ground":"#161622","raised":"#313244","sunken":"#101019","ink":"#cdd6f4","inkDim":"#6c7086","inkStrong":"#cdd6f4","accent":"#89b4fa","positive":"#a6e3a1","negative":"#f38ba8","warning":"#f9e2af","line":"#45475a"}}
{"t":"backlight","percent":70}
{"t":"frame","ops":[{"id":"strip:0","x":0,"y":0,"w":240,"h":18,"s":{"kind":"bar","segments":[{"icon":"","text":"anchor · not running","tone":"accent"},{"icon":"","text":"08:01 PM"},{"icon":"","text":"Catppuccin","tone":"inkDim"}]}},{"id":"key:0","x":0,"y":18,"w":80,"h":35,"sel":true,"s":{"kind":"tile","icon":"","label":"Money","emphasis":"ground"}},{"id":"key:1","x":80,"y":18,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"OpenSea","emphasis":"ground"}},{"id":"key:2","x":160,"y":18,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"Held","value":"—","emphasis":"ground"}},{"id":"key:3","x":0,"y":53,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"Coll 1","value":"—","emphasis":"ground"}},{"id":"key:4","x":80,"y":53,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"Coll 2","value":"—","emphasis":"ground"}},{"id":"key:5","x":160,"y":53,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"P&L","value":"—","emphasis":"ground"}},{"id":"key:6","x":0,"y":88,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"Config","emphasis":"ground"}},{"id":"key:7","x":80,"y":88,"w":80,"h":35,"s":{"kind":"tile","icon":"","label":"Lock","emphasis":"ground"}},{"id":"key:8","x":160,"y":88,"w":80,"h":35,"s":{"kind":"tile","emphasis":"ground"}}]}
{"t":"query","active":true,"text":""}
{"t":"query","active":true,"text":"a"}
{"t":"query","active":true,"text":"az"}
{"t":"query","active":true,"text":"azu"}
{"t":"query","active":true,"text":"azuk"}
{"t":"query","active":true,"text":"azuki"}
{"t":"query","active":false,"text":""}
)NDJSON";

size_t at = 0;
uint32_t opened = 0;
uint32_t lastLine = 0;
bool running = false;

// A panel would be waiting for its host for a moment on a real desk, and that
// screen is worth seeing here too.
constexpr uint32_t OPEN_DELAY_MS = 600;
// Slow enough that the states the panel goes through are watchable rather
// than a flicker: waiting for a host, painted, and a filter box open over it.
constexpr uint32_t LINE_MS = 350;
constexpr uint32_t PING_MS = 5000;

}  // namespace

namespace cable {

void begin()
{
}

void drain()
{
	at = 0;
	opened = millis();
	lastLine = 0;
	running = true;
	while (SESSION[at] == '\n') {
		at++;
	}
}

bool readLine(char *out, size_t n)
{
	if (!running || out == nullptr || n == 0) {
		return false;
	}
	const uint32_t now = millis();
	if (now - opened < OPEN_DELAY_MS || now - lastLine < LINE_MS) {
		return false;
	}
	lastLine = now;

	if (SESSION[at] == '\0') {
		// The capture has run out. A host that has painted everything it has
		// still speaks every five seconds, and silence is what a view reads as
		// a lost link, so the heartbeat keeps going.
		if (now - opened < PING_MS) {
			return false;
		}
		opened = now;
		snprintf(out, n, "{\"t\":\"ping\"}");
		return true;
	}

	const char *rest = SESSION + at;
	const char *end = strchr(rest, '\n');
	const size_t length = end == nullptr ? strlen(rest) : (size_t)(end - rest);
	if (length == 0) {
		at++;
		return false;
	}
	const size_t copy = length + 1 < n ? length : n - 1;
	memcpy(out, rest, copy);
	out[copy] = '\0';
	at += end == nullptr ? length : length + 1;
	return true;
}

void writeLine(const char *line)
{
	printf("sim link tx: %s\n", line == nullptr ? "" : line);
	fflush(stdout);
}

}  // namespace cable
