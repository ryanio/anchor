#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// How both handhelds write a number a person reads, and how they copy text that came off the network.
//
// These were two byte-identical copies, one in esp32/app/feed.cpp and one in
// cardputer/app/src/standalone.cpp, each with a comment saying the other must not drift. Two Anchor
// units on one table rounding the same token two ways is a bug nobody could explain, so there is one
// copy now. The strings are formatted once, at fetch time, so a renderer never holds a float or an
// opinion about rounding. `display_format_test.cpp` pins the output.
namespace anchor_format {

// Untrusted bytes, copied for drawing. Every string from a response is marketplace content, which
// AGENTS.md treats as a prompt-injection surface: bounded copies only, printable ASCII only. Control
// characters, stray CR or LF, ESC and the continuation bytes of an emoji are dropped. A value that
// was entirely unprintable becomes "?" so the row still says something.
inline void copyBounded(char *out, size_t n, const char *in)
{
	if (out == nullptr || n == 0) {
		return;
	}
	size_t written = 0;
	bool sawAnything = false;
	if (in != nullptr) {
		for (size_t i = 0; in[i] != '\0' && written + 1 < n; i++) {
			const unsigned char c = (unsigned char)in[i];
			sawAnything = true;
			if (c >= 0x20 && c <= 0x7E) {
				out[written++] = (char)c;
			}
		}
	}
	if (written == 0 && sawAnything && n >= 2) {
		out[written++] = '?';
	}
	out[written] = '\0';
}

// Money as a display string. A value that did not arrive is "--", never "$0.0000": a missing price
// has no reading, and $0.0000 is a reading. Whole dollars from $1,000, cents from $1, four places
// from one cent. No thousands separators, because trending rows are narrow.
//
// Below one cent, three significant figures with trailing zeros dropped: "$0.000021", "$0.00123".
// Four fixed places used to print every sub-cent token, which trending is full of, as "$0.0000", a
// plausible price that is not the price. Below $0.0000000001 the string says so instead of printing
// zeros.
inline void formatUsd(double value, char *out, size_t n)
{
	if (!isfinite(value)) {
		snprintf(out, n, "--");
		return;
	}
	if (value >= 1000.0) {
		snprintf(out, n, "$%.0f", value);
	} else if (value >= 1.0) {
		snprintf(out, n, "$%.2f", value);
	} else if (value >= 0.01 || value <= 0.0) {
		snprintf(out, n, "$%.4f", value);
	} else if (value < 1e-10) {
		snprintf(out, n, "<$0.0000000001");
	} else {
		int places = (int)floor(-log10(value)) + 3;
		/* Twelve keeps three significant figures down to 1e-10, and "$0.000000000123" is fifteen
		 * characters, which fits the sixteen-byte price field both devices use. */
		if (places > 12) {
			places = 12;
		}
		char digits[24];
		snprintf(digits, sizeof(digits), "%.*f", places, value);
		size_t length = strlen(digits);
		while (length > 0 && digits[length - 1] == '0') {
			digits[--length] = '\0';
		}
		if (length > 0 && digits[length - 1] == '.') {
			digits[--length] = '\0';
		}
		snprintf(out, n, "$%s", digits);
	}
}

// The same money in the width a row can spare: $6.6M, $15.5M, $997K. Volume and a holder's stake run
// to eight and nine figures where a price does not.
inline void formatBigUsd(double value, char *out, size_t n)
{
	if (!isfinite(value)) {
		snprintf(out, n, "--");
		return;
	}
	const double magnitude = fabs(value);
	if (magnitude >= 1000000000.0) {
		snprintf(out, n, "$%.1fB", value / 1000000000.0);
	} else if (magnitude >= 1000000.0) {
		snprintf(out, n, "$%.1fM", value / 1000000.0);
	} else if (magnitude >= 1000.0) {
		snprintf(out, n, "$%.0fK", value / 1000.0);
	} else {
		formatUsd(value, out, n);
	}
}

// A signed change, where "+" carries meaning: "+3.88%".
inline void formatPercent(double value, char *out, size_t n)
{
	if (!isfinite(value)) {
		snprintf(out, n, "--");
		return;
	}
	snprintf(out, n, "%s%.2f%%", value >= 0.0 ? "+" : "", value);
}

// A share of something, which is not a change in it: a wallet holding 3.88% of supply is not up
// 3.88%, so there is no sign.
inline void formatShare(double value, char *out, size_t n)
{
	if (!isfinite(value)) {
		snprintf(out, n, "--");
		return;
	}
	snprintf(out, n, "%.2f%%", value);
}

// ------------------------------------------------------------------ decimal money
//
// Money that is summed, such as a portfolio across wallets, never goes through a float. AGENTS.md: a
// total that disagrees with the pages it was summed from is indistinguishable from a broken widget.
// These hold dollars as int64 micro-dollars (a fixed scale of 1e6), which is what
// service/src/aggregate.ts does with BigInt on the host.

// Addition that refuses to overflow rather than wrapping. Signed overflow is undefined in C++, so
// this checks before adding. The headroom is about nine trillion dollars; a response that reaches it
// is hostile or broken and the caller fails the pass.
inline bool addMicros(int64_t a, int64_t b, int64_t *out)
{
	if (b > 0 && a > INT64_MAX - b) return false;
	if (b < 0 && a < INT64_MIN - b) return false;
	*out = a + b;
	return true;
}

// Micro-dollars as a display string, with thousands separators. Same rounding rule as formatUsd and
// as usd() in devices/src/panel.ts: cents below $1,000, whole dollars from there. $999.996 rounds to
// "$1,000.00" rather than "$1,000", because the branch tests the unrounded figure; that is the host's
// behaviour too, copied rather than corrected.
inline void formatUsdMicros(int64_t micros, char *out, size_t n)
{
	/* `-INT64_MIN` is undefined; negating through unsigned is not. */
	const bool negative = micros < 0;
	const uint64_t magnitude =
	    negative ? (uint64_t)(-(micros + 1)) + 1u : (uint64_t)micros;

	uint64_t whole = 0;
	uint64_t cents = 0;
	bool showCents = false;
	if (magnitude >= 1000ull * 1000000ull) {
		whole = (magnitude + 500000ull) / 1000000ull;
	} else {
		const uint64_t rounded = (magnitude + 5000ull) / 10000ull;
		whole = rounded / 100ull;
		cents = rounded % 100ull;
		showCents = true;
	}

	/* Grouped from the right, which is the direction the groups actually fall in. */
	char digits[24];
	int written = snprintf(digits, sizeof(digits), "%llu", (unsigned long long)whole);
	if (written < 0) {
		snprintf(out, n, "--");
		return;
	}
	char grouped[32];
	size_t g = 0;
	for (int i = 0; i < written && g + 1 < sizeof(grouped); i++) {
		if (i > 0 && (written - i) % 3 == 0) grouped[g++] = ',';
		if (g + 1 < sizeof(grouped)) grouped[g++] = digits[i];
	}
	grouped[g] = '\0';

	if (showCents) {
		snprintf(out, n, "%s$%s.%02u", negative ? "-" : "", grouped, (unsigned)cents);
	} else {
		snprintf(out, n, "%s$%s", negative ? "-" : "", grouped);
	}
}

// A decimal string as micro-dollars. True only if the whole string was a decimal number that fits.
// "2191.42" becomes 2191420000. "9e99", "", "12.3.4", "0x10", trailing text and anything too large
// are refused rather than clamped: a clamped total is a plausible number that is not the number it
// claims to be. strtod is not used, because it accepts "1e30" and "0x10" and rounds to a double.
// Past six decimal places digits are dropped, not rounded.
inline bool parseDecimalMicros(const char *text, int64_t *out)
{
	if (text == nullptr || out == nullptr) return false;
	size_t i = 0;
	while (text[i] == ' ') i++;
	bool negative = false;
	if (text[i] == '+' || text[i] == '-') {
		negative = text[i] == '-';
		i++;
	}

	/* Assembled as unsigned and range-checked once, so nothing here can overflow on the way in. */
	uint64_t value = 0;
	bool sawDigit = false;
	constexpr uint64_t LIMIT = (uint64_t)INT64_MAX / 1000000ull; /* whole dollars that still fit */
	for (; text[i] >= '0' && text[i] <= '9'; i++) {
		sawDigit = true;
		if (value > LIMIT / 10ull) return false;
		value = value * 10ull + (uint64_t)(text[i] - '0');
		if (value > LIMIT) return false;
	}
	uint64_t micros = value * 1000000ull;

	if (text[i] == '.') {
		i++;
		/* Six places kept, the rest dropped rather than rounded: a seventh decimal of a dollar is
		 * below the smallest unit anything downstream can show, and truncating is the behaviour that
		 * cannot surprise a total by rounding a fraction of a millionth upward. */
		uint64_t scale = 100000ull;
		for (; text[i] >= '0' && text[i] <= '9'; i++) {
			sawDigit = true;
			if (scale > 0) {
				micros += (uint64_t)(text[i] - '0') * scale;
				scale /= 10ull;
			}
		}
	}
	while (text[i] == ' ') i++;
	/* Anything left over means this was not a number — "12.3.4", "1e9", "2191.42 USD". */
	if (!sawDigit || text[i] != '\0') return false;
	if (micros > (uint64_t)INT64_MAX) return false;

	*out = negative ? -(int64_t)micros : (int64_t)micros;
	return true;
}

}  // namespace anchor_format
