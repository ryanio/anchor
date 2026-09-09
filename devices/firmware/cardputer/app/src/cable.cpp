#include "cable.h"

#include <Arduino.h>

#include <string.h>

// The unit's half of the host link. The simulator replaces this whole file
// with ../sim/cable_sim.cpp, the same way flint's simulator replaces net.cpp:
// the build filter takes one of the two, never both.
//
// Serial carries the boot report and the core's own debug output as well as
// this protocol, and that is fine in both directions: a host reader drops any
// line that is not JSON it understands, and this reader drops any line that
// does not parse. Mixing them costs one rule, which is that neither end may
// ever believe a line it only half read.

namespace cable {

namespace {

char buffer[MAX_LINE + 1];
size_t length = 0;
// True while a line too long, or a line we joined halfway through, is being
// stepped over. Dropping to the next newline is the only safe resync.
bool skipping = false;
bool started = false;

}  // namespace

void begin()
{
	if (started) {
		return;
	}
	started = true;
	Serial.begin(115200);
	// A write that blocks because nobody is reading the port would stall the
	// view loop, and a dropped keystroke is much cheaper than a frozen panel.
	Serial.setTxTimeoutMs(20);
}

void drain()
{
	while (Serial.available() > 0) {
		Serial.read();
	}
	length = 0;
	skipping = true;
}

bool readLine(char *out, size_t n)
{
	if (out == nullptr || n == 0) {
		return false;
	}
	while (Serial.available() > 0) {
		const int byte = Serial.read();
		if (byte < 0) {
			return false;
		}
		const char c = (char)byte;
		if (c == '\n') {
			const bool usable = !skipping && length > 0;
			skipping = false;
			if (!usable) {
				length = 0;
				continue;
			}
			buffer[length] = '\0';
			snprintf(out, n, "%s", buffer);
			length = 0;
			return true;
		}
		if (c == '\r' || skipping) {
			continue;
		}
		if (length >= MAX_LINE) {
			// Truncating would turn one long line into a different, shorter
			// message that happens to parse. Step over the rest instead.
			skipping = true;
			length = 0;
			continue;
		}
		buffer[length++] = c;
	}
	return false;
}

void writeLine(const char *line)
{
	if (line == nullptr) {
		return;
	}
	Serial.print(line);
	Serial.write('\n');
}

}  // namespace cable
