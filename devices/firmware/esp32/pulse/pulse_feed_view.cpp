#include "pulse_feed_view.h"

#include "../../common/freshness.h"

#include <stdio.h>
#include <string.h>

namespace pulse_feed_view {

namespace {

using pulse_design::Tone;

/*
 * Everything the screen can say while it has no reading to show.
 *
 * Each of these is a different fact about the world and gets a different sentence, because the
 * person reading it can act on some of them and not others: a unit with no network typed in wants a
 * finger, a unit that is joining wants ten seconds, and a unit whose key was refused wants whoever
 * flashed it. "No data" covers all three and helps with none.
 *
 * ## The shape changed, the distinctions did not
 *
 * These used to be three strings — a title, a row label and a row *value* — because the only screen
 * this firmware had was a reading, so a state had to be smuggled into a value slot. That produced
 * the two bugs this file's older comments record: "not built in" at 40px overflowed a 203px column
 * and collided with the label beside it, and the feed's `reason` put into a value came out as
 * "n the glass", clipped at the left and reading as garbage. Both were worked around — a character
 * budget for the label, the sentence moved to the footer — and both workarounds are gone now,
 * because the status archetype in `pulse_design.h` has a slot for a headline and a slot for a
 * sentence and neither is a number's column.
 *
 * ## Why `reason` is usually not shown
 *
 * `app/feed.cpp` hands over a sentence for every state: "tap anywhere to set up wi-fi", "joining the
 * saved network", "asking OpenSea what is trending". Those are the same fact as the headline and
 * detail written here, one register flatter, and printing both puts a paraphrase of a line directly
 * under it. The one state where `reason` knows something this file cannot is `Failed` — it carries
 * which HTTP outcome came back, via `reasonForHttp` — so that is the one state that shows it.
 */
struct Empty {
	const char *eyebrow;
	const char *headline;
	Tone tone;
	const char *detail;
	/* True where `app/feed.cpp`'s reason is more specific than the sentence above, not a rewording
	 * of it. */
	bool show_reason;
	/* Filled only where the technical fact is not in `reason` either, because the layer underneath
	 * has nothing to say about a thing that was decided at build time. */
	const char *support;
};

Empty emptyFor(Status status, bool everSucceeded) {
	switch (status) {
		case Status::Disabled:
			/*
			 * Built without a key on purpose. Not a fault, and it must not read as one — a unit in this
			 * state is behaving exactly as the checkout it came from asked it to, so it is `Warn` and
			 * not `Bad`. "not built in" described the *build* to somebody holding a *device*; the
			 * headline names the missing thing and the sentence says who can do something about it.
			 */
			/* Two lines in the 288px measure. The first wording added "so there is nothing to fetch",
			 * which the headline already says and which pushed the sentence to four lines ending in a
			 * one-word widow. */
			return {"TRENDING", "No key", Tone::Warn, "This unit was built without an OpenSea key.",
			        false, ""};
		case Status::NoCredentials:
			/* The detail says how, because on this screen the whole panel is the button — see
			 * `pulse_wifi::attachOpenGesture` and `pulse_ui::surface()`. A state somebody cannot act on
			 * is a dead end, and this is the state every unit out of a box is in. */
			return {"WI-FI", "Not set up", Tone::Accent, "Tap anywhere on the glass to pick a network.",
			        false, ""};
		case Status::Joining:
			return {"WI-FI", "Joining", Tone::Accent, "Waiting for the saved network to answer.", false,
			        ""};
		case Status::Fetching:
			return {"TRENDING", "Fetching", Tone::Accent, "Asking OpenSea what is trending.", false, ""};
		case Status::Failed:
			/*
			 * `everSucceeded` is the difference between "this never worked" and "this stopped working",
			 * and they are different sentences to a person holding the unit. Only the first is a
			 * failure; the second is a unit that was fine an hour ago, which is `Warn`.
			 */
			if (everSucceeded) {
				/* One line at 22px inside the 288px measure — "The feed stopped answering." was the
				 * first wording and wrapped as "The feed stopped / answering.", which is a widow on a
				 * two-line sentence and looks like a layout fault rather than a sentence. */
				return {"TRENDING", "Stale", Tone::Warn, "Nothing new is arriving.", true, ""};
			}
			return {"TRENDING", "No data", Tone::Bad, "Nothing has come back from OpenSea yet.", true,
			        ""};
		default:
			return {"TRENDING", "Waiting", Tone::Quiet, "Nothing has arrived yet.", false, ""};
	}
}

/*
 * The same question for the portfolio half, which has one state the trending half cannot be in.
 *
 * Separate sentences rather than a shared table with the eyebrow swapped, because they are not the
 * same facts wearing different labels. "Asking OpenSea what is trending" is one request; the
 * portfolio is a request per address, and a unit with six wallets spends a visible few seconds
 * there. And `NoWallets` has no trending analogue at all: a unit that was never told whose portfolio
 * to show is configured, not broken, so it is `Warn` and it names the thing that is missing.
 */
Empty portfolioEmptyFor(Status status, bool everSucceeded) {
	switch (status) {
		case Status::Disabled:
			return {"PORTFOLIO", "No key", Tone::Warn, "This unit was built without an OpenSea key.",
			        false, ""};
		case Status::NoWallets:
			/*
			 * The one state on this panel whose fix is not on the glass, and the support line says so
			 * rather than leaving somebody looking for a button. An address is configuration — AGENTS.md
			 * is explicit that it is not a secret — so naming where it goes is the useful thing to
			 * print, and neither name is a credential.
			 */
			return {"PORTFOLIO", "No addresses", Tone::Warn,
			        "This unit has not been told which addresses to read.", false,
			        "Set ANCHOR_WALLETS, or the anchor-wallets store."};
		case Status::NoCredentials:
			return {"WI-FI", "Not set up", Tone::Accent, "Tap anywhere on the glass to pick a network.",
			        false, ""};
		case Status::Joining:
			return {"WI-FI", "Joining", Tone::Accent, "Waiting for the saved network to answer.", false,
			        ""};
		case Status::Fetching:
			return {"PORTFOLIO", "Reading", Tone::Accent, "Asking OpenSea about each address.", false,
			        ""};
		case Status::Failed:
			if (everSucceeded) {
				return {"PORTFOLIO", "Stale", Tone::Warn, "Nothing new is arriving.", true, ""};
			}
			return {"PORTFOLIO", "No data", Tone::Bad, "No address answered.", true, ""};
		default:
			return {"PORTFOLIO", "Waiting", Tone::Quiet, "Nothing has arrived yet.", false, ""};
	}
}

/* Fill a status screen from one of the tables above. Shared so the two halves cannot drift in how
 * they treat an age or a reason — only in what they say. */
void applyEmpty(pulse_ui::Screen &screen, const Empty &empty, const char *reason, uint32_t ageMs,
                bool everSucceeded, char *ageBuffer, size_t ageSize) {
	screen.kind = pulse_ui::Screen::Kind::Status;
	screen.status.eyebrow = empty.eyebrow;
	screen.status.headline = empty.headline;
	screen.status.tone = empty.tone;
	screen.status.detail = empty.detail;
	if (empty.show_reason && reason != nullptr && reason[0] != '\0') {
		screen.status.support = reason;
	} else {
		screen.status.support = empty.support;
	}
	/*
	 * A unit that has had data keeps saying how old it is even once the data itself is gone.
	 *
	 * That is the same promise the stale *reading* makes one branch down, and it has to survive the
	 * feed dropping to zero rows: "stale" with no age is a claim nobody can check, which is the
	 * failure this project rates above every other.
	 */
	if (everSucceeded) {
		char plain[16];
		formatAge(ageMs, plain, sizeof(plain));
		snprintf(ageBuffer, ageSize, "last reading %s", plain);
		screen.status.note = ageBuffer;
	} else {
		screen.status.note = "";
	}
}

/*
 * The footer of a reading: what qualifies the number, then how old it is.
 *
 * ## The line is 160px wide, which is what decides the wording
 *
 * Measured from the simulator's own tree dump: `label (20,389) 160x36`. The footer used to have the
 * card's full 304px, and it does not any more — the battery chip added alongside this work occupies
 * `(204,392) 132x36`, the right half of the same line. The first wording here was
 * "4 of 6 wallets, 9s ago", which wrapped to two lines and put "ago" through the bottom of the card.
 * A footer that reads as a layout fault is not a label anybody trusts.
 *
 * So the footer says **the qualifier no row can say**, and coverage is not that qualifier: it has a
 * row of its own — labelled "Wallets", set in 22px rather than the footer's 16px grey — where
 * AGENTS.md's "the panel says '8 of 9 wallets'" is satisfied in bigger type than this line could
 * manage. Staleness has no row, so it takes precedence here when both are true.
 *
 * ASCII separators, deliberately. A middle dot rendered as a placeholder box here for the same
 * reason the passphrase mask fell back to an asterisk: the built-in Montserrat faces carry the bullet
 * at U+2022 and not the interpunct at U+00B7, and LVGL draws a missing glyph rather than refusing.
 */
void formatProvenance(char *into, size_t size, bool partial, bool stale, uint32_t ageMs) {
	char plain[16];
	formatAge(ageMs, plain, sizeof(plain));
	if (stale) {
		snprintf(into, size, "stale, %s", plain);
	} else if (partial) {
		snprintf(into, size, "partial, %s", plain);
	} else {
		snprintf(into, size, "%s", plain);
	}
}

/* ---------------------------------------------------------------------------- the two slots ---- */

pulse_ui::Screen composePortfolio(const Portfolio &portfolio) {
	/*
	 * Static because `pulse_ui::Reading` and `pulse_ui::Status` hold pointers rather than buffers —
	 * the seam was built that way so a caller with its own strings pays nothing to pass them — which
	 * makes the lifetime of anything composed here this function's problem. A screen is drawn from one
	 * thread on this device and re-read on the next pass, so one set of buffers is enough and a second
	 * would only be a second thing to keep in step. One set *per slot*, because the two slots are
	 * composed by different calls and neither may be holding a pointer into the other's scratch.
	 */
	/* 64 rather than something tight: the provenance line can carry a coverage label, the word stale
	 * and an age at once, and the simulator builds this file with `-Werror` where the board build does
	 * not — it refuses the truncation a smaller buffer would allow. The stricter of the two compilers
	 * is the one worth listening to. */
	static char age[64];
	static char coverage[24];

	pulse_ui::Screen screen;

	/*
	 * A reading only if there is one. `everSucceeded` and not `status == Online`, because a stale
	 * portfolio is still a portfolio — a labelled old number beats a blank panel, which is the same
	 * judgement the trending slot makes one function down.
	 */
	if (!portfolio.everSucceeded) {
		const Empty empty = portfolioEmptyFor(portfolio.status, portfolio.everSucceeded);
		applyEmpty(screen, empty, portfolio.reason, portfolio.ageMs, portfolio.everSucceeded, age,
		           sizeof(age));
		return screen;
	}

	screen.kind = pulse_ui::Screen::Kind::Reading;

	/*
	 * How many wallets are in this number, on the panel, always — not only when something failed.
	 *
	 * A coverage label that appears only on a bad day is a label nobody learns to read, and the
	 * reading it qualifies looks different on the day it matters for a reason the reader has to
	 * work out. "6 of 6" is also the answer to the question a person actually has when they look at a
	 * total on a device that is not their desktop: how much of it is this.
	 */
	snprintf(coverage, sizeof(coverage), "%u of %u", (unsigned)portfolio.covered,
	         (unsigned)portfolio.configured);

	const bool partial = portfolio.covered < portfolio.configured;
	const bool stale = portfolio.status == Status::Failed;
	formatProvenance(age, sizeof(age), partial, stale, portfolio.ageMs);

	pulse_ui::Reading &reading = screen.reading;
	reading.title = "Portfolio";
	reading.total = (portfolio.total != nullptr && portfolio.total[0] != '\0') ? portfolio.total : "--";
	reading.pnl =
	    (portfolio.change != nullptr && portfolio.change[0] != '\0') ? portfolio.change : "--";
	/* The sign is the feed's judgement, not a re-parse of the string it already formatted: a second
	 * opinion about whether a number is negative is a second place for it to be wrong. A move that
	 * could not be derived at all is toneless rather than green. */
	reading.pnl_tone = portfolio.haveChange ? (portfolio.changePositive ? 1 : -1) : 0;
	reading.nfts =
	    (portfolio.nftValue != nullptr && portfolio.nftValue[0] != '\0') ? portfolio.nftValue : "--";
	reading.window = coverage;
	reading.age = age;
	reading.labels[0] = "Total";
	reading.labels[1] = "24h";
	reading.labels[2] = "NFTs";
	reading.labels[3] = "Wallets";
	return screen;
}

pulse_ui::Screen composeTrending(const Trending &trending, size_t index) {
	static char age[64];
	static char title[32];
	static char changeLabel[16];

	pulse_ui::Screen screen;

	if (trending.tokens == nullptr || trending.count == 0) {
		/*
		 * A status, on the status archetype, rather than a reading with one row filled.
		 *
		 * This is the branch Ryan's report was about. It used to produce a `Reading` whose `total` was
		 * the state word, with three empty label/value pairs beneath it — a 40px right-aligned string
		 * sitting at x=123 over 250px of nothing. Now it returns the other kind of screen and the
		 * layout has a centred composition to put it in.
		 */
		const Empty empty = emptyFor(trending.status, trending.everSucceeded);
		applyEmpty(screen, empty, trending.reason, trending.ageMs, trending.everSucceeded, age,
		           sizeof(age));
		return screen;
	}

	screen.kind = pulse_ui::Screen::Kind::Reading;
	const Token &token = trending.tokens[index % trending.count];

	/* "STONK (Stonk Coin)" where both are known and differ, otherwise whichever exists. A symbol
	 * repeated as its own name reads as a stutter on a 368px panel. */
	const bool haveName = token.name != nullptr && token.name[0] != '\0';
	const bool haveSymbol = token.symbol != nullptr && token.symbol[0] != '\0';
	if (haveSymbol && haveName && strcmp(token.symbol, token.name) != 0) {
		snprintf(title, sizeof(title), "%s (%s)", token.symbol, token.name);
	} else if (haveSymbol) {
		snprintf(title, sizeof(title), "%s", token.symbol);
	} else if (haveName) {
		snprintf(title, sizeof(title), "%s", token.name);
	} else {
		snprintf(title, sizeof(title), "Trending");
	}

	/* Which of several this is, so a rotating panel does not look like a stuck one. */
	snprintf(changeLabel, sizeof(changeLabel), "%u of %u", (unsigned)((index % trending.count) + 1),
	         (unsigned)trending.count);

	/*
	 * Stale data says so, in the footer, next to how old it is.
	 *
	 * Before this, a reading fetched fifteen minutes ago and one fetched four seconds ago were the
	 * same screen apart from small grey text — same price, same size, same confidence. On an ambient
	 * display nobody is studying, that is the failure this project rates above every other: a
	 * plausible number that is not the number it claims to be. Keeping the old reading is still
	 * right, because a labelled old number beats a blank panel; keeping it *unlabelled* is not.
	 *
	 * `everSucceeded && status == Failed` is exactly "we had data and then stopped being able to get
	 * it", which is the only case where what is on screen is older than it looks.
	 */
	const bool stale = trending.status == Status::Failed && trending.everSucceeded;
	formatProvenance(age, sizeof(age), false, stale, trending.ageMs);

	pulse_ui::Reading &reading = screen.reading;
	reading.title = title;
	reading.total = (token.price != nullptr && token.price[0] != '\0') ? token.price : "--";
	reading.pnl = (token.change != nullptr && token.change[0] != '\0') ? token.change : "--";
	reading.pnl_tone = token.changePositive ? 1 : -1;
	reading.nfts = changeLabel;
	reading.window = "trending";
	reading.age = age;
	reading.labels[0] = "Price";
	reading.labels[1] = "24h";
	reading.labels[2] = "Showing";
	reading.labels[3] = "Source";
	return screen;
}

}  // namespace

void formatAge(uint32_t ms, char *into, size_t size) {
	/* The Cardputer describes age with the same function, so the two devices cannot drift. */
	anchor_freshness::formatAge(ms, into, size);
}

size_t slotCount(const Trending &trending) {
	/* One for the portfolio, then one per token — or one for the trending status when there are no
	 * tokens, so that "why is the list empty" can never be crowded off the panel by a portfolio that
	 * is working. See the header comment. */
	const size_t tokenSlots = trending.count == 0 ? 1u : trending.count;
	return 1u + tokenSlots;
}

pulse_ui::Screen compose(const Trending &trending, const Portfolio &portfolio, size_t rotation) {
	const size_t slot = rotation % slotCount(trending);
	if (slot == 0) {
		return composePortfolio(portfolio);
	}
	return composeTrending(trending, slot - 1u);
}

}  // namespace pulse_feed_view
