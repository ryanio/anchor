#ifndef ANCHOR_PULSE_UI_H
#define ANCHOR_PULSE_UI_H

#include <lvgl.h>

/*
 * The screen, as LVGL objects, with no Arduino in it.
 *
 * This file and `pulse_ui.cpp` are the only part of this sketch that knows what a portfolio readout
 * looks like, and they are deliberately free of `Arduino.h`, `Wire.h` and the panel driver. That is
 * what lets the host simulator (`../sim/lvgl.sh`) build the *same* screen against the *same* LVGL
 * and photograph it, rather than a transcription of it — the seam the Cardputer and the existing
 * `app/` simulator both put in the same place.
 *
 * ## Why this device draws at all
 *
 * `docs/devices-esp32.md` spends a section arguing the opposite: the host renders, the device blits,
 * and the firmware owns no font, no palette and no layout. Every word of that is still true of
 * `app/`, which is the firmware that ships today. What changed is the requirement, not the argument:
 * these units have to work in the field with nothing on the cable, and a blitter with no host is a
 * dark panel. The doc names this exact case and leaves it open — "a standalone renderer for actual
 * portfolio data with no host present ... is still open, and is a separate, larger call". Ryan made
 * the call. This is that renderer, and it pays the costs the doc priced:
 *
 *   - **It holds its own palette.** The colours below are Tokyo Night, sampled out of
 *     `review/devices/pulse-amoled.png` rather than typed from memory, because that render is the
 *     design target. A device on a desk whose Omarchy theme has since changed will now disagree with
 *     the bar above it. That is the "one widget that ignores the user's desktop" failure, in
 *     hardware, and it is accepted here rather than denied — the fix, when it matters, is for the
 *     host to send a palette when it *is* connected, not for this file to pretend it has one.
 *   - **It holds its own typeface.** Montserrat, from LVGL, not the user's fontconfig monospace.
 *   - **A design change is a flash.** Which is why the simulator exists and why it is the thing to
 *     use first.
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

/* Build the screen onto LVGL's active display. Call once, after `lv_init()` and after a display
 * exists. */
void build(const Reading &reading);

/* Repaint the values in place. LVGL invalidates only what changed, so an unchanged reading costs
 * nothing on the bus — the same promise the blitter's dirty-rect diff makes. */
void update(const Reading &reading);

/* Just the footer, which is the one field that changes every second whether the reading does or
 * not. Separate so that a ticking age does not mark four unchanged numbers dirty. */
void setAge(const char *age);

/*
 * The object a touch lands on, for whoever owns input.
 *
 * This file draws and knows nothing about fingers; `pulse.ino` owns the indev and attaches its own
 * handler here. Keeping the seam at one accessor rather than putting an `lv_obj_add_event_cb` in
 * `build()` is what stops the layout from also being the place product behaviour accumulates — the
 * same reason the host's renderer has no opinion about what a tap means and `panel.ts` does.
 *
 * Null before `build()` has run.
 */
lv_obj_t *surface();

}  // namespace pulse_ui

#endif /* ANCHOR_PULSE_UI_H */
