#ifndef ANCHOR_PULSE_COMPANION_MODEL_H
#define ANCHOR_PULSE_COMPANION_MODEL_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/*
 * The companion's mood and what it says, with no LVGL in it.
 *
 * The companion is a character on the round panel that reacts to what the unit already knows: the
 * portfolio's day, the trending list, whether the network is there, and a finger. It was inspired by
 * character-led devices like Meta's Muse Charm, and it is deliberately our own drawing rather than
 * anyone's mascot. There is no AI here. Every sentence is built from readings the feed has already
 * formatted, so the companion can never say a number the rest of the unit does not show.
 *
 * `pulse_companion.cpp` draws it. The judgement, which mood for which inputs and which line after
 * which tap, lives here so `host/companion.cpp` can test it without a framebuffer.
 */
namespace pulse_companion {

enum class Mood : uint8_t {
	Content,  /* nothing to report, all well */
	Happy,    /* the portfolio or the top trending token is up */
	Worried,  /* it is down */
	Curious,  /* asking OpenSea right now */
	Sleepy,   /* no network, or the reading is stale */
	Lost,     /* no Wi-Fi saved: it needs somebody to set it up */
};

/*
 * Everything the companion reacts to, as the feed already formatted it. Strings may be null or empty
 * when a reading did not arrive; `--` is treated the same way, because that is how the feed writes a
 * figure it does not have.
 */
struct Inputs {
	bool wifiConfigured = false;
	bool online = false;
	bool fetching = false;
	bool stale = false;

	/* Portfolio: total, 24h change and its sign, and coverage. */
	bool havePortfolio = false;
	const char *total = nullptr;
	const char *change = nullptr;
	bool changePositive = false;
	size_t covered = 0;
	size_t configured = 0;

	/* The first trending row. */
	bool haveTrending = false;
	const char *topSymbol = nullptr;
	const char *topPrice = nullptr;
	const char *topChange = nullptr;
	bool topPositive = false;

	/* The age of the newest reading, already worded ("4m ago"). */
	const char *age = nullptr;
};

namespace detail {

inline bool has(const char *text)
{
	return text != nullptr && text[0] != '\0' && strcmp(text, "--") != 0;
}

}  // namespace detail

/* One mood for the inputs. Earlier rules win: a unit with no Wi-Fi is lost whatever it remembers. */
inline Mood moodFor(const Inputs &in)
{
	if (!in.wifiConfigured) return Mood::Lost;
	if (!in.online || in.stale) return Mood::Sleepy;
	if (in.fetching && !in.havePortfolio && !in.haveTrending) return Mood::Curious;
	if (in.havePortfolio && detail::has(in.change)) {
		return in.changePositive ? Mood::Happy : Mood::Worried;
	}
	if (in.haveTrending && detail::has(in.topChange)) {
		return in.topPositive ? Mood::Happy : Mood::Worried;
	}
	return in.fetching ? Mood::Curious : Mood::Content;
}

/*
 * How many different things the companion can say right now. A tap steps through them. There is
 * always at least one, because a companion that says nothing when tapped looks broken.
 */
inline size_t lineCount(const Inputs &in)
{
	if (!in.wifiConfigured || !in.online) return 1;
	size_t count = 0;
	if (in.havePortfolio && detail::has(in.total)) count++;
	if (in.haveTrending && detail::has(in.topSymbol)) count++;
	return count == 0 ? 1 : count;
}

/*
 * Line `index` (taken modulo `lineCount`) into `out`, two short lines separated by '\n' so the panel
 * can set them as a headline and a subline. Only readings the feed formatted appear in it.
 */
inline void line(const Inputs &in, size_t index, char *out, size_t n)
{
	if (out == nullptr || n == 0) return;
	out[0] = '\0';
	if (!in.wifiConfigured) {
		snprintf(out, n, "I need Wi-Fi.\nTap me to set it up.");
		return;
	}
	if (!in.online) {
		snprintf(out, n, "Looking for Wi-Fi...\n%s",
		         detail::has(in.age) ? in.age : "nothing to show yet");
		return;
	}

	const bool portfolio = in.havePortfolio && detail::has(in.total);
	const bool trending = in.haveTrending && detail::has(in.topSymbol);
	const size_t count = lineCount(in);
	const size_t which = index % count;

	if (portfolio && which == 0) {
		char coverage[32] = "";
		if (in.configured > 1 || in.covered < in.configured) {
			snprintf(coverage, sizeof(coverage), " (%u of %u)", (unsigned)in.covered,
			         (unsigned)in.configured);
		}
		if (detail::has(in.change)) {
			snprintf(out, n, "Your wallets: %s%s\n%s today", in.total, coverage, in.change);
		} else {
			snprintf(out, n, "Your wallets: %s%s\nno 24h change yet", in.total, coverage);
		}
		return;
	}
	if (trending) {
		if (detail::has(in.topChange)) {
			snprintf(out, n, "%s is trending\n%s, %s today", in.topSymbol,
			         detail::has(in.topPrice) ? in.topPrice : "no price", in.topChange);
		} else {
			snprintf(out, n, "%s is trending\n%s", in.topSymbol,
			         detail::has(in.topPrice) ? in.topPrice : "no price yet");
		}
		return;
	}
	snprintf(out, n, in.fetching ? "Asking OpenSea...\none moment" : "All quiet.\nTap Explore to look around.");
}

}  // namespace pulse_companion

#endif /* ANCHOR_PULSE_COMPANION_MODEL_H */
