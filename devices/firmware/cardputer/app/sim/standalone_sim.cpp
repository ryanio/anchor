#include "standalone.h"

// The simulator has no WiFi and no OpenSea to call — this is the desktop-side stand-in, the same
// role sim/cable_sim.cpp plays for the cable. Standalone mode is a hardware-only feature by nature
// (a battery-powered unit away from the desk), so this stub simply never has data, which
// anchor.cpp already treats as "keep showing the standby screen" — the same thing it did before
// standalone.cpp existed at all. If the rendering side of standaloneTokens() ever needs a look
// with nothing plugged in, this is the file to teach a fixture, not app/src/standalone.cpp.

namespace standalone {

Token tokens[MAX_TOKENS];
size_t tokenCount = 0;

void tick() {}

bool hasData()
{
	return false;
}

}  // namespace standalone
