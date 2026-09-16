/*
 * `app/feed.cpp`'s interface, answered from a scenario instead of from OpenSea.
 *
 * The real module is a FreeRTOS task, a TLS session and a streaming JSON parse. None of that belongs
 * on the desktop — `feed.cpp`'s own parser is already exercised directly against captured payloads,
 * which is the half worth testing that way. What is *not* testable that way, and what this file
 * exists for, is the half a person actually looks at: what the panel says in each of the six states
 * the feed can be in.
 *
 * That matters more here than it would elsewhere, because five of those six states are states with
 * no data in them, and the rule they answer to is not a preference:
 *
 *     An empty list must say why it is empty.  — AGENTS.md
 *
 * A unit handed to somebody at an offsite spends its first minutes in exactly those states — nothing
 * typed in yet, joining, joined but not fetched — and each one has a different answer to "what do I
 * do about this". Before this file the only way to see any of them was to flash a board, unplug it,
 * and wait. Now: `--feed no-credentials`, and look.
 *
 * Selected with `--feed <state>`; `--feed live` is the eight-token rotation.
 */

#include "../../app/feed.h"

#include <stdio.h>
#include <string.h>

namespace feed {

namespace {

Status scenario_status = Status::Online;
const char *scenario_reason = "";
bool scenario_ever = true;
size_t scenario_count = 0;
Token scenario_tokens[MAX_TOKENS];
uint32_t scenario_age_ms = 4000;

/* Real shapes, from the captured STONK row `devices/src/state/discovery.test.ts` asserts against and
 * the sibling rows `review.ts` renders, so what is drawn here is the width and character of a real
 * response rather than a tidy invention. A price that is always four characters wide would hide the
 * column overflow a real `$26,444,366` finds. */
struct Seed {
	const char *symbol;
	const char *name;
	const char *price;
	const char *change;
	bool positive;
};

const Seed SEEDS[] = {
    {"STONK", "STONK", "$0.24", "-4.58%", false},   {"BONK", "Bonk", "$0.000021", "+18.32%", true},
    {"JUP", "Jupiter", "$0.84", "+4.21%", true},    {"WIF", "dogwifhat", "$2.19", "-11.29%", false},
    {"JTO", "Jito", "$3.41", "+0.67%", true},       {"PYTH", "Pyth Network", "$0.42", "-2.33%", false},
    {"RAY", "Raydium", "$5.23", "+9.14%", true},    {"HNT", "Helium", "$26,444,366", "-0.51%", false},
};

void seed(size_t count) {
	scenario_count = count > MAX_TOKENS ? MAX_TOKENS : count;
	for (size_t i = 0; i < scenario_count; i++) {
		snprintf(scenario_tokens[i].symbol, sizeof(scenario_tokens[i].symbol), "%s", SEEDS[i].symbol);
		snprintf(scenario_tokens[i].name, sizeof(scenario_tokens[i].name), "%s", SEEDS[i].name);
		snprintf(scenario_tokens[i].price, sizeof(scenario_tokens[i].price), "%s", SEEDS[i].price);
		snprintf(scenario_tokens[i].change, sizeof(scenario_tokens[i].change), "%s", SEEDS[i].change);
		scenario_tokens[i].changePositive = SEEDS[i].positive;
	}
}

}  // namespace

/* Called by the harness before `setup()`. Names match `feed::Status` so the flag reads like the
 * state it selects. */
void simScenario(const char *name) {
	if (name == nullptr || strcmp(name, "live") == 0) {
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
	} else if (strcmp(name, "one") == 0) {
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(1);
	} else if (strcmp(name, "no-credentials") == 0) {
		scenario_status = Status::NoCredentials;
		scenario_reason = "type a network on the glass";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "joining") == 0) {
		scenario_status = Status::Joining;
		scenario_reason = "";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "fetching") == 0) {
		scenario_status = Status::Fetching;
		scenario_reason = "";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "disabled") == 0) {
		scenario_status = Status::Disabled;
		scenario_reason = "no key in this build";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "failed") == 0) {
		scenario_status = Status::Failed;
		scenario_reason = "http 401";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "lost") == 0) {
		/*
		 * Had data, lost the network, and has no rows left to show either.
		 *
		 * Distinct from `stale`, which keeps its tokens: this is the same status with an empty list,
		 * so it is the one that falls through to the *status* archetype and has to say "Stale" with an
		 * age rather than a price with an age. It existed as a branch in `pulse_feed_view.cpp` with no
		 * way to photograph it, which by this repo's own rule is a state nobody has designed.
		 */
		scenario_status = Status::Failed;
		scenario_reason = "rate limited by OpenSea";
		scenario_ever = true;
		scenario_age_ms = 22u * 60u * 1000u;
		scenario_count = 0;
	} else if (strcmp(name, "waiting") == 0) {
		/* Associated, nothing fetched, nothing wrong — the default arm of `emptyFor`, which every
		 * other scenario steps around. */
		scenario_status = Status::Online;
		scenario_reason = "waiting for the first fetch";
		scenario_ever = false;
		scenario_count = 0;
	} else if (strcmp(name, "stale") == 0) {
		/* The interesting one: data that arrived and then stopped. It stays on screen, because a
		 * labelled old number beats a blank panel, and the age is what makes that honest. */
		scenario_status = Status::Failed;
		scenario_reason = "http 429";
		scenario_ever = true;
		scenario_age_ms = 15u * 60u * 1000u;
		seed(8);
	} else {
		printf("feed_sim: unknown scenario \"%s\"\n", name);
	}
}

void begin() {}

void tick(bool) {}

Snapshot snapshot() {
	Snapshot out{};
	out.status = scenario_status;
	out.reason = scenario_reason;
	out.count = scenario_count;
	for (size_t i = 0; i < scenario_count; i++) out.tokens[i] = scenario_tokens[i];
	out.ageMs = scenario_age_ms;
	out.everSucceeded = scenario_ever;
	out.lastHttpCode = 0;
	out.workerStackFreeBytes = 0;
	return out;
}

size_t parseTrending(Stream &, Token *, size_t, const char **) {
	/* The real parser is exercised directly against captured payloads; see `feed.cpp`. Nothing in
	 * the LVGL firmware calls this, and a stub that returned invented rows would be a second
	 * implementation quietly disagreeing with the first. */
	return 0;
}

}  // namespace feed
