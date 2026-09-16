#include "pulse_ui.h"

namespace pulse_ui {

namespace {

/* ------------------------------------------------------------------------------ the palette ---- */

/*
 * Tokyo Night, sampled from the design target rather than remembered.
 *
 * `magick review/devices/pulse-amoled.png -crop 368x448+20+20 -colors 12 -format %c histogram:` is
 * where these came from — the +20 offset drops the bezel the review renderer draws around the panel,
 * so what is left is the 368x448 the glass actually shows. Reading them out of the picture rather
 * than off a palette page matters because the picture is the thing this screen has to match, and a
 * hex value typed from memory is how two renderers start to drift.
 */
constexpr uint32_t GROUND = 0x13141C; /* behind everything; on an AMOLED this is nearly free */
constexpr uint32_t CARD = 0x1A1B26;   /* the surface the reading sits on */
constexpr uint32_t EDGE = 0x292E42;   /* card border and the footer rule */
constexpr uint32_t TEXT = 0xC0CAF5;   /* titles and values: the theme's foreground */
constexpr uint32_t MUTED = 0x586089;  /* row labels — the quiet half of each pair */
constexpr uint32_t FAINT = 0x4E556D;  /* the footer, which is metadata about the reading */
constexpr uint32_t GAIN = 0x9ECE6A;
constexpr uint32_t LOSS = 0xF7768E;

/* ------------------------------------------------------------------------------- the metrics --- */

/*
 * The panel is 368x448 and these are laid out against it directly rather than through a flex or
 * grid container.
 *
 * Four rows and a footer is not a layout problem; it is five y-coordinates. A flex container would
 * add a solver, a set of gap/pad styles to reason about and one more thing between a number on the
 * glass and a number in this file — and the failure being guarded against is a value running into
 * a label, which is checked by looking at the render, not by trusting a solver.
 *
 * The arithmetic that is not arbitrary: the card is inset 10 px so the rounded corners of the panel
 * itself never clip content (`app/wifi_setup.cpp` learned that the hard way on this glass), the
 * rows are 78 px apart because four of them plus the title block and the footer is exactly the 448
 * available, and the value column is right-aligned to a single edge so that four numbers of
 * different widths still form a column.
 *
 * The footer numbers were moved once, after looking at the render. The first pass left 6 px between
 * the last row and the rule and 32 px of dead space under the footer text, which reads as a screen
 * that has slumped upward — obvious in a PNG and invisible in the arithmetic, which is the whole
 * reason `sim/lvgl.sh` exists.
 */
constexpr int32_t PANEL_W = 368;
constexpr int32_t PANEL_H = 448;
constexpr int32_t CARD_INSET = 10;
constexpr int32_t PAD_X = 22; /* inside the card */
constexpr int32_t TITLE_Y = 22;
constexpr int32_t ROW_0_Y = 86;
constexpr int32_t ROW_STEP = 78;
constexpr int32_t FOOTER_RULE_Y = 380;
constexpr int32_t FOOTER_TEXT_Y = 396;

constexpr int ROW_COUNT = 4;

lv_obj_t *card = nullptr;
lv_obj_t *title_label = nullptr;
lv_obj_t *row_label[ROW_COUNT] = {nullptr, nullptr, nullptr, nullptr};
lv_obj_t *row_value[ROW_COUNT] = {nullptr, nullptr, nullptr, nullptr};
lv_obj_t *age_label = nullptr;

lv_color_t hex(uint32_t rgb)
{
	return lv_color_hex(rgb);
}

/*
 * A label that does not move when its text does.
 *
 * `lv_label` sizes itself to its content by default, so a right-aligned value would re-anchor every
 * time the number got a digit longer — which on a screen showing money is a column that jitters.
 * Pinning the width and letting the text align inside it is what keeps `$3,299` and `$48,214` on the
 * same right edge.
 */
lv_obj_t *makeLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t colour, int32_t x, int32_t y,
                    int32_t width, lv_text_align_t align)
{
	lv_obj_t *label = lv_label_create(parent);
	lv_obj_set_pos(label, x, y);
	lv_obj_set_width(label, width);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(colour), LV_PART_MAIN);
	lv_obj_set_style_text_align(label, align, LV_PART_MAIN);
	lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
	return label;
}

void applyTone(lv_obj_t *label, int tone)
{
	lv_obj_set_style_text_color(label, hex(tone > 0 ? GAIN : (tone < 0 ? LOSS : TEXT)),
	                            LV_PART_MAIN);
}

}  // namespace

void build(const Reading &reading)
{
	lv_obj_t *screen = lv_screen_active();
	lv_obj_set_style_bg_color(screen, hex(GROUND), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_style_pad_all(screen, 0, LV_PART_MAIN);

	card = lv_obj_create(screen);
	lv_obj_set_pos(card, CARD_INSET, CARD_INSET);
	lv_obj_set_size(card, PANEL_W - 2 * CARD_INSET, PANEL_H - 2 * CARD_INSET);
	lv_obj_set_style_bg_color(card, hex(CARD), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(card, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(card, hex(EDGE), LV_PART_MAIN);
	lv_obj_set_style_border_width(card, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(card, 18, LV_PART_MAIN);
	lv_obj_set_style_pad_all(card, 0, LV_PART_MAIN);
	/*
	 * No scrolling and no scrollbar. An `lv_obj` is a scroll container by default, so a child one
	 * pixel past the edge silently turns this into a thing that can be dragged — on a panel with a
	 * finger on it, that is a readout that slides away when somebody brushes it.
	 */
	lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(card, LV_SCROLLBAR_MODE_OFF);

	const int32_t inner_w = (PANEL_W - 2 * CARD_INSET) - 2 * PAD_X;

	title_label = makeLabel(card, &lv_font_montserrat_28, TEXT, PAD_X, TITLE_Y, inner_w,
	                        LV_TEXT_ALIGN_LEFT);

	/*
	 * Label and value share a row's y but not its width: the label takes the left third and the
	 * value the right two thirds. That split is decided by the longest thing each column has to
	 * hold, not by taste — "Window" at 22 px is about 72 px wide, comfortably inside a third, while
	 * the value is the number that grows: `$3,299` is 154 px at 40 px, and a portfolio that reaches
	 * `$148,214` is 203. A value clipped at the left edge of its own box is a balance missing its
	 * leading digit, which is the worst possible way for this screen to fail.
	 *
	 * They are separate objects rather than one two-part string so that the P&L value can carry a
	 * tone while its label does not.
	 */
	const int32_t label_w = inner_w / 3;
	const int32_t value_w = inner_w - label_w;
	for (int i = 0; i < ROW_COUNT; i++) {
		const int32_t y = ROW_0_Y + i * ROW_STEP;
		/* The label sits on the value's baseline rather than its top edge: a 22 px face and a 40 px
		 * face aligned at the top look like the smaller one floated. 14 px is the difference in cap
		 * height, near enough. */
		row_label[i] = makeLabel(card, &lv_font_montserrat_22, MUTED, PAD_X, y + 14, label_w,
		                         LV_TEXT_ALIGN_LEFT);
		row_value[i] = makeLabel(card, &lv_font_montserrat_40, TEXT, PAD_X + label_w, y, value_w,
		                         LV_TEXT_ALIGN_RIGHT);
	}

	/* Set from the reading rather than written here, so a screen showing a token cannot end up with
	 * a portfolio's labels over it. `update()` re-applies them on every pass for the same reason. */
	for (int i = 0; i < 4; i++) lv_label_set_text(row_label[i], reading.labels[i]);

	/* The rule, as a one-pixel object rather than `lv_line` — which is a widget this build does not
	 * enable, for a mark that is a filled rectangle. */
	lv_obj_t *rule = lv_obj_create(card);
	lv_obj_set_pos(rule, PAD_X, FOOTER_RULE_Y);
	lv_obj_set_size(rule, inner_w, 1);
	lv_obj_set_style_bg_color(rule, hex(EDGE), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_width(rule, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(rule, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(rule, 0, LV_PART_MAIN);
	lv_obj_remove_flag(rule, LV_OBJ_FLAG_SCROLLABLE);

	age_label = makeLabel(card, &lv_font_montserrat_16, FAINT, PAD_X, FOOTER_TEXT_Y, inner_w,
	                      LV_TEXT_ALIGN_CENTER);

	update(reading);
}

void update(const Reading &reading)
{
	if (title_label == nullptr) return;
	lv_label_set_text(title_label, reading.title);
	for (int i = 0; i < 4; i++) lv_label_set_text(row_label[i], reading.labels[i]);
	lv_label_set_text(row_value[0], reading.total);
	lv_label_set_text(row_value[1], reading.pnl);
	lv_label_set_text(row_value[2], reading.nfts);
	lv_label_set_text(row_value[3], reading.window);
	applyTone(row_value[1], reading.pnl_tone);
	setAge(reading.age);
}

void setAge(const char *age)
{
	if (age_label == nullptr || age == nullptr) return;
	lv_label_set_text(age_label, age);
}

lv_obj_t *surface()
{
	return card;
}

}  // namespace pulse_ui
