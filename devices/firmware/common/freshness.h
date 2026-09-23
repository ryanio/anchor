#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

// How old a reading is, said the same way on both handhelds.
//
// A cached reading is kept on screen when the network goes away, because a labelled old number beats
// a blank panel. It is only honest while the label is there, so both devices describe age with this
// one function rather than two that drift apart.
namespace anchor_freshness {

// "Never fetched". A caller that has a reading passes a real age instead.
constexpr uint32_t NEVER = UINT32_MAX;

// Seconds suit a panel that redraws freely. Minutes suit a screen that repaints whole, where a label
// changing every second would mean a repaint every second.
enum class Resolution : uint8_t { Seconds, Minutes };

// Milliseconds from `since` to `now`, correct across the 49-day `millis()` wrap. `NEVER` when there
// has been no reading.
inline uint32_t age(uint32_t now, uint32_t since, bool ever)
{
	return ever ? (uint32_t)(now - since) : NEVER;
}

// "just now", "12s ago", "4m ago", "3h ago", or "never". With `Minutes`, everything under a minute is
// "just now".
inline void formatAge(uint32_t ms, char *out, size_t n, Resolution resolution = Resolution::Seconds)
{
	if (out == nullptr || n == 0) {
		return;
	}
	if (ms == NEVER) {
		snprintf(out, n, "never");
		return;
	}
	const uint32_t seconds = ms / 1000u;
	const uint32_t floor = resolution == Resolution::Minutes ? 60u : 1u;
	if (seconds < floor) {
		snprintf(out, n, "just now");
	} else if (seconds < 60u) {
		snprintf(out, n, "%us ago", (unsigned)seconds);
	} else if (seconds < 3600u) {
		snprintf(out, n, "%um ago", (unsigned)(seconds / 60u));
	} else {
		snprintf(out, n, "%uh ago", (unsigned)(seconds / 3600u));
	}
}

}  // namespace anchor_freshness
