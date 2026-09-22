#include "standalone.h"

#include <Arduino.h>

#include <stdlib.h>
#include <string.h>

// The simulator's half of the device's own fetch, built instead of ../src/standalone.cpp — the same
// swap cable_sim.cpp makes for the cable, and the same one flint makes for net.cpp. There is no
// WiFi here and no OpenSea to call.
//
// This used to be a stub that simply never had data, with a note saying "if the rendering side ever
// needs a look with nothing plugged in, this is the file to teach a fixture". The browse mode is
// that moment: it is three facets, six status sentences and a state machine, and none of it could
// be looked at on a desktop while it was a stub.
//
// **The numbers below are real.** They are a captured `/tokens/trending?limit=8` response and the
// captured `/holders` and `/activity` responses for one of its rows, taken from the live API with a
// real key on 2026-09-17 — the same measurement that confirmed the field names in standalone.cpp,
// trimmed to the fields this device reads and formatted the way standalone.cpp formats them. A hand
// typed approximation would be a fixture that agrees with whatever the view happens to draw, which
// is the one thing a fixture must never do. The captures were taken with a unique `_cb` query
// parameter and answered `cf-cache-status: MISS`, so they came from the origin rather than from a
// CDN's memory of somebody else's request.
//
// It also plays the states in order rather than starting full: joining, then asking, then live,
// then a delay behind each opened row. A fixture that is instantly complete is a fixture in which
// every "why is this empty" sentence is unreachable, and those sentences are the part of this
// feature most likely to be wrong.
namespace standalone {

Token tokens[MAX_TOKENS];
size_t tokenCount = 0;

namespace {

Detail detailStore;

// The wall clock the fixture runs on, in milliseconds since the view opened. Short enough that a
// six second screenshot run reaches the list, long enough that the states before it are visible.
// Measured from the first `tick()`, which is the moment anchor.cpp starts drawing its own screen.
// Both are past STANDALONE_INTRO_MS on purpose: the intro card covers the first three seconds, so a
// join that finished inside it is a state nobody can look at, and these two states are the ones
// most likely to be wrong.
constexpr uint32_t JOIN_MS = 4000;
constexpr uint32_t FIRST_FETCH_MS = 5600;
// How long an opened row spends saying "asking OpenSea" before its depth lands. Two different
// numbers so the facets do not arrive together, which is what the real thing does: they are two
// requests, a gap apart.
constexpr uint32_t HOLDERS_MS = 1200;
constexpr uint32_t ACTIVITY_MS = 1900;

uint32_t openedAt = 0;
bool listed = false;
bool viewActive = false;
bool detailOpen = false;

struct Row {
	const char *symbol;
	const char *name;
	const char *price;
	const char *change;
	const char *volume;
	const char *chain;
	const char *address;
	bool up;
};

// `/api/v2/tokens/trending?limit=8`, 2026-09-17.
const Row TRENDING[] = {
    {"PONS", "Pons", "$0.6602", "+0.14%", "$15.5M", "robinhood",
     "0x39dbed3a2bd333467115de45665cc57f813c4571", true},
    {"STONK", "STONK", "$0.2360", "-8.31%", "$41.2M", "solana",
     "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", false},
    {"PENGU", "Pudgy Penguins", "$0.0119", "+3.90%", "$88.1M", "solana",
     "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", true},
    {"WIF", "dogwifhat", "$0.5312", "-2.04%", "$22.9M", "solana",
     "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", false},
    {"AERO", "Aerodrome", "$0.7741", "+6.62%", "$9.8M", "base",
     "0x940181a94a35a4569e4529a3cdfb74e38fd98631", true},
    {"BRETT", "Brett", "$0.0402", "-1.12%", "$5.1M", "base",
     "0x532f27101965dd16442e59d40670faf5ebb142e4", false},
    {"TOSHI", "Toshi", "$0.0004", "+11.30%", "$3.4M", "base",
     "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", true},
    {"USDC", "USD Coin", "$1.00", "+0.01%", "$1.2B", "ethereum",
     "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", true},
};
constexpr size_t TRENDING_COUNT = sizeof(TRENDING) / sizeof(TRENDING[0]);

// `/api/v2/chain/solana/token/6GmAFSY.../holders?limit=10`, 2026-09-17. Every `owner_display_name`
// in the real response was null, so every row here is a shortened address — that is what this
// screen looks like in practice, not an unlucky sample.
struct HolderRow {
	const char *who;
	const char *share;
	const char *value;
};
const HolderRow HOLDERS[] = {
    {"Beqv6d..qeit", "3.88%", "$9.1M"}, {"4ugDhH..ocwo", "2.09%", "$4.9M"},
    {"F5hkYs..xqs6", "1.81%", "$4.3M"}, {"7a8xxA..Ao49", "1.65%", "$3.9M"},
    {"7ELx7t..zrcW", "1.42%", "$3.4M"}, {"3nMFwZ..Ksp2", "1.11%", "$2.6M"},
    {"9WzDXw..AWWM", "0.98%", "$2.3M"}, {"HxhWkV..pump", "0.87%", "$2.0M"},
    {"5Q544f..1ztJ", "0.71%", "$1.7M"}, {"2ojv9B..kFCh", "0.64%", "$1.5M"},
};
constexpr size_t HOLDERS_COUNT = sizeof(HOLDERS) / sizeof(HOLDERS[0]);

// `/api/v2/chain/solana/token/6GmAFSY.../activity?limit=10`, 2026-09-17. Neither side of a swap
// carries a symbol in the real payload, which is why the counterparty is an address here too.
struct EventRow {
	const char *side;
	const char *counter;
	const char *value;
	bool buy;
};
const EventRow EVENTS[] = {
    {"BUY", "EPjFWd..TDt1v", "$0.79", true},    {"BUY", "EPjFWd..TDt1v", "$567.77", true},
    {"SELL", "So1111..11112", "$1.2K", false},  {"BUY", "EPjFWd..TDt1v", "$44.10", true},
    {"SELL", "EPjFWd..TDt1v", "$92.44", false}, {"BUY", "So1111..11112", "$310.02", true},
    {"SELL", "EPjFWd..TDt1v", "$18.75", false},
};
constexpr size_t EVENTS_COUNT = sizeof(EVENTS) / sizeof(EVENTS[0]);

void fillList()
{
	for (size_t i = 0; i < TRENDING_COUNT && i < MAX_TOKENS; i++) {
		Token &t = tokens[i];
		memset(&t, 0, sizeof(t));
		snprintf(t.symbol, sizeof(t.symbol), "%s", TRENDING[i].symbol);
		snprintf(t.name, sizeof(t.name), "%s", TRENDING[i].name);
		snprintf(t.price, sizeof(t.price), "%s", TRENDING[i].price);
		snprintf(t.change, sizeof(t.change), "%s", TRENDING[i].change);
		snprintf(t.volume, sizeof(t.volume), "%s", TRENDING[i].volume);
		snprintf(t.chain, sizeof(t.chain), "%s", TRENDING[i].chain);
		snprintf(t.address, sizeof(t.address), "%s", TRENDING[i].address);
		t.changePositive = TRENDING[i].up;
		tokenCount = i + 1;
	}
}

uint32_t since()
{
	return openedAt == 0 ? 0 : millis() - openedAt;
}

uint32_t detailOpenedAt = 0;

// The two requests land a gap apart, the way two requests do, so Holders is populated while
// Activity is still saying what it is waiting for. That pair of states on screen at once is the
// thing worth looking at, and a fixture that filled both at the same instant would never show it.
void fillDepth()
{
	if (!viewActive || !detailOpen || detailOpenedAt == 0) {
		return;
	}
	if (detailStore.holderCount == 0 && millis() - detailOpenedAt >= HOLDERS_MS) {
		for (size_t i = 0; i < HOLDERS_COUNT && i < MAX_HOLDERS; i++) {
			Holder &h = detailStore.holderRows[i];
			snprintf(h.who, sizeof(h.who), "%s", HOLDERS[i].who);
			snprintf(h.share, sizeof(h.share), "%s", HOLDERS[i].share);
			snprintf(h.value, sizeof(h.value), "%s", HOLDERS[i].value);
			detailStore.holderCount = i + 1;
		}
		snprintf(detailStore.totals, sizeof(detailStore.totals), "83128 holders");
		snprintf(detailStore.health, sizeof(detailStore.health), "BAD");
		detailStore.holders = {Status::Online, "up to date"};
	}
	if (detailStore.eventCount == 0 && millis() - detailOpenedAt >= ACTIVITY_MS) {
		for (size_t i = 0; i < EVENTS_COUNT && i < MAX_EVENTS; i++) {
			Event &e = detailStore.eventRows[i];
			snprintf(e.side, sizeof(e.side), "%s", EVENTS[i].side);
			snprintf(e.counter, sizeof(e.counter), "%s", EVENTS[i].counter);
			snprintf(e.value, sizeof(e.value), "%s", EVENTS[i].value);
			e.buy = EVENTS[i].buy;
			detailStore.eventCount = i + 1;
		}
		detailStore.activity = {Status::Online, "up to date"};
	}
}

// The three states this timeline never reaches on its own, on demand.
//
//   ANCHOR_SIM_STATE=disabled|nocreds|failed .pio/build/sim-anchor/program --keys "1"
//
// A unit with no key compiled in, a unit nobody has given a network to, and a unit whose last fetch
// was refused are exactly the screens a person at a venue is most likely to be holding, and none of
// them can be arranged by waiting. AGENTS.md's rule about the panel's fifteen states applies to this
// screen's six: a state nobody can look at is a state nobody has designed.
//
// `failed` keeps the rows, because that is what the real module does — stale and labelled beats
// absent and unexplained — so it is also the one way to see the strip carrying a warning over a
// list that still has data in it.
const char *forced()
{
	static const char *value = getenv("ANCHOR_SIM_STATE");
	return value;
}

bool forcedIs(const char *name)
{
	const char *value = forced();
	return value != nullptr && strcmp(value, name) == 0;
}

}  // namespace

void enter()
{
	viewActive = true;
}

void leave()
{
	viewActive = false;
	detailOpen = false;
	detailOpenedAt = 0;
	if (!listed) {
		openedAt = 0;
	}
}

void tick()
{
	if (!viewActive) {
		return;
	}
	if (openedAt == 0) {
		openedAt = millis() == 0 ? 1 : millis();
	}
	if (!listed && since() >= FIRST_FETCH_MS && !forcedIs("disabled") && !forcedIs("nocreds")) {
		listed = true;
		fillList();
	}
	fillDepth();
}

State state()
{
	if (forcedIs("disabled")) {
		return {Status::Disabled, "no OpenSea key in this build"};
	}
	if (forcedIs("nocreds")) {
		return {Status::NoCredentials, "no wi-fi yet: open Setup to join one"};
	}
	if (since() < JOIN_MS) {
		return {Status::Joining, "joining the saved network"};
	}
	if (!listed) {
		return {Status::Fetching, "asking OpenSea what is trending"};
	}
	if (forcedIs("failed")) {
		return {Status::Failed, "OpenSea refused this unit's key"};
	}
	return {Status::Online, "live from OpenSea"};
}

void openDetail(size_t index)
{
	if (index >= tokenCount) {
		return;
	}
	if (detailIsForToken(detailStore, tokens[index])) {
		detailOpen = true;
		if (detailStore.holders.status == Status::Fetching ||
		    detailStore.activity.status == Status::Fetching) {
			detailOpenedAt = millis() == 0 ? 1 : millis();
		}
		return;
	}
	memset(&detailStore, 0, sizeof(detailStore));
	snprintf(detailStore.address, sizeof(detailStore.address), "%s", tokens[index].address);
	snprintf(detailStore.chain, sizeof(detailStore.chain), "%s", tokens[index].chain);
	detailStore.holders = {Status::Fetching, "asking OpenSea who holds this"};
	detailStore.activity = {Status::Fetching, "asking OpenSea what just traded"};
	detailOpen = true;
	detailOpenedAt = millis() == 0 ? 1 : millis();
}

void closeDetail()
{
	detailOpen = false;
	detailOpenedAt = 0;
}

const Detail &detail()
{
	// Every row is the same token's, whichever row was opened: the fixture holds one capture, and
	// what is worth looking at on this screen is the layout and the state machine rather than eight
	// different holder lists. The `address` field is still the real one for the row that was opened,
	// so the depth check in anchor.cpp is exercised honestly.
	return detailStore;
}

}  // namespace standalone
