#include "pulse_design.h"

#include <stdio.h>
#include <string.h>

namespace pulse_design {

namespace {

/* ------------------------------------------------------------------------ the reading's metrics - */

/*
 * The card is inset a step from the panel and its content a step from the card, which puts the first
 * pixel of text at 32 — a step and a half outside the corner clearance, because the card's own
 * rounded corner is already inside it.
 *
 * `READING_ROW_STEP` is the one number here that is not a step off the scale, and it is not arbitrary
 * either: four rows plus the title block plus the footer is exactly the 448 available, so it is the
 * panel divided by its content rather than a gap somebody chose. The footer numbers moved once after
 * looking at the render — the first pass left 6px between the last row and the rule and 32px of dead
 * space under the footer text, which reads as a screen that has slumped upward. Obvious in a PNG and
 * invisible in the arithmetic, which is the whole reason `sim/lvgl.sh` exists.
 */
constexpr int32_t CARD_INSET = space::md;
constexpr int32_t CARD_PAD = space::lg;
constexpr int32_t CARD_W = PANEL_W - 2 * CARD_INSET;
constexpr int32_t CARD_H = PANEL_H - 2 * CARD_INSET;
constexpr int32_t CARD_INNER_W = CARD_W - 2 * CARD_PAD; /* 304 */
constexpr int32_t READING_TITLE_Y = space::lg;
constexpr int32_t READING_RULE_Y = 378;
/*
 * 389 and not 394, which is where it sat while it was the only thing on this line.
 *
 * The battery chip is 36px tall and bottoms out on the safe rectangle, so its centre line is at 410
 * on the panel; a 16px footer at 394 centres at 415 and sat five pixels low against it. Invisible in
 * the arithmetic and immediately obvious in the render, which is the whole reason `sim/lvgl.sh`
 * exists.
 */
constexpr int32_t READING_FOOTER_Y = 389;

/*
 * The label column is the left third and the value column the right two thirds.
 *
 * That split is decided by the longest thing each column has to hold, not by taste — "Window" at
 * 22px is about 72px wide, comfortably inside a third, while the value is the number that grows.
 * Only slots 1-3 use it; the lead's label sits above its value and owns the full measure.
 */
constexpr int32_t READING_LABEL_W = CARD_INNER_W / 3;      /* 101 */
constexpr int32_t READING_VALUE_W = CARD_INNER_W - READING_LABEL_W; /* 203 */
constexpr int32_t READING_VALUE_X = CARD_PAD + READING_LABEL_W;

/*
 * The four slots, in rank order, as the two y-coordinates each one needs.
 *
 * These are not steps off the spacing scale and they are not arbitrary either: they are the panel
 * divided by the weights it has to carry. A 48px lead, a 32px second voice, two 22px supporting rows
 * and a footer is exactly the 424 of card available, and the gaps between them fall out of that
 * rather than being chosen. Everything here moved once already after looking at a render — the first
 * pass put the two supporting rows 40px apart, which read as two unrelated rows rather than a pair,
 * and pulled them to 44 with a wider gap above the first.
 *
 * `label_y` is fixed and `value_y` is where the value sits *at its slot's largest face*. A value that
 * has to step down a size is nudged down by `valueFont`'s `drop` so its baseline stays where the
 * label beside it expects — a 22px label against a 32px value aligned at the top looks like the
 * label floated, which is the thing `READING_LABEL_DROP` was fixing before there were slots.
 */
struct SlotMetrics {
	int32_t label_y;
	int32_t value_y;
	/* The lead: label above the value, both left-aligned across the full measure. */
	bool stacked;
};
constexpr SlotMetrics SLOT[4] = {
    {76, 100, true},
    {209, 202, false},
    {287, 284, false},
    {331, 328, false},
};

/* Where the two rules that separate the three weights sit. */
constexpr int32_t SLOT_DIVIDER_Y[2] = {182, 264};

/*
 * The footer is left-aligned rather than centred, and that is not a preference either.
 *
 * The battery chip now sits at the bottom right of the panel, on the same metadata line. A centred
 * age ran straight under it as soon as the string grew — "stale, 12m ago" is about 110px, which
 * starting from the centre of a 304px measure reaches x=239 against a chip that begins at 204. So
 * the line is now two things at two ends: how old on the left, how much charge on the right.
 */
constexpr int32_t READING_FOOTER_W = CARD_INNER_W - BATTERY_W - space::md; /* 160 */

/* ------------------------------------------------------------------------- the status's metrics - */

constexpr int32_t STATUS_BAR_W = 80;
constexpr int32_t STATUS_BAR_H = 4;
/* A narrower measure than the safe width, on purpose: a centred sentence set to the full 328 breaks
 * into lines of wildly different length and reads as ragged. A step in from each side gives two
 * balanced lines for the sentences these screens actually carry. */
constexpr int32_t STATUS_TEXT_W = SAFE_W - 2 * space::lg; /* 288 */

/* ------------------------------------------------------------------------ the chooser's metrics - */

constexpr int32_t CHOOSER_TITLE_Y = INSET;
constexpr int32_t CHOOSER_SUB_Y = 56;
constexpr int32_t CHOOSER_LIST_Y = 90;
/*
 * `CHOOSER_LIST_HEIGHT` and not `..._LIST_H`, which is a name a file including `WiFi.h` cannot have.
 *
 * `LIST_H` is an include guard in one of the headers the ESP32 core drags in behind `WiFi.h`, so on
 * the board it expands to nothing and the line becomes `constexpr int32_t = 296;`. The desktop
 * simulator compiles against shims that include no such header and was perfectly happy — which is
 * worth writing down, because it is the one class of mistake this harness cannot catch and the only
 * cure is to compile for the board before believing it.
 */
constexpr int32_t CHOOSER_ACTION_H = 56;
constexpr int32_t CHOOSER_ACTION_Y = PANEL_H - INSET - CHOOSER_ACTION_H; /* 372 */
constexpr int32_t CHOOSER_LIST_HEIGHT = CHOOSER_ACTION_Y - space::md - CHOOSER_LIST_Y;
/*
 * Three buttons across the safe width, and the arithmetic used to be wrong.
 *
 * They were 109 wide under a comment reading "three of these plus two 8px gaps is 343 of 344" — a
 * figure computed when `INSET` was 12. The inset went to 20 after a heading came out clipped and the
 * button row did not follow, so the last button's right edge sat at 363: five pixels from the panel
 * edge, inside the rounded corner, on the only screen a stranger is guaranteed to see. Derived from
 * `SAFE_W` now, so the next inset change carries it.
 */
constexpr int32_t CHOOSER_ACTION_GAP = space::sm;
constexpr int32_t CHOOSER_ACTION_W = (SAFE_W - 2 * CHOOSER_ACTION_GAP) / 3; /* 104 */

/* -------------------------------------------------------------------------- the input's metrics - */

constexpr int32_t INPUT_TITLE_Y = INSET;
constexpr int32_t INPUT_SUB_Y = 54;
constexpr int32_t INPUT_FIELD_Y = 84;
constexpr int32_t INPUT_FIELD_H = 56;
constexpr int32_t INPUT_REVEAL_W = 72;
constexpr int32_t INPUT_FIELD_W = SAFE_W - INPUT_REVEAL_W - space::sm; /* 248 */
constexpr int32_t INPUT_HINT_Y = 150;
/*
 * The keyboard: 352 wide at x=8, 242 tall from y=186 to the safe bottom at 428.
 *
 * Key height is the axis that is free here and `app/wifi_setup.cpp` measured what happens when it is
 * spent badly — four rows ending at y=304 left the bottom third of the panel dead while the keys
 * were the hardest thing on it to hit. LVGL's map is four rows, so 242/4 is 60px a row, about 4.8 mm
 * on this 322 ppi glass against the 9-10 mm a touch target wants. That is still under target and it
 * is the best this panel can do with ten columns; the magnifier is what closes the rest of the gap.
 *
 * It ran to y=440 before, which is twelve pixels past the safe rectangle and straight into both
 * bottom corners — the same corner clearance that clipped the "Wi-Fi" heading, on the row carrying
 * the space bar and the OK key. It ends at 428 now and the rows lost a pixel each.
 *
 * The 36px between the hint line and the top row is where LVGL draws the popover for a pressed key,
 * and a keyboard flush against the hint would have the popover cover the text somebody is checking.
 */
constexpr int32_t INPUT_KB_X = space::sm;
constexpr int32_t INPUT_KB_W = PANEL_W - 2 * INPUT_KB_X; /* 352 */
constexpr int32_t INPUT_KB_Y = 186;
constexpr int32_t INPUT_KB_H = PANEL_H - INSET - INPUT_KB_Y; /* 242 */

/*
 * Hidden, which LVGL's flex reads as "not in the track at all" — checked, not assumed.
 *
 * The status block's whole premise is that an unused slot costs no space, so this was measured
 * against the tree dump rather than eyeballed: the "Not set up" screen's visible run is 165 px and
 * it starts at content-relative y=121, which is exactly `(408 - 165) / 2` for the 408 px safe
 * height. Two hidden labels below it contribute nothing.
 *
 * Worth recording how that reading nearly went wrong, because the same trap is waiting for the next
 * person who checks a layout this way: **`lv_obj_get_x/y` in LVGL 9 are relative to the parent's
 * content box, not its outer edge.** Read as absolute panel coordinates they make a correctly
 * centred block look 20 px — one `INSET` — high, which is a bug that does not exist, and the fix for
 * it would have pushed the real layout 20 px low.
 */
void showIf(lv_obj_t *obj, bool visible)
{
	if (obj == nullptr) return;
	if (visible) {
		lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
	}
}

bool has(const char *text)
{
	return text != nullptr && text[0] != '\0';
}

/*
 * The largest face the headline fits in, rather than one size for every state.
 *
 * "Joining" and "Not set up" are the same kind of fact and want the same weight on the glass, but
 * they are seven characters and ten; setting both at a size chosen for the longer wastes the panel on
 * the shorter. There are no font metrics worth calling here — this is a character count against a
 * measured average, the same approximation `pulse_feed_view.cpp` already makes — so the thresholds
 * are deliberately conservative: Montserrat 48 runs about 26px a glyph and 328px is twelve of them,
 * and this stops at nine.
 */
/*
 * The same trick for a reading's value, and here it is not polish — it is the difference between a
 * price and a rumour of one.
 *
 * `$26,444,366` is a real row: it is in the simulator's seeds precisely because a real trending
 * response produced it, against a value column that is 203px wide. At 40px that is eleven glyphs of
 * about 22px, so it came out as `$26,444...` — and an ellipsised price is worse than a small one,
 * because a number with its tail cut off still reads as a number. Stepping down one face keeps every
 * digit. The ellipsis stays as the last resort below this, for a string no face will hold.
 *
 * ## Now it is per-slot, because the slots are different widths at different sizes
 *
 * The lead runs at 48px across the whole 304px measure, which is about eleven glyphs at Montserrat's
 * ~27px advance; slots 1-3 run at 32px and 22px in a 203px column, which is eleven and sixteen. The
 * thresholds below are those three counts, each one step conservative — the same character-count
 * approximation `headlineFont` and `pulse_feed_view.cpp` already make, for the same reason: there
 * are no font metrics worth calling here and an ellipsis is visible in the render when one is wrong.
 *
 * `drop` is what keeps a row's baseline where it was: the label beside it is positioned against the
 * slot's largest cap height, so a smaller value has to move down by the difference. About 0.73 of
 * the size is where a Montserrat baseline sits, which is close enough at these steps and was checked
 * in a render rather than trusted. The lead's label is *above* its value, so a shorter face there
 * changes nothing and the drop is zero.
 */
const lv_font_t *valueFont(int slot, const char *text, int32_t &drop)
{
	const size_t length = text == nullptr ? 0 : strlen(text);
	drop = 0;
	if (slot == 0) {
		if (length <= 10) return type::display();
		if (length <= 13) return type::hero();
		return type::shout();
	}
	if (slot == 1) {
		if (length <= 11) return type::shout();
		if (length <= 15) {
			drop = 6;
			return type::heading();
		}
		drop = 9;
		return type::body();
	}
	if (length <= 16) return type::subhead();
	drop = 3;
	return type::label();
}

const lv_font_t *headlineFont(const char *text)
{
	const size_t length = text == nullptr ? 0 : strlen(text);
	if (length <= 9) return type::display();
	if (length <= 13) return type::hero();
	return type::shout();
}

}  // namespace

/* ------------------------------------------------------------------------------- the primitives - */

lv_color_t hex(uint32_t rgb)
{
	return lv_color_hex(rgb);
}

uint32_t toneColour(Tone tone)
{
	switch (tone) {
		case Tone::Quiet:
			return colour::ink_dim;
		case Tone::Accent:
			return colour::accent;
		case Tone::Good:
			return colour::good;
		case Tone::Bad:
			return colour::bad;
		case Tone::Warn:
			return colour::warn;
		default:
			return colour::ink;
	}
}

lv_obj_t *makeLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t rgb, int32_t x, int32_t y,
                    int32_t width, lv_text_align_t align)
{
	lv_obj_t *label = lv_label_create(parent);
	lv_obj_set_pos(label, x, y);
	lv_obj_set_width(label, width);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(rgb), LV_PART_MAIN);
	lv_obj_set_style_text_align(label, align, LV_PART_MAIN);
	/*
	 * Ellipsis rather than clip, everywhere, including the reading's values.
	 *
	 * A clipped string and a short string look identical, which on a panel showing money is a balance
	 * quietly missing a digit — the failure this project rates above every other. Three dots is the
	 * same fit problem reported rather than hidden, and `pulse_feed_view.cpp` already leans on that
	 * being visible: its nine-character budget for a status word was derived by watching one overflow.
	 */
	lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
	return label;
}

lv_obj_t *makeFlowLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t rgb, int32_t width,
                        bool wrap)
{
	lv_obj_t *label = lv_label_create(parent);
	lv_obj_set_width(label, width);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(rgb), LV_PART_MAIN);
	lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
	lv_label_set_long_mode(label, wrap ? LV_LABEL_LONG_WRAP : LV_LABEL_LONG_DOT);
	return label;
}

lv_obj_t *makeButton(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h, const char *text,
                     const lv_font_t *font, lv_obj_t **label_out)
{
	lv_obj_t *button = lv_button_create(parent);
	lv_obj_set_pos(button, x, y);
	lv_obj_set_size(button, w, h);
	lv_obj_set_style_bg_color(button, hex(colour::raised), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(button, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(button, hex(colour::edge), LV_PART_MAIN);
	lv_obj_set_style_border_width(button, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(button, radius::sm, LV_PART_MAIN);
	lv_obj_set_style_shadow_width(button, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(button, 0, LV_PART_MAIN);
	/* A press has to be loud on a controller that has never yet answered with a coordinate: it is the
	 * only thing on the glass that says the touch registered at all. */
	lv_obj_set_style_bg_color(button, hex(colour::accent), LV_PART_MAIN | LV_STATE_PRESSED);
	lv_obj_set_style_text_color(button, hex(colour::ground), LV_PART_MAIN | LV_STATE_PRESSED);
	lv_obj_t *label = lv_label_create(button);
	lv_label_set_text(label, text);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(colour::ink), LV_PART_MAIN);
	lv_obj_center(label);
	if (label_out != nullptr) *label_out = label;
	return button;
}

lv_obj_t *makePage(lv_obj_t *parent)
{
	lv_obj_t *page = lv_obj_create(parent);
	lv_obj_set_pos(page, 0, 0);
	lv_obj_set_size(page, PANEL_W, PANEL_H);
	lv_obj_set_style_bg_opa(page, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(page, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(page, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(page, 0, LV_PART_MAIN);
	lv_obj_remove_flag(page, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(page, LV_SCROLLBAR_MODE_OFF);
	/*
	 * Not clickable, and that is load-bearing rather than tidy.
	 *
	 * `lv_obj_create` makes a clickable object, so a transparent full-panel page over the ambient
	 * screen would swallow every touch — and the ambient screen's whole gesture is that the panel *is*
	 * the button while no network is saved. A page is a layer, not a target.
	 */
	lv_obj_remove_flag(page, LV_OBJ_FLAG_CLICKABLE);
	return page;
}

lv_obj_t *makeRule(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, uint32_t rgb)
{
	lv_obj_t *rule = lv_obj_create(parent);
	lv_obj_set_pos(rule, x, y);
	lv_obj_set_size(rule, w, 1);
	lv_obj_set_style_bg_color(rule, hex(rgb), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_width(rule, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(rule, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(rule, 0, LV_PART_MAIN);
	lv_obj_remove_flag(rule, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_remove_flag(rule, LV_OBJ_FLAG_CLICKABLE);
	return rule;
}

lv_obj_t *makeSurface(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h)
{
	lv_obj_t *card = lv_obj_create(parent);
	lv_obj_set_pos(card, x, y);
	lv_obj_set_size(card, w, h);
	lv_obj_set_style_bg_color(card, hex(colour::surface), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(card, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(card, hex(colour::edge), LV_PART_MAIN);
	lv_obj_set_style_border_width(card, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(card, radius::lg, LV_PART_MAIN);
	lv_obj_set_style_pad_all(card, 0, LV_PART_MAIN);
	lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(card, LV_SCROLLBAR_MODE_OFF);
	return card;
}

void paintGround(lv_obj_t *screen)
{
	lv_obj_set_style_bg_color(screen, hex(colour::ground), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_pad_all(screen, 0, LV_PART_MAIN);
	lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
}

/* -------------------------------------------------------------------------------- the reading --- */

ReadingView buildReading(lv_obj_t *parent)
{
	ReadingView view;
	view.page = makePage(parent);
	view.card = makeSurface(view.page, CARD_INSET, CARD_INSET, CARD_W, CARD_H);

	view.title = makeLabel(view.card, type::title(), colour::ink, CARD_PAD, READING_TITLE_Y,
	                       CARD_INNER_W, LV_TEXT_ALIGN_LEFT);
	/* LVGL gives a fresh label the word "Text", which is harmless while this page is hidden behind a
	 * status and embarrassing for the one frame between `build()` and the first `update()`. */
	lv_label_set_text(view.title, "");

	/*
	 * Label and value are separate objects rather than one two-part string so that a value can carry
	 * a tone while its label does not — a P&L is green or pink, the word "P&L" never is.
	 */
	for (int slot = 0; slot < 4; slot++) {
		const SlotMetrics &metrics = SLOT[slot];
		if (metrics.stacked) {
			/*
			 * The lead's label is an eyebrow: small, dim, letter-spaced, sitting above the number it
			 * names. Same device as the status archetype's, and for the same reason — spacing is what
			 * stops a short word in a small face from reading as a second, quieter headline.
			 */
			view.slot_label[slot] = makeLabel(view.card, type::label(), colour::ink_dim, CARD_PAD,
			                                  metrics.label_y, CARD_INNER_W, LV_TEXT_ALIGN_LEFT);
			lv_obj_set_style_text_letter_space(view.slot_label[slot], 3, LV_PART_MAIN);
			view.slot_value[slot] = makeLabel(view.card, type::display(), colour::ink, CARD_PAD,
			                                  metrics.value_y, CARD_INNER_W, LV_TEXT_ALIGN_LEFT);
		} else {
			const lv_font_t *label_font = slot == 1 ? type::subhead() : type::label();
			const lv_font_t *value_font = slot == 1 ? type::shout() : type::subhead();
			const uint32_t label_colour = slot == 1 ? colour::ink_dim : colour::ink_faint;
			view.slot_label[slot] = makeLabel(view.card, label_font, label_colour, CARD_PAD,
			                                  metrics.label_y, READING_LABEL_W, LV_TEXT_ALIGN_LEFT);
			view.slot_value[slot] = makeLabel(view.card, value_font, colour::ink, READING_VALUE_X,
			                                  metrics.value_y, READING_VALUE_W, LV_TEXT_ALIGN_RIGHT);
		}
		lv_label_set_text(view.slot_label[slot], "");
		lv_label_set_text(view.slot_value[slot], "");
	}

	/*
	 * Two rules, one under the lead and one under the second voice.
	 *
	 * They are the cheapest way to say "these three weights are three different kinds of thing" to
	 * somebody who is reading the screen as shapes rather than words, which on an ambient display at
	 * three metres is most of the time. `colour::edge` and not `ink_faint`: a rule is a border, and
	 * the palette already has a role for that.
	 */
	for (int i = 0; i < 2; i++) {
		view.divider[i] = makeRule(view.card, CARD_PAD, SLOT_DIVIDER_Y[i], CARD_INNER_W);
	}

	makeRule(view.card, CARD_PAD, READING_RULE_Y, CARD_INNER_W);
	view.footer = makeLabel(view.card, type::caption(), colour::ink_faint, CARD_PAD,
	                        READING_FOOTER_Y, READING_FOOTER_W, LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.footer, "");
	return view;
}

void setReadingSlot(const ReadingView &view, int slot, const char *label, const char *value,
                    Tone tone)
{
	if (view.card == nullptr || slot < 0 || slot >= 4) return;
	lv_label_set_text(view.slot_label[slot], label == nullptr ? "" : label);

	int32_t drop = 0;
	const lv_font_t *font = valueFont(slot, value, drop);
	const SlotMetrics &metrics = SLOT[slot];
	lv_obj_set_pos(view.slot_value[slot], metrics.stacked ? CARD_PAD : READING_VALUE_X,
	               metrics.value_y + drop);
	lv_obj_set_style_text_font(view.slot_value[slot], font, LV_PART_MAIN);
	lv_obj_set_style_text_color(view.slot_value[slot], hex(toneColour(tone)), LV_PART_MAIN);
	lv_label_set_text(view.slot_value[slot], value == nullptr ? "" : value);
}

/* --------------------------------------------------------------------------------- the status --- */

StatusView buildStatus(lv_obj_t *parent, bool with_actions)
{
	StatusView view;
	view.page = makePage(parent);
	lv_obj_set_style_pad_hor(view.page, INSET, LV_PART_MAIN);
	lv_obj_set_style_pad_ver(view.page, INSET, LV_PART_MAIN);
	/*
	 * A flex column, centred on its main axis — the one solver in this firmware, and the reason it is
	 * here rather than in the reading is that a status has a *variable* number of things to say. The
	 * reading always has four rows; a status has between two and six lines depending on which state it
	 * is, and a fixed y per slot is exactly what left 250px of dead panel under "not set up".
	 *
	 * LVGL's flex skips hidden children, so `applyStatus` hiding an empty slot does not leave a gap
	 * where it would have been — the whole block simply recentres.
	 */
	lv_obj_set_flex_flow(view.page, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_flex_align(view.page, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
	                      LV_FLEX_ALIGN_CENTER);
	/*
	 * Zero row gap, because the gaps are margins on the children and two sources of spacing is one
	 * too many. The default theme puts a `pad_row` on every `lv_obj`, which is not zero — the first
	 * render of this screen had ten pixels more between each pair than the scale asked for, and the
	 * whole block sat twenty pixels above centre because the extra gaps made the content taller than
	 * the centring arithmetic thought it was. Read off the tree dump, not guessed.
	 */
	lv_obj_set_style_pad_row(view.page, 0, LV_PART_MAIN);

	/* Letter-spaced, because an eyebrow is a category and not a word — the spacing is what stops
	 * "TRENDING" at 18px reading as a small headline above the real one. */
	view.eyebrow = makeFlowLabel(view.page, type::label(), colour::ink_dim, SAFE_W, false);
	lv_obj_set_style_text_letter_space(view.eyebrow, 3, LV_PART_MAIN);
	lv_label_set_text(view.eyebrow, "");

	view.headline = makeFlowLabel(view.page, type::hero(), colour::ink, SAFE_W, false);
	lv_obj_set_style_margin_top(view.headline, space::sm, LV_PART_MAIN);
	lv_label_set_text(view.headline, "");

	/* The tone, said a second time in a way that survives being looked at from across a room, where a
	 * 40px word is a shape and its colour is the only part still resolving. */
	view.bar = makeRule(view.page, 0, 0, STATUS_BAR_W, colour::ink);
	lv_obj_set_height(view.bar, STATUS_BAR_H);
	lv_obj_set_style_radius(view.bar, STATUS_BAR_H / 2, LV_PART_MAIN);
	lv_obj_set_style_margin_top(view.bar, space::lg, LV_PART_MAIN);

	view.detail = makeFlowLabel(view.page, type::subhead(), colour::ink, STATUS_TEXT_W, true);
	lv_obj_set_style_margin_top(view.detail, space::lg, LV_PART_MAIN);
	lv_label_set_text(view.detail, "");

	view.support = makeFlowLabel(view.page, type::body(), colour::ink_dim, STATUS_TEXT_W, true);
	lv_obj_set_style_margin_top(view.support, space::md, LV_PART_MAIN);
	lv_label_set_text(view.support, "");

	if (with_actions) {
		view.actions = lv_obj_create(view.page);
		lv_obj_set_size(view.actions, SAFE_W, STATUS_ACTION_H);
		lv_obj_set_style_bg_opa(view.actions, LV_OPA_TRANSP, LV_PART_MAIN);
		lv_obj_set_style_border_width(view.actions, 0, LV_PART_MAIN);
		lv_obj_set_style_pad_all(view.actions, 0, LV_PART_MAIN);
		lv_obj_set_style_margin_top(view.actions, space::xl, LV_PART_MAIN);
		lv_obj_remove_flag(view.actions, LV_OBJ_FLAG_SCROLLABLE);
		lv_obj_remove_flag(view.actions, LV_OBJ_FLAG_CLICKABLE);
		lv_obj_set_flex_flow(view.actions, LV_FLEX_FLOW_ROW);
		lv_obj_set_flex_align(view.actions, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
		                      LV_FLEX_ALIGN_CENTER);
		lv_obj_set_style_pad_column(view.actions, space::md, LV_PART_MAIN);
	}

	view.note = makeFlowLabel(view.page, type::caption(), colour::ink_faint, SAFE_W, false);
	lv_obj_set_style_margin_top(view.note, space::lg, LV_PART_MAIN);
	lv_label_set_text(view.note, "");

	return view;
}

void applyStatus(const StatusView &view, const StatusCopy &copy)
{
	if (view.page == nullptr) return;
	const uint32_t tone = toneColour(copy.tone);

	lv_label_set_text(view.eyebrow, has(copy.eyebrow) ? copy.eyebrow : "");
	showIf(view.eyebrow, has(copy.eyebrow));

	lv_obj_set_style_text_font(view.headline, headlineFont(copy.headline), LV_PART_MAIN);
	lv_obj_set_style_text_color(view.headline, hex(tone), LV_PART_MAIN);
	lv_label_set_text(view.headline, has(copy.headline) ? copy.headline : "");
	showIf(view.headline, has(copy.headline));

	lv_obj_set_style_bg_color(view.bar, hex(tone), LV_PART_MAIN);
	showIf(view.bar, has(copy.headline));

	lv_label_set_text(view.detail, has(copy.detail) ? copy.detail : "");
	showIf(view.detail, has(copy.detail));

	lv_label_set_text(view.support, has(copy.support) ? copy.support : "");
	showIf(view.support, has(copy.support));

	lv_label_set_text(view.note, has(copy.note) ? copy.note : "");
	showIf(view.note, has(copy.note));
}

/* -------------------------------------------------------------------------------- the chooser --- */

ChooserView buildChooser(lv_obj_t *parent, const char *title, const char *action_0,
                         const char *action_1, const char *action_2)
{
	ChooserView view;
	view.page = makePage(parent);

	view.title = makeLabel(view.page, type::title(), colour::ink, INSET, CHOOSER_TITLE_Y, SAFE_W,
	                       LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.title, title);
	/*
	 * The subtitle is `ink` rather than `ink_dim`, and a size up from where it started.
	 *
	 * It was reported twice from the desk as looking "italicised" and "super slanted" while rendering
	 * perfectly in the simulator. The cause turned out to be odd-column addressing on the CO5300 and
	 * is fixed in `pulse.ino`, but the brightness went up on the way and stayed: at `ink_dim` on near
	 * black this was the faintest text on the panel, and a line of context nobody can read is a line
	 * that may as well not be drawn.
	 */
	view.subtitle = makeLabel(view.page, type::body(), colour::ink, INSET, CHOOSER_SUB_Y, SAFE_W,
	                          LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.subtitle, "");

	view.list = lv_list_create(view.page);
	lv_obj_set_pos(view.list, INSET, CHOOSER_LIST_Y);
	lv_obj_set_size(view.list, SAFE_W, CHOOSER_LIST_HEIGHT);
	lv_obj_set_style_bg_color(view.list, hex(colour::surface), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(view.list, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(view.list, hex(colour::edge), LV_PART_MAIN);
	lv_obj_set_style_border_width(view.list, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(view.list, radius::md, LV_PART_MAIN);
	lv_obj_set_style_pad_all(view.list, space::sm, LV_PART_MAIN);
	lv_obj_set_style_pad_row(view.list, space::sm, LV_PART_MAIN);
	/* The scrollbar is the only thing that tells somebody a seventh row exists. It is the fix for a
	 * list that silently held entries nobody could reach, so it is always on rather than fading. */
	lv_obj_set_scrollbar_mode(view.list, LV_SCROLLBAR_MODE_ON);
	/*
	 * Vertically only. The first render came back with a horizontal scrollbar across the bottom,
	 * because a row's content is a hair wider than the space left once the vertical bar has taken its
	 * six pixels — so the list was draggable sideways into nothing. Harmless to look at and not
	 * harmless to use: a finger dragging down a list that also slides left is a list that fights back.
	 * Seen in the PNG, not deduced.
	 */
	lv_obj_set_scroll_dir(view.list, LV_DIR_VER);
	lv_obj_set_style_bg_color(view.list, hex(colour::ink_dim), LV_PART_SCROLLBAR);
	lv_obj_set_style_bg_opa(view.list, LV_OPA_COVER, LV_PART_SCROLLBAR);
	lv_obj_set_style_width(view.list, 6, LV_PART_SCROLLBAR);
	lv_obj_set_style_radius(view.list, 3, LV_PART_SCROLLBAR);

	const char *const text[3] = {action_0, action_1, action_2};
	for (int i = 0; i < 3; i++) {
		if (!has(text[i])) continue;
		view.action[i] =
		    makeButton(view.page, INSET + i * (CHOOSER_ACTION_W + CHOOSER_ACTION_GAP),
		               CHOOSER_ACTION_Y, CHOOSER_ACTION_W, CHOOSER_ACTION_H, text[i], type::label());
	}
	return view;
}

void styleChooserRow(lv_obj_t *row)
{
	if (row == nullptr) return;
	lv_obj_set_style_bg_color(row, hex(colour::raised), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(row, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_text_color(row, hex(colour::ink), LV_PART_MAIN);
	lv_obj_set_style_text_font(row, type::body(), LV_PART_MAIN);
	lv_obj_set_style_border_width(row, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(row, radius::sm, LV_PART_MAIN);
	lv_obj_set_style_pad_hor(row, space::md, LV_PART_MAIN);
	lv_obj_set_style_pad_ver(row, space::md, LV_PART_MAIN);
	/* Clear of the scrollbar, which the list draws inside its own right edge. Without this a row's
	 * trailing metadata ends underneath it and reads as clipped even though the label fits. */
	lv_obj_set_style_pad_right(row, space::md + 6, LV_PART_MAIN);
	lv_obj_set_style_bg_color(row, hex(colour::accent), LV_PART_MAIN | LV_STATE_PRESSED);
	lv_obj_set_style_text_color(row, hex(colour::ground), LV_PART_MAIN | LV_STATE_PRESSED);
}

/* ---------------------------------------------------------------------------------- the input --- */

InputView buildInput(lv_obj_t *parent, const char *placeholder)
{
	InputView view;
	view.page = makePage(parent);

	view.title = makeLabel(view.page, type::title(), colour::ink, INSET, INPUT_TITLE_Y, SAFE_W,
	                       LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.title, "");
	view.subtitle = makeLabel(view.page, type::body(), colour::ink_dim, INSET, INPUT_SUB_Y, SAFE_W,
	                          LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.subtitle, "");

	view.field = lv_textarea_create(view.page);
	/* `set_one_line` before `set_size`: it sets the height to `LV_SIZE_CONTENT` itself, so called
	 * afterwards it undoes the height and leaves a short field beside a tall button — eight pixels of
	 * misalignment that is invisible in the source and obvious in a render. */
	lv_textarea_set_one_line(view.field, true);
	lv_obj_set_pos(view.field, INSET, INPUT_FIELD_Y);
	lv_obj_set_size(view.field, INPUT_FIELD_W, INPUT_FIELD_H);
	lv_textarea_set_placeholder_text(view.field, placeholder);
	/*
	 * A middle dot, asked for by name, because LVGL will not choose it on its own.
	 *
	 * `lv_textarea_get_password_bullet` asks the *font* whether it carries U+2022 and quietly returns
	 * "*" when it does not — so the masked field came out as a row of asterisks, which on this glass
	 * read as ragged and hard to count. Setting it explicitly is the whole fix, provided the face has
	 * the glyph; if it does not this renders as a placeholder box rather than falling back, which is
	 * why it was checked in the simulator rather than assumed.
	 */
	lv_textarea_set_password_bullet(view.field, "•");
	/*
	 * The character shows for a moment and then becomes a dot, and the moment is short.
	 *
	 * LVGL's default is 1500ms, reported on this panel as a glyph that looks wrong for most of a
	 * second before resolving. The point of showing it at all is to confirm the key that registered,
	 * which a glance answers; anything longer is a passphrase sitting in the clear on a screen
	 * somebody is holding in a room with other people in it. The eye button is the considered way to
	 * read the whole thing back.
	 */
	lv_textarea_set_password_show_time(view.field, 400);
	lv_obj_set_style_text_font(view.field, type::heading(), LV_PART_MAIN);
	lv_obj_set_style_text_color(view.field, hex(colour::ink), LV_PART_MAIN);
	lv_obj_set_style_bg_color(view.field, hex(colour::raised), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(view.field, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(view.field, hex(colour::edge), LV_PART_MAIN);
	lv_obj_set_style_border_width(view.field, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(view.field, radius::sm, LV_PART_MAIN);
	lv_obj_set_style_text_color(view.field, hex(colour::ink_faint), LV_PART_TEXTAREA_PLACEHOLDER);

	view.reveal = makeButton(view.page, INSET + INPUT_FIELD_W + space::sm, INPUT_FIELD_Y,
	                         INPUT_REVEAL_W, INPUT_FIELD_H, LV_SYMBOL_EYE_OPEN, type::heading(),
	                         &view.reveal_label);

	view.hint = makeLabel(view.page, type::label(), colour::ink_faint, INSET, INPUT_HINT_Y, SAFE_W,
	                      LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(view.hint, LV_SYMBOL_OK "  joins      " LV_SYMBOL_KEYBOARD "  goes back");

	view.keyboard = lv_keyboard_create(view.page);
	/*
	 * `lv_obj_set_align` before `lv_obj_set_pos`, and it is not decoration.
	 *
	 * `lv_keyboard`'s constructor aligns itself `LV_ALIGN_BOTTOM_MID` and defaults to 100% wide by 50%
	 * tall — so a plain `set_pos` is read as an *offset from the bottom centre*, and the first render
	 * put the keyboard at (8, 400) with most of it hanging off the panel. The simulator's tree dump
	 * said `<< PAST ITS PARENT'S BOTTOM EDGE` before any pixel was looked at, which is the whole
	 * reason that check is in it.
	 */
	lv_obj_set_align(view.keyboard, LV_ALIGN_TOP_LEFT);
	lv_obj_set_pos(view.keyboard, INPUT_KB_X, INPUT_KB_Y);
	lv_obj_set_size(view.keyboard, INPUT_KB_W, INPUT_KB_H);
	lv_keyboard_set_textarea(view.keyboard, view.field);
	lv_keyboard_set_popovers(view.keyboard, true);
	lv_obj_set_style_bg_color(view.keyboard, hex(colour::ground), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(view.keyboard, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_width(view.keyboard, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(view.keyboard, 2, LV_PART_MAIN);
	/* Three pixels between keys rather than the theme's default. The first render clipped the "ABC"
	 * and "1#" mode keys — they are the narrowest in the map and a 24px face does not fit three glyphs
	 * inside them once the theme's gap and a 1px border have taken their share. Widening the keys is
	 * the fix that keeps the face legible; shrinking the face would have cost every letter. */
	lv_obj_set_style_pad_gap(view.keyboard, 3, LV_PART_MAIN);
	lv_obj_set_style_bg_color(view.keyboard, hex(colour::raised), LV_PART_ITEMS);
	lv_obj_set_style_bg_opa(view.keyboard, LV_OPA_COVER, LV_PART_ITEMS);
	lv_obj_set_style_text_color(view.keyboard, hex(colour::ink), LV_PART_ITEMS);
	lv_obj_set_style_text_font(view.keyboard, type::heading(), LV_PART_ITEMS);
	lv_obj_set_style_border_color(view.keyboard, hex(colour::edge), LV_PART_ITEMS);
	lv_obj_set_style_border_width(view.keyboard, 1, LV_PART_ITEMS);
	lv_obj_set_style_radius(view.keyboard, radius::sm - 2, LV_PART_ITEMS);
	/*
	 * The control keys are `LV_STATE_CHECKED`, and styling only the default state leaves them wearing
	 * the *stock theme* — which is `LV_THEME_DEFAULT_DARK 0`, so the first render had nine white keys
	 * with black glyphs scattered through a dark keyboard. It looked like a rendering fault and was a
	 * missing selector. They are darker than the letters here on purpose: shift, backspace and the
	 * mode switch are not things somebody is aiming at while typing a passphrase.
	 */
	lv_obj_set_style_bg_color(view.keyboard, hex(colour::edge), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_text_color(view.keyboard, hex(colour::ink), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_border_color(view.keyboard, hex(colour::ink_dim),
	                              LV_PART_ITEMS | LV_STATE_CHECKED);
	/*
	 * And a size down on the control keys, which is the actual fix for a thing that had only been
	 * worked around.
	 *
	 * "ABC" and "1#" are three glyphs in a key the same width as one letter: ten columns across the
	 * panel is about 32px a key, and three characters of Montserrat 24 is 39. The note above the gap
	 * says widening the keys was the fix, and it was not — it bought two pixels and the "A" was still
	 * cut off in the render, before this change and after it. `label` is 18 and three of those is 30,
	 * which fits with room to spare. It is the right key to shrink for the reason its own styling
	 * already gives: nobody is aiming at the mode switch while typing a passphrase.
	 */
	lv_obj_set_style_text_font(view.keyboard, type::label(), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_bg_color(view.keyboard, hex(colour::accent), LV_PART_ITEMS | LV_STATE_PRESSED);
	lv_obj_set_style_text_color(view.keyboard, hex(colour::ground),
	                            LV_PART_ITEMS | LV_STATE_PRESSED);
	/*
	 * The key under the finger is drawn a size and a half up, which is what makes LVGL's popover a
	 * magnifier rather than a repeat: a press style applies to the popover too, so a larger face in
	 * this one state enlarges precisely the glyph a fingertip is covering and nothing else. `shout`
	 * against a `heading` base — bigger looked like a different widget appearing rather than the same
	 * key growing, and on the top row it started to reach the hint line above the keyboard.
	 */
	lv_obj_set_style_text_font(view.keyboard, type::shout(), LV_PART_ITEMS | LV_STATE_PRESSED);
	return view;
}

lv_obj_t *makeMagnifier()
{
	/*
	 * On `lv_layer_top()` rather than on a page, because it has to draw outside the keyboard and a
	 * child is clipped to its parent — which is the constraint that makes a bigger popover impossible
	 * inside the widget, and the reason this exists alongside one. LVGL's own popover redraws the
	 * pressed key extended upward by exactly one key height, about 60px here, which on a panel held at
	 * arm's length is barely a magnification and is still directly under the fingertip covering it.
	 */
	lv_obj_t *magnifier = lv_label_create(lv_layer_top());
	lv_obj_set_size(magnifier, MAG_W, MAG_H);
	lv_obj_set_style_bg_color(magnifier, hex(colour::accent), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(magnifier, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_text_color(magnifier, hex(colour::ground), LV_PART_MAIN);
	lv_obj_set_style_text_font(magnifier, type::display(), LV_PART_MAIN);
	lv_obj_set_style_text_align(magnifier, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
	lv_obj_set_style_radius(magnifier, radius::md + 2, LV_PART_MAIN);
	lv_obj_set_style_border_color(magnifier, hex(colour::ink), LV_PART_MAIN);
	lv_obj_set_style_border_width(magnifier, 2, LV_PART_MAIN);
	/* Vertically centred by padding rather than by alignment: the label owns a fixed box here and a
	 * 48px glyph in a 124px box otherwise sits against the top edge. */
	lv_obj_set_style_pad_top(magnifier, (MAG_H - 56) / 2, LV_PART_MAIN);
	lv_obj_add_flag(magnifier, LV_OBJ_FLAG_HIDDEN);
	lv_obj_remove_flag(magnifier, LV_OBJ_FLAG_CLICKABLE);
	return magnifier;
}

/* --------------------------------------------------------------------------------- the charge --- */

namespace {

/* The graphics inside the 132x36 chip. The shell is 34x18, which is the smallest a battery outline
 * can be drawn at and still read as one from across a room, and the rest of the chip is the touch
 * target and the number. */
constexpr int32_t BATTERY_SHELL_W = 34;
constexpr int32_t BATTERY_SHELL_H = 18;
constexpr int32_t BATTERY_SHELL_Y = (BATTERY_H - BATTERY_SHELL_H) / 2; /* 9 */
constexpr int32_t BATTERY_CAP_W = 3;
constexpr int32_t BATTERY_CAP_H = 8;
constexpr int32_t BATTERY_FILL_INSET = 3;
constexpr int32_t BATTERY_FILL_W = BATTERY_SHELL_W - 2 * BATTERY_FILL_INSET; /* 28 */
constexpr int32_t BATTERY_FILL_H = BATTERY_SHELL_H - 2 * BATTERY_FILL_INSET; /* 12 */
constexpr int32_t BATTERY_TEXT_X = BATTERY_SHELL_W + BATTERY_CAP_W + space::sm; /* 45 */
constexpr int32_t BATTERY_TEXT_W = BATTERY_W - BATTERY_TEXT_X;                  /* 87 */

/*
 * What colour the charge is, which is a meaning and not a level.
 *
 * Charging is `accent` — the palette's "something is happening" — and outranks the level, because a
 * unit at 8% on a cable is not a problem and must not wear the colour of one. Below that it is the
 * two thresholds anybody would expect, and above them it is `ink_dim`: the charge is metadata about
 * the reading, not the reading, and a green battery on every screen would be a permanent piece of
 * good news competing with the number the panel is actually for.
 */
Tone batteryTone(const BatteryCopy &copy)
{
	if (copy.charging) return Tone::Accent;
	if (copy.percent < 0) return Tone::Quiet;
	if (copy.percent <= 10) return Tone::Bad;
	if (copy.percent <= 25) return Tone::Warn;
	return Tone::Quiet;
}

}  // namespace

BatteryView buildBattery(lv_obj_t *parent, int32_t x, int32_t y)
{
	BatteryView view;
	view.chip = lv_obj_create(parent);
	lv_obj_set_pos(view.chip, x, y);
	lv_obj_set_size(view.chip, BATTERY_W, BATTERY_H);
	lv_obj_set_style_bg_opa(view.chip, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(view.chip, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(view.chip, radius::sm, LV_PART_MAIN);
	lv_obj_set_style_pad_all(view.chip, 0, LV_PART_MAIN);
	lv_obj_remove_flag(view.chip, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(view.chip, LV_SCROLLBAR_MODE_OFF);
	/*
	 * Clickable, unlike every other layer this file makes.
	 *
	 * `makePage` goes out of its way *not* to be a target, because the ambient screen's whole gesture
	 * is that the panel is the button. This is the deliberate exception: a chip that swallows the
	 * touches landing on it is exactly what keeps a hold on the battery from also being a hold
	 * anywhere on the glass, which is what `pulse_wifi` already uses to open setup. Two duration
	 * gestures on one surface would be a race; two duration gestures on two surfaces are two
	 * gestures.
	 */
	lv_obj_add_flag(view.chip, LV_OBJ_FLAG_CLICKABLE);
	/* A press has to be visible: it is the only feedback that a hold has started at all, and this one
	 * is on a target somebody is holding for over a second. */
	lv_obj_set_style_bg_color(view.chip, hex(colour::raised), LV_PART_MAIN | LV_STATE_PRESSED);
	lv_obj_set_style_bg_opa(view.chip, LV_OPA_COVER, LV_PART_MAIN | LV_STATE_PRESSED);

	view.shell = lv_obj_create(view.chip);
	lv_obj_set_pos(view.shell, 0, BATTERY_SHELL_Y);
	lv_obj_set_size(view.shell, BATTERY_SHELL_W, BATTERY_SHELL_H);
	lv_obj_set_style_bg_opa(view.shell, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_color(view.shell, hex(colour::ink_faint), LV_PART_MAIN);
	lv_obj_set_style_border_width(view.shell, 2, LV_PART_MAIN);
	lv_obj_set_style_radius(view.shell, 4, LV_PART_MAIN);
	lv_obj_set_style_pad_all(view.shell, 0, LV_PART_MAIN);
	lv_obj_remove_flag(view.shell, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_remove_flag(view.shell, LV_OBJ_FLAG_CLICKABLE);

	view.cap = makeRule(view.chip, BATTERY_SHELL_W, BATTERY_SHELL_Y + (BATTERY_SHELL_H - BATTERY_CAP_H) / 2,
	                    BATTERY_CAP_W, colour::ink_faint);
	lv_obj_set_height(view.cap, BATTERY_CAP_H);
	lv_obj_set_style_radius(view.cap, 1, LV_PART_MAIN);

	/* A child of the chip and not of the shell, because the shell's 2px border would otherwise eat
	 * two of the twelve pixels this has to show a level in. */
	view.fill = makeRule(view.chip, BATTERY_FILL_INSET, BATTERY_SHELL_Y + BATTERY_FILL_INSET,
	                     BATTERY_FILL_W, colour::ink_dim);
	lv_obj_set_height(view.fill, BATTERY_FILL_H);
	lv_obj_set_style_radius(view.fill, 2, LV_PART_MAIN);

	view.text = makeLabel(view.chip, type::caption(), colour::ink_faint, BATTERY_TEXT_X, 0,
	                      BATTERY_TEXT_W, LV_TEXT_ALIGN_RIGHT);
	lv_obj_set_style_pad_top(view.text, (BATTERY_H - 19) / 2, LV_PART_MAIN);
	lv_label_set_text(view.text, "");

	lv_obj_add_flag(view.chip, LV_OBJ_FLAG_HIDDEN);
	return view;
}

void applyBattery(const BatteryView &view, const BatteryCopy &copy)
{
	if (view.chip == nullptr) return;
	showIf(view.chip, copy.show);
	if (!copy.show) return;

	const uint32_t tone = toneColour(batteryTone(copy));
	lv_obj_set_style_bg_color(view.fill, hex(tone), LV_PART_MAIN);
	lv_obj_set_style_text_color(view.text, hex(tone), LV_PART_MAIN);

	/*
	 * The level, clamped, and never rounded up to a bar that is not there.
	 *
	 * A cell at 2% gets one pixel rather than none, because a battery outline with nothing in it and
	 * a battery outline with a sliver in it are different facts and the panel should be able to say
	 * both. Above that it is integer arithmetic on 28 pixels, which is a little over three percent a
	 * pixel and is as much resolution as this readout claims to have.
	 */
	int32_t fill = 0;
	if (copy.percent > 0) {
		fill = (BATTERY_FILL_W * (int32_t)copy.percent) / 100;
		if (fill < 1) fill = 1;
		if (fill > BATTERY_FILL_W) fill = BATTERY_FILL_W;
	}
	lv_obj_set_width(view.fill, fill);
	showIf(view.fill, fill > 0);

	/*
	 * What the chip says in words, in the order of how much the reader can rely on it.
	 *
	 * A percentage from the PMU's own gauge is the good case. A percentage this firmware derived from
	 * a voltage curve wears a `~`, because AGENTS.md's worst failure mode is a plausible number that
	 * is not the number it claims to be and an interpolated state of charge is exactly that if it is
	 * printed like a measurement. With no cell fitted there is no percentage to have and the chip
	 * says what is actually true — the unit is running off the cable.
	 */
	char text[16];
	if (copy.percent >= 0) {
		snprintf(text, sizeof(text), "%s%s%d%%", copy.charging ? "chg " : "",
		         copy.estimated ? "~" : "", (int)copy.percent);
	} else if (copy.millivolts != 0) {
		snprintf(text, sizeof(text), "%u.%02uV", (unsigned)(copy.millivolts / 1000u),
		         (unsigned)((copy.millivolts % 1000u) / 10u));
	} else if (copy.usb) {
		snprintf(text, sizeof(text), "USB");
	} else {
		snprintf(text, sizeof(text), "--");
	}
	lv_label_set_text(view.text, text);
}

}  // namespace pulse_design
