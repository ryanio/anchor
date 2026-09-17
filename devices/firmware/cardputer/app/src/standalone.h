#pragma once

#include <stddef.h>
#include <stdint.h>

// What this unit shows when nothing is plugged into it, fetched by this unit.
//
// AGENTS.md settled what this file is for: "The Cardputer and the pulse display are wholly
// independent devices. The cable is for flashing them. That is its whole job." So this is not a
// fallback for a missing host any more, it is the device. A unit on a table at a venue fetches
// trending tokens over its own WiFi, and a person holding it can open one and read who holds it and
// what just traded, with no desktop anywhere in the picture.
//
// The browse mode that reads this was built host side first, in `devices/src/panel.ts`, the same day
// the ESP32 was made independent — a whole feature on the wrong side of the line. This is the same
// feature moved onto the unit: the same three facets in the same order, the same refusal to draw one
// item's holders under another item's name, and the same endpoints.
//
// Deliberately narrow: public discovery data only. Never a wallet, never a portfolio, never anything
// that needs more than an API key scoped to public reads. See app/src/secrets.h.example for
// OPENSEA_API_KEY and platformio.ini for FLINT_PROFILE_NETWORK, which is where the override of
// flint's own "no secrets on the device" rule is argued. This module owns fetching, parsing and
// saying what state it is in; it owns no pixels, and `anchor.cpp` owns every decision about drawing.
namespace standalone {

// Addresses are the widest untrusted string here and the one a URL is built from. An EVM address is
// 42 characters; a Solana mint is base58 and measured at 43 and 44 in the live trending response
// (`6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx`, 2026-09-17). 48 holds either with room, and
// `sameAddress` never compares past it.
constexpr size_t ADDRESS_MAX = 48;

struct Token {
	char symbol[12];
	char name[24];
	// Formatted strings, not raw floats: this device has no reason to hold an opinion about how a
	// dollar figure rounds, and `state/anchor.ts`'s usd() lives on the host for exactly that reason.
	// Formatted once, at fetch time, by this module — the same convention `esp32/app/feed.cpp` keeps,
	// so two Anchor units on one table never round the same token two ways.
	char price[16];
	char change[10];
	char volume[16];
	// The chain a row is actually on, read per row rather than assumed. Measured 2026-09-17: the
	// trending list answered with `robinhood` first and `solana` second while this project's primary
	// chain is Ethereum, and the chain is a path segment of the holders and activity URLs — a row
	// whose chain was assumed would ask the wrong server about the right token.
	char chain[16];
	char address[ADDRESS_MAX];
	bool changePositive;
};

constexpr size_t MAX_TOKENS = 8;

// One ranked holder, already formatted.
struct Holder {
	// `owner_display_name` when the API has one, and a shortened address when it does not. Measured
	// 2026-09-17: every holder in the sampled response had `owner_display_name: null`, so the short
	// address is the ordinary case rather than the fallback.
	char who[26];
	char share[10];
	char value[16];
};

// One swap out of the token's own feed.
struct Event {
	// Which way it went, decided here rather than drawn from the payload: a swap event names two
	// tokens and neither carries a symbol (measured 2026-09-17, and `state/discovery.ts`'s
	// `readTokenActivity` says the same), so the only readable thing on a 240px row is whether the
	// token somebody opened was bought or sold, and what against.
	char side[6];
	char counter[18];
	char value[16];
	bool buy;
};

constexpr size_t MAX_HOLDERS = 10;
constexpr size_t MAX_EVENTS = 10;

// Why a screen is empty, in the vocabulary a screen needs.
//
// Lifted from `esp32/app/feed.h`, which wrote it first, and kept in the same order: how far along
// the chain the answer stopped. These are not log levels — each one is a different sentence for a
// person holding the unit, and a UI that renders all six never has to draw a blank rectangle and
// hope. AGENTS.md: an empty list must say why it is empty. This project has already shipped a blank
// screen that meant six things.
enum class Status : uint8_t {
	// No OPENSEA_API_KEY compiled in. Nothing here will ever touch the network.
	Disabled,
	// No network saved on the unit. flint's own Setup view (src/views/setup.cpp) is where somebody
	// holding it types one, and it is in this profile for that reason.
	NoCredentials,
	// Credentials exist, the station has not associated yet.
	Joining,
	// Associated and idle, waiting for the poll window.
	Online,
	// A request is in flight.
	Fetching,
	// The last attempt failed. `reason` says how far it got, and any rows still held are the last
	// good ones — stale and labelled beats absent and unexplained.
	Failed,
};

// A status and the compiled-in sentence that goes with it. Never a string that came off the network:
// see `copyBounded` in standalone.cpp for what response bytes are treated as.
struct State {
	Status status;
	const char *reason;
};

// The depth behind the one item that is open.
//
// `address` is the whole safety property. `discoveryDetail` on the host holds one item's worth of
// holders and activity, and between opening a second item and its fetch landing it still holds the
// first item's — so `panel.ts`'s `#browseDepth` refuses to draw depth whose id is not the open id.
// The same refusal has to exist here, and it is spelled `sameAddress(detail().address, ...)`. A
// holder list under the wrong token's name is the failure AGENTS.md rates above every other: a
// plausible answer that is not an answer to the question asked.
struct Detail {
	char address[ADDRESS_MAX];
	char chain[16];
	// Formatted once at fetch time: "83,128 holders" is not something a draw loop should be deciding
	// how to punctuate.
	char totals[24];
	// `health_label` — STRONG, HEALTHY, CONCERNING or BAD. The API's own judgement, not derived here.
	char health[16];
	State holders;
	State activity;
	Holder holderRows[MAX_HOLDERS];
	size_t holderCount;
	Event eventRows[MAX_EVENTS];
	size_t eventCount;
};

// Zero until the first successful fetch lands.
extern Token tokens[MAX_TOKENS];
extern size_t tokenCount;

// Call every tick once flint's own `net::loop()` has run. Rate limits itself and defers around the
// keyboard; safe to call every frame. Does nothing at all unless OPENSEA_API_KEY is compiled in.
void tick();

// Why the trending list looks the way it does, whether or not it has rows.
State state();

// Open the depth behind one row, by index into `tokens`. Cheap and non blocking: it records what to
// ask for and the next `tick()` that finds the reader still does the asking. Reopening the item that
// is already open keeps what was already fetched rather than asking again — somebody stepping Tab
// through three facets is not three requests.
void openDetail(size_t index);

// Nothing is open. Keeps the fetched depth, so backing out and opening the same row again is free.
void closeDetail();

// The depth for whatever was last opened. Always check `address` against the item being drawn.
const Detail &detail();

// Two addresses naming the same thing, bounded by ADDRESS_MAX.
//
// Case insensitive for `0x` hex, because the same EVM address arrives checksummed in one response
// and lower case in another. Case *sensitive* for everything else, because a Solana mint is base58
// and `A` and `a` are two different characters in it — folding case there would let two different
// mints compare equal, which is the exact confusion this function exists to prevent.
bool sameAddress(const char *a, const char *b);

}  // namespace standalone
