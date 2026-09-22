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
 *
 * ## Two halves now, and a scenario sets both
 *
 * The feed fetches a trending list *and* a portfolio, and they fail independently — so every
 * scenario carries a state for each, and the ones that mirror a real precedence say so where they
 * do it. `snapshot()` answers "no network" before it answers anything about addresses, so a
 * `no-credentials` unit says so on both halves rather than complaining about addresses it could not
 * have used anyway. Getting that wrong here would photograph a screen the device cannot draw, which
 * is worse than not photographing it at all.
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

/*
 * The portfolio half of the same scenario.
 *
 * It defaults to a unit that was never told any addresses, because that is what a checkout with no
 * `ANCHOR_WALLETS` actually is — and it means every scenario that predates the portfolio still
 * renders its own trending state, with slot 0 showing the one honest thing a unit in that state can
 * say. The `--feed portfolio*` scenarios below are the ones that fill it in.
 */
Portfolio scenario_portfolio;
Status scenario_portfolio_status = Status::NoWallets;
const char *scenario_portfolio_reason = "no addresses configured on this unit";
uint32_t scenario_portfolio_age_ms = 9000;
bool scenario_portfolio_ever = false;

/*
 * A portfolio as `feed.cpp` would have published one: strings already formatted, coverage counted.
 *
 * The figures are the real ones, summed from the six addresses in `~/.config/anchor/config.json`'s
 * own `wallets` list against the live API on 2026-09-17 — $2,191.42 + $8.76 + $612.93 + $220.11 +
 * $0.01 + $92.02. A tidy invention would hide exactly what a real one shows: that the total crosses
 * the thousand-dollar boundary where `formatUsdMicros` drops the cents and starts grouping, and that
 * a six-wallet coverage label is wider than the two-wallet one anybody would type as a placeholder.
 */
void seedPortfolio(const char *total, const char *nft, const char *change, bool positive,
                   size_t covered, size_t configured) {
	snprintf(scenario_portfolio.total, sizeof(scenario_portfolio.total), "%s", total);
	snprintf(scenario_portfolio.nftValue, sizeof(scenario_portfolio.nftValue), "%s", nft);
	snprintf(scenario_portfolio.change, sizeof(scenario_portfolio.change), "%s", change);
	scenario_portfolio.changePositive = positive;
	scenario_portfolio.haveChange = strcmp(change, "--") != 0;
	scenario_portfolio.covered = covered;
	scenario_portfolio.configured = configured;
}

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
		snprintf(scenario_tokens[i].chain, sizeof(scenario_tokens[i].chain), "solana");
		snprintf(scenario_tokens[i].address, sizeof(scenario_tokens[i].address), "ExampleToken%u", (unsigned)i);
		snprintf(scenario_tokens[i].volume, sizeof(scenario_tokens[i].volume), "$1.2M");
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
		/* Both halves, because `snapshot()` answers "no network" before it answers anything about
		 * addresses — a unit with nothing typed in cannot read a portfolio either, and a scenario
		 * that showed "no addresses" here would be photographing a screen the device never draws. */
		scenario_portfolio_status = Status::NoCredentials;
		scenario_portfolio_reason = "tap anywhere to set up wi-fi";
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
		/* No key gates both fetches at the same `#if`, so both halves say so. */
		scenario_portfolio_status = Status::Disabled;
		scenario_portfolio_reason = "no OpenSea key on this unit";
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
	} else if (strcmp(name, "portfolio") == 0) {
		/* The whole answer: every configured address read, on a unit whose trending list is also
		 * working. Slot 0 is the portfolio and slots 1..8 are the tokens, so one run at `--gap 6000`
		 * walks the rotation. */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::Online;
		scenario_portfolio_reason = "up to date";
		scenario_portfolio_ever = true;
		scenario_portfolio_age_ms = 9000;
		seedPortfolio("$3,125", "$105.29", "+3.54%", true, 6, 6);
	} else if (strcmp(name, "portfolio-partial") == 0) {
		/*
		 * Four of six answered, which is the scenario this whole feature is judged on.
		 *
		 * AGENTS.md: "A partial answer is labelled, never trimmed." The total below is genuinely the
		 * sum of four wallets and the panel has to say so — in the row and in the footer — rather than
		 * drawing it the same way it draws a complete one. If this render is indistinguishable from
		 * `--feed portfolio` at a glance, the feature is wrong however green the build is.
		 */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::Online;
		scenario_portfolio_reason = "up to date";
		scenario_portfolio_ever = true;
		scenario_portfolio_age_ms = 9000;
		seedPortfolio("$3,033", "$95.66", "+2.95%", true, 4, 6);
	} else if (strcmp(name, "portfolio-stale") == 0) {
		/* Had a total, then stopped being able to refresh it. The number stays — a labelled old
		 * number beats a blank panel — and the footer carries both what it covers and how old it is. */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::Failed;
		scenario_portfolio_reason = "rate limited by OpenSea";
		scenario_portfolio_ever = true;
		scenario_portfolio_age_ms = 26u * 60u * 1000u;
		seedPortfolio("$3,125", "$105.29", "+3.54%", true, 5, 6);
	} else if (strcmp(name, "portfolio-failed") == 0) {
		/* Addresses configured, network up, and nothing has ever come back. The status archetype has
		 * to say which of those it is — `reason` is the only thing that knows it was a 401 rather than
		 * an empty response. */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::Failed;
		scenario_portfolio_reason = "OpenSea refused this unit's API key";
		scenario_portfolio_ever = false;
		scenario_portfolio_age_ms = 0;
	} else if (strcmp(name, "portfolio-none") == 0) {
		/* A unit built without `ANCHOR_WALLETS` and never written to. Not a failure: it is doing
		 * exactly what the checkout asked for, and the screen has to say so without wearing red. */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::NoWallets;
		scenario_portfolio_reason = "no addresses configured on this unit";
		scenario_portfolio_ever = false;
		scenario_portfolio_age_ms = 0;
	} else if (strcmp(name, "portfolio-fetching") == 0) {
		/* A request per address takes visible seconds on six wallets, so this is a state somebody
		 * holding a unit will actually see rather than a frame between two others. */
		scenario_status = Status::Online;
		scenario_reason = "";
		scenario_ever = true;
		seed(8);
		scenario_portfolio_status = Status::Fetching;
		scenario_portfolio_reason = "reading every configured address";
		scenario_portfolio_ever = false;
		scenario_portfolio_age_ms = 0;
	} else if (strcmp(name, "portfolio-only") == 0) {
		/*
		 * The portfolio working while trending is not, which is the pairing that proves neither half
		 * can hide the other: slot 0 is a total, slot 1 is the trending failure saying why the list is
		 * empty. Before the rotation had a guaranteed slot each, one of these two states could only be
		 * seen by breaking the other.
		 */
		scenario_status = Status::Failed;
		scenario_reason = "rate limited by OpenSea";
		scenario_ever = false;
		scenario_count = 0;
		scenario_portfolio_status = Status::Online;
		scenario_portfolio_reason = "up to date";
		scenario_portfolio_ever = true;
		scenario_portfolio_age_ms = 4000;
		seedPortfolio("$3,125", "$105.29", "+3.54%", true, 6, 6);
	} else {
		printf("feed_sim: unknown scenario \"%s\"\n", name);
	}
}

void begin() {}

void tick(bool, bool, bool, uint32_t) {}

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
	out.portfolio = scenario_portfolio;
	out.portfolioStatus = scenario_portfolio_status;
	out.portfolioReason = scenario_portfolio_reason;
	out.portfolioAgeMs = scenario_portfolio_age_ms;
	out.portfolioEverSucceeded = scenario_portfolio_ever;
	/* The real module fills these with "--" before anything has been fetched, because a figure that
	 * never arrived has no reading and `$0.00` would be one. A scenario that left them as the zeroed
	 * bytes of `Snapshot{}` would render an empty string and quietly test a screen the device cannot
	 * produce. */
	if (!scenario_portfolio_ever) {
		snprintf(out.portfolio.total, sizeof(out.portfolio.total), "--");
		snprintf(out.portfolio.nftValue, sizeof(out.portfolio.nftValue), "--");
		snprintf(out.portfolio.change, sizeof(out.portfolio.change), "--");
	}
	return out;
}

size_t parseTrending(Stream &, Token *, size_t, const char **) {
	/* The real parser is exercised directly against captured payloads; see `feed.cpp`. Nothing in
	 * the LVGL firmware calls this, and a stub that returned invented rows would be a second
	 * implementation quietly disagreeing with the first. */
	return 0;
}

}  // namespace feed
