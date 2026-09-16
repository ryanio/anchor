#include "pulse_feed_view.h"

#include <stdio.h>
#include <string.h>

namespace pulse_feed_view {

namespace {

/*
 * Everything the screen can say while it has no token to show.
 *
 * Each of these is a different fact about the world and gets a different sentence, because the
 * person reading it can act on some of them and not others: a unit with no network typed in wants a
 * finger, a unit that is joining wants ten seconds, and a unit whose key was refused wants whoever
 * flashed it. "No data" covers all three and helps with none.
 *
 * The state goes in the one big row and the sentence goes in the footer, which is a split by reading
 * distance rather than by importance: the 40px value is legible across a room and takes two or three
 * words, and the 16px footer is for whoever has walked over to do something about it.
 */
struct Empty {
	const char *title;
	const char *label;
	const char *value;
};

Empty emptyFor(Status status, bool everSucceeded) {
	switch (status) {
		case Status::Disabled:
			/*
			 * Built without a key on purpose. Not a fault, and it must not read as one — a unit in
			 * this state is behaving exactly as the checkout it came from asked it to.
			 *
			 * The value was "not built in", which was two mistakes at once. It overflowed the value
			 * column at 40px and ran into the word "trending" beside it, and it described the
			 * *build* to somebody holding a *device* — jargon they cannot act on. "off" fits and is
			 * true; the footer carries the part a person can do something with.
			 */
			return {"Anchor", "trending", "off"};
		case Status::NoCredentials:
			/* The footer says how, because on this screen the whole panel is the button — see
			 * `pulse_wifi::attachOpenGesture`. A state somebody cannot act on is a dead end. */
			return {"Anchor", "wi-fi", "not set up"};
		case Status::Joining:
			return {"Anchor", "wi-fi", "joining"};
		case Status::Fetching:
			return {"Anchor", "trending", "fetching"};
		case Status::Failed:
			/* `everSucceeded` is the difference between "this never worked" and "this stopped
			 * working", and only the second one is worth a person's attention right now. */
			return {"Anchor", everSucceeded ? "trending" : "wi-fi", everSucceeded ? "stale" : "failed"};
		default:
			return {"Anchor", "trending", "waiting"};
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

pulse_ui::Reading compose(Status status, const char *reason, const Token *tokens, size_t count,
                          size_t rotation, uint32_t ageMs, bool everSucceeded) {
	/*
	 * Static because `pulse_ui::Reading` holds pointers rather than buffers — the seam was built
	 * that way so a caller with its own strings pays nothing to pass them — which makes the lifetime
	 * of anything composed here this function's problem. A screen is drawn from one thread on this
	 * device and re-read on the next pass, so one set of buffers is enough and a second would only
	 * be a second thing to keep in step.
	 */
	/* 40, not 24: the stale footer prefixes "stale · " onto a formatted age, and the simulator builds
	 * this file with -Werror where the board build does not — it refused the truncation the smaller
	 * buffer allowed. The stricter of the two compilers is the one worth listening to. */
	static char age[40];
	static char title[32];
	static char changeLabel[16];

	pulse_ui::Reading reading;

	if (tokens == nullptr || count == 0) {
		/*
		 * One short state in the big column, the sentence in the footer.
		 *
		 * The first version put the feed's `reason` into a value slot, which is a 40px right-aligned
		 * label 203px wide: "type a network on the glass" came out as "n the glass", clipped at the
		 * left and reading as garbage. The footer is where a sentence belongs on this screen: full
		 * width, 16px, centred, and already the one part of it meant to be read close up. The value
		 * column takes only what fits, which for a state is two or three words.
		 *
		 * Found by looking at it in the simulator. The arithmetic looked fine.
		 */
		const Empty empty = emptyFor(status, everSucceeded);
		reading.title = empty.title;
		reading.total = empty.value;
		reading.pnl = "";
		reading.pnl_tone = 0;
		reading.nfts = "";
		reading.window = "";
		/*
		 * The label yields to a long value rather than being run into by it.
		 *
		 * "not built in" at 40px is about 300px against a 203px value column, so it overflowed left
		 * and collided with the word beside it — two strings sharing pixels, which reads as a
		 * rendering fault rather than as a state. That particular string is now short, but the shape
		 * of the bug outlives it: any future status longer than the column does the same thing.
		 *
		 * There are no font metrics on this side of the seam (that is the price of keeping the view
		 * free of LVGL so the simulator can compile it), so this is a character count against a
		 * measured average: Montserrat 40 runs about 22px a glyph, and 203px is nine of them. Past
		 * that the label is dropped and the value gets the whole row. A state with no label is still
		 * legible; a state written on top of its own label is not.
		 */
		constexpr size_t VALUE_FITS_CHARS = 9;
		reading.labels[0] = strlen(empty.value) > VALUE_FITS_CHARS ? "" : empty.label;
		/* The three rows with nothing true to say draw nothing, rather than standing a portfolio's
		 * labels over blanks. */
		reading.labels[1] = "";
		reading.labels[2] = "";
		reading.labels[3] = "";
		/*
		 * The footer carries whichever is more use: how old the last good data is, or why there is
		 * none. Stale data keeps its age — a labelled old number beats a blank panel — and a unit
		 * that has never fetched gets the feed's own reason, which knows things this file cannot,
		 * such as which HTTP code came back.
		 */
		if (everSucceeded) {
			formatAge(ageMs, age, sizeof(age));
			reading.age = age;
		} else if (reason != nullptr && reason[0] != '\0') {
			reading.age = reason;
		} else {
			reading.age = "";
		}
		return reading;
	}

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
	return reading;
}

}  // namespace pulse_feed_view
