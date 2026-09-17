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
 *
 * **This function also picks the archetype.** A state with no data returns `Screen::Kind::Status`
 * and a state with data returns `Screen::Kind::Reading`, which is the decision that stops a status
 * word from being rendered as a portfolio with one row filled in — see the note at the top of
 * `pulse_ui.h`. It belongs here rather than in the layout because "is there anything to read" is a
 * question about the data.
 *
 * ## Two subjects, one panel
 *
 * The device now fetches two things — a trending list and a portfolio — and they fail
 * independently. The panel shows them in **one rotation**, with the portfolio first:
 *
 *     slot 0        the portfolio
 *     slot 1..N     the trending tokens, one at a time
 *
 * **Why a rotation rather than a second screen.** This firmware has exactly one gesture on the
 * ambient screen and it is already spoken for: a hold opens Wi-Fi setup, and a press writes the
 * touch calibration readout. There is no page affordance, nothing on the glass suggests one exists,
 * and a portfolio reachable only by a gesture nobody can guess is a portfolio nobody sees. A
 * rotation is also what the desktop already does with several surfaces, and it costs no input at
 * all — the device is ambient, and the thing you are meant to do with it is glance.
 *
 * **Why the portfolio is slot 0.** `millis() / ROTATE_MS` starts at zero, so a unit that has just
 * been switched on opens on the number it is for, and comes back to it once per cycle.
 *
 * **Each subsystem always owns at least one slot**, which is the part that makes every state
 * reachable. With no tokens, slot 1 is the trending *status* saying why there are none; with no
 * portfolio, slot 0 is the portfolio status saying why. Neither can be squeezed out by the other
 * having data, so there is no combination in which a failure becomes invisible because something
 * else on the device is fine.
 */
namespace pulse_feed_view {

/* Mirrors `feed::Status` by value rather than by include, for the reason in the header comment.
 * The order matches; a static assert in `pulse.ino` holds the two together so a reorder cannot
 * silently remap them. `NoWallets` is last there and last here. */
enum class Status : uint8_t { Disabled, NoCredentials, Joining, Online, Fetching, Failed, NoWallets };

struct Token {
	const char *symbol;
	const char *name;
	const char *price;
	const char *change;
	bool changePositive;
};

/* Everything about the trending half, as `feed::Snapshot` knows it.
 *
 * `ageMs` is only meaningful once something has been fetched; `everSucceeded` is what distinguishes
 * "nothing yet" from "nothing since", which are different sentences to a person holding the unit. */
struct Trending {
	Status status = Status::Online;
	const char *reason = "";
	const Token *tokens = nullptr;
	size_t count = 0;
	uint32_t ageMs = 0;
	bool everSucceeded = false;
};

/*
 * Everything about the portfolio half, already formatted.
 *
 * Strings rather than numbers for the reason `pulse_ui::Reading` gives at length: whoever produces
 * the reading produces the text, because formatting money is a decision this repo already made once
 * and a renderer with a second opinion about it is a second number.
 *
 * `covered` and `configured` are not decoration and are not optional. AGENTS.md: "A partial answer
 * is labelled, never trimmed ... the panel says '8 of 9 wallets'." Anything this file does with
 * `total` it must also do with these two, or it is drawing a figure whose scope it has hidden.
 */
struct Portfolio {
	Status status = Status::NoWallets;
	const char *reason = "";
	const char *total = "--";
	const char *nftValue = "--";
	const char *change = "--";
	bool changePositive = false;
	bool haveChange = false;
	size_t covered = 0;
	size_t configured = 0;
	uint32_t ageMs = 0;
	bool everSucceeded = false;
};

/*
 * What the screen should show, given everything known.
 *
 * `rotation` selects which slot is up — the host does the same thing with a wall clock so that
 * several panels on one desk agree without talking to each other, and the same trick works here for
 * free. Slot 0 is the portfolio; see the header comment for why.
 */
pulse_ui::Screen compose(const Trending &trending, const Portfolio &portfolio, size_t rotation);

/* How many slots the rotation has, given what there is to show. Exported because it is the one piece
 * of arithmetic a caller might want to reason about, and because a test that wants slot 3 should not
 * have to rediscover the rule. */
size_t slotCount(const Trending &trending);

/* "just now", "12s ago", "4m ago" — shared with the stale footer so one clock is described one way
 * everywhere on this screen. */
void formatAge(uint32_t ms, char *into, size_t size);

}  // namespace pulse_feed_view

#endif /* ANCHOR_PULSE_FEED_VIEW_H */
