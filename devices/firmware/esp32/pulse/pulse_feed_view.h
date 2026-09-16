#ifndef ANCHOR_PULSE_FEED_VIEW_H
#define ANCHOR_PULSE_FEED_VIEW_H

#include "pulse_ui.h"

/*
 * Turning what the feed knows into what the screen says.
 *
 * This is deliberately a pure function over plain values rather than a call that reaches into
 * `feed.h`, and the reason is the simulator. `app/feed.cpp` pulls in HTTPClient, NetworkClientSecure
 * and a FreeRTOS task; shimming all of that on the desktop would be a day's work in service of
 * looking at a screen. The mapping is the part worth looking at, so the mapping is the part kept
 * free of Arduino — exactly the split `pulse_ui.cpp` already makes, and for the same reason.
 *
 * `pulse.ino` owns the adaptation from `feed::Snapshot` to these arguments; it is a handful of
 * pointers and an integer, and it is the only place the two headers meet.
 *
 * The rule this encodes, which is `AGENTS.md`'s and not a preference: **a panel with no data says
 * why**, and a panel with old data says how old. Between them those cover every state this device
 * can be in with nobody at a desk to interpret it — no network typed in yet, joining, joined but
 * nothing fetched, fetched and stale, fetched and fresh, and failed with a reason. A blank screen
 * that means six different things is the failure mode this project has already shipped once.
 */
namespace pulse_feed_view {

/* Mirrors `feed::Status` by value rather than by include, for the reason in the header comment.
 * The order matches; a static assert in `pulse.ino` holds the two together so a reorder cannot
 * silently remap them. */
enum class Status : uint8_t { Disabled, NoCredentials, Joining, Online, Fetching, Failed };

struct Token {
	const char *symbol;
	const char *name;
	const char *price;
	const char *change;
	bool changePositive;
};

/*
 * What the screen should show, given everything known.
 *
 * `rotation` selects which token is up when there are several — the host does the same thing with a
 * wall clock so that several panels on one desk agree without talking to each other, and the same
 * trick works here for free.
 *
 * `ageMs` is only meaningful once something has been fetched; `everSucceeded` is what distinguishes
 * "nothing yet" from "nothing since", which are different sentences to a person holding the unit.
 */
pulse_ui::Reading compose(Status status, const char *reason, const Token *tokens, size_t count,
                          size_t rotation, uint32_t ageMs, bool everSucceeded);

/* "just now", "12s ago", "4m ago" — shared with the boot-age footer so one clock is described one
 * way everywhere on this screen. */
void formatAge(uint32_t ms, char *into, size_t size);

}  // namespace pulse_feed_view

#endif /* ANCHOR_PULSE_FEED_VIEW_H */
