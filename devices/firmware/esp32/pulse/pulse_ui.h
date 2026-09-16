#ifndef ANCHOR_PULSE_UI_H
#define ANCHOR_PULSE_UI_H

#include <lvgl.h>

#include "pulse_design.h"

/*
 * The ambient screen, as LVGL objects, with no Arduino in it.
 *
 * This file and `pulse_ui.cpp` are the only part of this sketch that knows what the resting panel
 * looks like, and they are deliberately free of `Arduino.h`, `Wire.h` and the panel driver. That is
 * what lets the host simulator (`../sim/lvgl.sh`) build the *same* screen against the *same* LVGL
 * and photograph it, rather than a transcription of it — the seam the Cardputer and the existing
 * `app/` simulator both put in the same place.
 *
 * ## Two kinds of screen, not one with holes in it
 *
 * There used to be one: a reading, with four label/value pairs. Every state that had no data was
 * drawn through it anyway, which meant the word "not set up" landed in the right-aligned 40px value
 * column at x=123 with three empty pairs beneath it and about 250px of dead panel underneath that.
 * Reported in as many words — "the not set up is weirdly to the right with a lot of blank space" —
 * and it is not a spacing bug. A status is a different kind of screen.
 *
 * So `Screen` is a tagged union of the two, both built at `build()` time and one shown at a time,
 * and both drawn from the archetypes in `pulse_design.h`. Which one is up is decided by whoever
 * composes the screen — `pulse_feed_view.cpp` — because the question "is there a reading" is a
 * question about the data and not about the layout.
 *
 * ## Why this device draws at all
 *
 * `docs/devices-esp32.md` spends a section arguing the opposite: the host renders, the device blits,
 * and the firmware owns no font, no palette and no layout. Every word of that is still true of
 * `app/`, which is the firmware that ships today. What changed is the requirement, not the argument:
 * these units have to work in the field with nothing on the cable, and a blitter with no host is a
 * dark panel. The doc names this exact case and leaves it open — "a standalone renderer for actual
 * portfolio data with no host present ... is still open, and is a separate, larger call". Ryan made
 * the call. This is that renderer, and it pays the costs the doc priced: it holds its own palette
 * (`pulse_design.h`, which is now the single place that is true of), it holds its own typeface, and
 * a design change is a flash — which is why the simulator exists and is the thing to use first.
 */
namespace pulse_ui {

/*
 * One reading, as the four label/value pairs the panel shows plus its own provenance.
 *
 * Strings rather than numbers, and that is on purpose: formatting money is a decision with a right
 * answer that this repo already made once, in `service/src/aggregate.ts`, with BigInt at a common
 * scale. A float and a `%.2f` here would be a second opinion about a number somebody reads as a
 * balance, and AGENTS.md is explicit that a total which disagrees with what it was summed from is
 * indistinguishable from a broken widget. So whoever produces the reading produces the text.
 */
struct Reading {
	const char *title = "Portfolio";
	const char *total = "--";
	const char *pnl = "--";
	/* -1 loss, 0 flat or unknown, +1 gain. Tone is carried separately from the text so that a
	 * value which happens to start with '-' is not what decides the colour. */
	int pnl_tone = 0;
	const char *nfts = "--";
	const char *window = "--";
	/* How old the reading is. Never truncated — `theme/README.md` principle 6: a number without
	 * how-old is a number nobody can check. */
	const char *age = "--";
	/*
	 * What the four rows are called.
	 *
	 * These were fixed in `build()` at "Total / P&L / NFTs / Window", which was right while the only
	 * thing this screen could show was a portfolio. It now also shows a trending token, whose rows
	 * are a price and a 24h move — and a price under a label reading "Total" is not a cosmetic
	 * mismatch, it is a number claiming to be a different number. That is the failure this project
	 * rates above every other, so the labels travel with the values that justify them.
	 *
	 * They default to the portfolio's, so a caller that only sets values is unchanged.
	 */
	const char *labels[4] = {"Total", "P&L", "NFTs", "Window"};
};

/*
 * One state, said plainly, with what to do about it.
 *
 * The fields are the status archetype's slots and the rules for filling them are worth stating,
 * because the difference between this reading well and reading like an error dialogue is entirely in
 * the copy:
 *
 *   `eyebrow`  the subsystem this is about, so a person knows which of two things is unhappy.
 *   `headline` the state, in two or three words. It is set in the largest face that fits it, which
 *              means a long one silently shrinks — prefer short.
 *   `tone`     `Accent` while something is in progress, `Bad` for a failure, `Warn` for a fact that
 *              is not a fault. A unit built without an API key is behaving exactly as the checkout
 *              it came from asked it to, and must not wear red.
 *   `detail`   what a person can *do*, or what is being waited for. The sentence somebody who has
 *              walked over to the device reads.
 *   `support`  what the layer underneath said, in its own words — an HTTP reason, an IP address.
 *   `note`     provenance. An age, or the touch coordinate the calibration readout borrows.
 */
struct Status {
	const char *eyebrow = "";
	const char *headline = "";
	pulse_design::Tone tone = pulse_design::Tone::Ink;
	const char *detail = "";
	const char *support = "";
	const char *note = "";
};

/* What the panel should be showing. `kind` selects which of the two archetypes is up. */
struct Screen {
	enum class Kind : uint8_t { Reading, Status };
	Kind kind = Kind::Status;
	Reading reading;
	Status status;
};

/* Build both archetypes onto LVGL's active display and show the one `screen` selects. Call once,
 * after `lv_init()` and after a display exists. */
void build(const Screen &screen);

/* Repaint in place, swapping archetypes if the kind changed. LVGL invalidates only what changed, so
 * an unchanged screen costs nothing on the bus — the same promise the blitter's dirty-rect diff
 * makes. */
void update(const Screen &screen);

/*
 * Just the footer line, which is the one field that changes every second whether anything else does
 * or not. Separate so that a ticking age does not mark four unchanged numbers dirty.
 *
 * It writes to whichever archetype is showing: the reading's age line, or the status's note. There
 * is exactly one bottom line on this panel and both kinds of screen own theirs.
 */
void setFooter(const char *text);

/*
 * The object a touch lands on, for whoever owns input.
 *
 * This file draws and knows nothing about fingers; `pulse.ino` owns the indev and attaches its own
 * handler here. Keeping the seam at one accessor rather than putting an `lv_obj_add_event_cb` in
 * `build()` is what stops the layout from also being the place product behaviour accumulates — the
 * same reason the host's renderer has no opinion about what a tap means and `panel.ts` does.
 *
 * It is the whole panel and not the card, which matters for the one gesture that has to be
 * discoverable: with no network saved, a tap anywhere opens setup, and the status screen says so in
 * as many words. A target that stopped at the card's edge would have a ring of glass that silently
 * does nothing.
 *
 * Null before `build()` has run.
 */
lv_obj_t *surface();

}  // namespace pulse_ui

#endif /* ANCHOR_PULSE_UI_H */
