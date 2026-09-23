/* Checks happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include "freshness.h"

#include <cassert>
#include <cstring>

namespace {

bool says(uint32_t ms, const char *expected,
          anchor_freshness::Resolution resolution = anchor_freshness::Resolution::Seconds)
{
	char out[16];
	anchor_freshness::formatAge(ms, out, sizeof(out), resolution);
	return std::strcmp(out, expected) == 0;
}

}  // namespace

int main()
{
	using anchor_freshness::NEVER;
	using anchor_freshness::Resolution;

	/* Seconds: the ESP32's existing wording, unchanged by moving it here. */
	assert(says(0, "just now"));
	assert(says(999, "just now"));
	assert(says(1000, "1s ago"));
	assert(says(59999, "59s ago"));
	assert(says(60000, "1m ago"));
	assert(says(3599999, "59m ago"));
	assert(says(3600000, "1h ago"));

	/* Minutes: nothing under a minute changes the label, so a whole-screen repaint is at most once a
	 * minute. */
	assert(says(0, "just now", Resolution::Minutes));
	assert(says(59999, "just now", Resolution::Minutes));
	assert(says(60000, "1m ago", Resolution::Minutes));
	assert(says(240000, "4m ago", Resolution::Minutes));
	assert(says(7200000, "2h ago", Resolution::Minutes));

	/* A reading that never arrived is not an old one. */
	assert(says(NEVER, "never"));
	assert(says(NEVER, "never", Resolution::Minutes));
	assert(anchor_freshness::age(5000, 1000, false) == NEVER);

	/* Age survives the millis() wrap at 49.7 days. */
	assert(anchor_freshness::age(5000, 1000, true) == 4000);
	assert(anchor_freshness::age(1000, UINT32_MAX - 999, true) == 2000);

	/* A short buffer truncates rather than overruns, and a null one is ignored. */
	char tiny[4];
	anchor_freshness::formatAge(3600000, tiny, sizeof(tiny));
	assert(std::strcmp(tiny, "1h ") == 0);
	anchor_freshness::formatAge(0, nullptr, 8);
	return 0;
}
