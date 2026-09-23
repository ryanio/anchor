/* Checks happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include "display_format.h"

#include <cassert>
#include <cmath>
#include <cstring>

namespace {

template <typename Format>
bool says(Format format, double value, const char *expected)
{
	char out[32];
	format(value, out, sizeof(out));
	return std::strcmp(out, expected) == 0;
}

bool micros(int64_t value, const char *expected)
{
	char out[32];
	anchor_format::formatUsdMicros(value, out, sizeof(out));
	return std::strcmp(out, expected) == 0;
}

bool parses(const char *text, int64_t expected)
{
	int64_t out = -7;
	return anchor_format::parseDecimalMicros(text, &out) && out == expected;
}

bool refuses(const char *text)
{
	int64_t out = -7;
	return !anchor_format::parseDecimalMicros(text, &out) && out == -7;
}

}  // namespace

int main()
{
	using namespace anchor_format;

	/* A price: four places under a dollar, cents under a thousand, whole dollars above. A value that
	 * did not arrive is "--", never a zero. */
	assert(says(formatUsd, 0.6601682669434535, "$0.6602"));
	assert(says(formatUsd, 0.24, "$0.2400"));
	assert(says(formatUsd, 1, "$1.00"));
	assert(says(formatUsd, 84.216, "$84.22"));
	assert(says(formatUsd, 3125.4, "$3125"));
	assert(says(formatUsd, NAN, "--"));
	assert(says(formatUsd, INFINITY, "--"));
	assert(says(formatUsd, 0.01, "$0.0100"));
	assert(says(formatUsd, 0, "$0.0000"));

	/* Under a cent: three significant figures, never a row of zeros. */
	assert(says(formatUsd, 0.000021, "$0.000021"));
	assert(says(formatUsd, 0.0012345, "$0.00123"));
	assert(says(formatUsd, 0.009, "$0.009"));
	assert(says(formatUsd, 0.00000000543, "$0.00000000543"));
	assert(says(formatUsd, 0.0000000001234, "$0.000000000123"));
	assert(says(formatUsd, 0.00000000001, "<$0.0000000001"));
	/* And it fits the 16-byte price field both devices draw from. */
	{
		char field[16];
		formatUsd(0.0000000001234, field, sizeof(field));
		assert(std::strcmp(field, "$0.000000000123") == 0);
	}

	/* Volume in the width a row can spare. */
	assert(says(formatBigUsd, 15500000, "$15.5M"));
	assert(says(formatBigUsd, 997000, "$997K"));
	assert(says(formatBigUsd, 2400000000.0, "$2.4B"));
	assert(says(formatBigUsd, 540.5, "$540.50"));
	assert(says(formatBigUsd, -6600000, "$-6.6M"));
	assert(says(formatBigUsd, NAN, "--"));

	/* A change is signed and a share is not. */
	assert(says(formatPercent, 3.88, "+3.88%"));
	assert(says(formatPercent, -4.58, "-4.58%"));
	assert(says(formatPercent, 0, "+0.00%"));
	assert(says(formatPercent, NAN, "--"));
	assert(says(formatShare, 3.88, "3.88%"));
	assert(says(formatShare, NAN, "--"));

	/* Summed money: grouped, cents below a thousand, and the host's boundary artefact kept. */
	assert(micros(0, "$0.00"));
	assert(micros(2191420000, "$2,191"));
	assert(micros(105290000, "$105.29"));
	assert(micros(999995000, "$1,000.00"));
	assert(micros(1000000000, "$1,000"));
	assert(micros(-3033000000, "-$3,033"));
	assert(micros(1234567890123456, "$1,234,567,890"));
	assert(micros(INT64_MIN, "-$9,223,372,036,855"));

	/* Only a whole decimal number becomes money; everything else is refused, not clamped. */
	assert(parses("2191.42", 2191420000));
	assert(parses("-0.5", -500000));
	assert(parses("+5", 5000000));
	assert(parses(" 12 ", 12000000));
	assert(parses("1.1234567", 1123456));
	assert(parses(".5", 500000));
	assert(refuses(""));
	assert(refuses("1e9"));
	assert(refuses("12.3.4"));
	assert(refuses("0x10"));
	assert(refuses("12 USD"));
	assert(refuses("."));
	assert(refuses("99999999999999999999"));
	assert(refuses(nullptr));

	/* Addition refuses to wrap. */
	int64_t sum = 0;
	assert(addMicros(2, 3, &sum) && sum == 5);
	assert(!addMicros(INT64_MAX, 1, &sum) && sum == 5);
	assert(!addMicros(INT64_MIN, -1, &sum));

	/* Untrusted text: printable ASCII only, bounded, and "?" for something entirely unprintable. */
	char text[8];
	copyBounded(text, sizeof(text), "PONS");
	assert(std::strcmp(text, "PONS") == 0);
	copyBounded(text, sizeof(text), "a\nb\x1b[31mc");
	assert(std::strcmp(text, "ab[31mc") == 0);
	copyBounded(text, sizeof(text), "\xf0\x9f\x98\x80");
	assert(std::strcmp(text, "?") == 0);
	copyBounded(text, sizeof(text), "a very long collection name");
	assert(std::strcmp(text, "a very ") == 0);
	copyBounded(text, sizeof(text), nullptr);
	assert(text[0] == '\0');
	return 0;
}
