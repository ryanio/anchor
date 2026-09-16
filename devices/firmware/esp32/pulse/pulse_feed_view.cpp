#include "pulse_feed_view.h"

#include <stdio.h>
#include <string.h>

namespace pulse_feed_view {

namespace {

using pulse_design::Tone;

/*
 * Everything the screen can say while it has no token to show.
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
			return {"TRENDING", "No key", Tone::Warn,
			        "This unit was built without an OpenSea key.", false};
		case Status::NoCredentials:
			/* The detail says how, because on this screen the whole panel is the button — see
			 * `pulse_wifi::attachOpenGesture` and `pulse_ui::surface()`. A state somebody cannot act on
			 * is a dead end, and this is the state every unit out of a box is in. */
			return {"WI-FI", "Not set up", Tone::Accent,
			        "Tap anywhere on the glass to pick a network.", false};
		case Status::Joining:
			return {"WI-FI", "Joining", Tone::Accent, "Waiting for the saved network to answer.",
			        false};
		case Status::Fetching:
			return {"TRENDING", "Fetching", Tone::Accent, "Asking OpenSea what is trending.", false};
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
				return {"TRENDING", "Stale", Tone::Warn, "Nothing new is arriving.", true};
			}
			return {"TRENDING", "No data", Tone::Bad, "Nothing has come back from OpenSea yet.", true};
		default:
			return {"TRENDING", "Waiting", Tone::Quiet, "Nothing has arrived yet.", false};
	}
}

}  // namespace

void formatAge(uint32_t ms, char *into, size_t size) {
	const uint32_t seconds = ms / 1000u;
	if (seconds < 1u) {
		snprintf(into, size, "just now");
	} else if (seconds < 60u) {
		snprintf(into, size, "%us ago", (unsigned)seconds);
	} else if (seconds < 3600u) {
		snprintf(into, size, "%um ago", (unsigned)(seconds / 60u));
	} else {
		snprintf(into, size, "%uh ago", (unsigned)(seconds / 3600u));
	}
}

pulse_ui::Screen compose(Status status, const char *reason, const Token *tokens, size_t count,
                         size_t rotation, uint32_t ageMs, bool everSucceeded) {
	/*
	 * Static because `pulse_ui::Reading` and `pulse_ui::Status` hold pointers rather than buffers —
	 * the seam was built that way so a caller with its own strings pays nothing to pass them — which
	 * makes the lifetime of anything composed here this function's problem. A screen is drawn from one
	 * thread on this device and re-read on the next pass, so one set of buffers is enough and a second
	 * would only be a second thing to keep in step.
	 */
	/* 40, not 24: the stale footer prefixes a word onto a formatted age, and the simulator builds this
	 * file with -Werror where the board build does not — it refused the truncation the smaller buffer
	 * allowed. The stricter of the two compilers is the one worth listening to. */
	static char age[40];
	static char title[32];
	static char changeLabel[16];

	pulse_ui::Screen screen;

	if (tokens == nullptr || count == 0) {
		/*
		 * A status, on the status archetype, rather than a reading with one row filled.
		 *
		 * This is the branch Ryan's report was about. It used to produce a `Reading` whose `total` was
		 * the state word, with three empty label/value pairs beneath it — a 40px right-aligned string
		 * sitting at x=123 over 250px of nothing. Now it returns the other kind of screen and the
		 * layout has a centred composition to put it in.
		 */
		const Empty empty = emptyFor(status, everSucceeded);
		screen.kind = pulse_ui::Screen::Kind::Status;
		screen.status.eyebrow = empty.eyebrow;
		screen.status.headline = empty.headline;
		screen.status.tone = empty.tone;
		screen.status.detail = empty.detail;
		screen.status.support =
		    (empty.show_reason && reason != nullptr && reason[0] != '\0') ? reason : "";
		/*
		 * A unit that has had data keeps saying how old it is even once the data itself is gone.
		 *
		 * That is the same promise the stale *reading* makes one branch down, and it has to survive
		 * the feed dropping to zero tokens: "stale" with no age is a claim nobody can check, which is
		 * the failure this project rates above every other.
		 */
		if (everSucceeded) {
			char plain[16];
			formatAge(ageMs, plain, sizeof(plain));
			snprintf(age, sizeof(age), "last reading %s", plain);
			screen.status.note = age;
		} else {
			screen.status.note = "";
		}
		return screen;
	}

	screen.kind = pulse_ui::Screen::Kind::Reading;
	const Token &token = tokens[rotation % count];

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
	snprintf(changeLabel, sizeof(changeLabel), "%u of %u", (unsigned)((rotation % count) + 1),
	         (unsigned)count);

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
	const bool stale = status == Status::Failed && everSucceeded;
	/* Formatted into its own small buffer and then composed, rather than formatted into `age` and
	 * copied back over itself: the round trip is what the truncation warnings were about, and a
	 * buffer that holds only an age is the one the compiler can reason about. */
	char plain[16];
	formatAge(ageMs, plain, sizeof(plain));
	if (stale) {
		/* ASCII, deliberately. A middle dot separator rendered as a placeholder box here for the
		 * same reason the passphrase mask fell back to an asterisk: the built in Montserrat faces carry
		 * the bullet at U+2022 and not the interpunct at U+00B7, and LVGL draws a missing glyph rather
		 * than refusing. A comma costs nothing and cannot be missing. */
		snprintf(age, sizeof(age), "stale, %s", plain);
	} else {
		snprintf(age, sizeof(age), "%s", plain);
	}

	pulse_ui::Reading &reading = screen.reading;
	reading.title = title;
	reading.total = (token.price != nullptr && token.price[0] != '\0') ? token.price : "--";
	reading.pnl = (token.change != nullptr && token.change[0] != '\0') ? token.change : "--";
	/* The sign is the feed's judgement, not a re-parse of the string it already formatted: a second
	 * opinion about whether a number is negative is a second place for it to be wrong. */
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

}  // namespace pulse_feed_view
