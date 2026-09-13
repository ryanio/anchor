#pragma once

#include <stddef.h>

// Trending tokens, fetched directly from OpenSea over WiFi when no host is on the cable.
//
// This exists for one reason: a Cardputer taken away from the desk (docs/devices-cardputer.md's
// cable-only design assumed it stayed put) has nothing to show, because Anchor's whole point is
// that the device holds no data and no credential of its own. Ryan chose live discovery data over
// either freezing on the last cable-fed frame or a static standby screen — an explicit override of
// flint's own CLAUDE.md ("No secrets on the device... if something seems to need a key, the design
// is wrong," naming Anchor as the reason for the rule), not an oversight. See
// app/src/secrets.h.example for OPENSEA_API_KEY and platformio.ini for FLINT_PROFILE_NETWORK.
//
// Deliberately narrow: trending tokens only, the same public discovery data
// `devices/src/state/discovery.ts` reads on the host side — never a wallet, never a portfolio,
// never anything that needs more than an API key scoped to public reads. `anchor.cpp` owns
// deciding *when* to show this (only once unlinked past a grace period, so a cable that is about
// to link is never pre-empted) and how to draw it; this module only owns fetching and parsing.
namespace standalone {

struct Token {
	char symbol[12];
	char name[24];
	// Formatted host-side-equivalent strings, not raw floats: this device has no reason to know
	// how a dollar figure is supposed to round, and state/anchor.ts's own usd() lives on the host
	// for exactly that reason. Formatted once, at fetch time, by this module.
	char price[16];
	char change[10];
	bool changePositive;
};

constexpr size_t MAX_TOKENS = 8;

// Zero until the first successful fetch lands.
extern Token tokens[MAX_TOKENS];
extern size_t tokenCount;

// Call every tick once flint's own `net::loop()` has run. Rate-limits itself; safe to call every
// frame. Does nothing until WiFi associates, and nothing at all unless OPENSEA_API_KEY is compiled
// in (a unit built from a checkout with no app/src/secrets.h stays exactly as silent about the
// network as the original cable-only design — see profile::network() gating whether the radio
// comes up at all).
void tick();

// True once at least one fetch has ever succeeded, so `anchor.cpp` knows whether to fall back to
// this data or keep showing "waiting for host".
bool hasData();

}  // namespace standalone
