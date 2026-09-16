#include "pulse_ui.h"

namespace pulse_ui {

namespace {

using namespace pulse_design;

/*
 * The two archetypes, both built once and one shown at a time.
 *
 * Built once rather than torn down and rebuilt on every kind change, because a device that spends a
 * minute joining a network crosses this boundary several times — no credentials, joining, fetching,
 * a reading, stale — and rebuilding an LVGL tree per transition is allocation churn on a 64 kB pool
 * for a screen that is going to change back. `lv_mem_monitor` in the boot banner is the check on
 * that claim; the whole of this screen was 8,816 bytes with one archetype in it.
 */
lv_obj_t *frame = nullptr;
ReadingView reading_view;
StatusView status_view;
Screen::Kind showing = Screen::Kind::Status;

void show(Screen::Kind kind)
{
	if (reading_view.page == nullptr) return;
	showing = kind;
	const bool is_reading = kind == Screen::Kind::Reading;
	if (is_reading) {
		lv_obj_remove_flag(reading_view.page, LV_OBJ_FLAG_HIDDEN);
		lv_obj_add_flag(status_view.page, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_add_flag(reading_view.page, LV_OBJ_FLAG_HIDDEN);
		lv_obj_remove_flag(status_view.page, LV_OBJ_FLAG_HIDDEN);
	}
}

void applyReading(const Reading &reading)
{
	lv_label_set_text(reading_view.title, reading.title);
	/* Only the second row carries a tone; the other three are numbers with no direction. The labels
	 * are re-applied on every pass on purpose — a screen showing a token must never end up wearing a
	 * portfolio's, which is a number claiming to be a different number. */
	const char *const values[4] = {reading.total, reading.pnl, reading.nfts, reading.window};
	for (int i = 0; i < 4; i++) {
		const Tone tone = i == 1 ? toneForSign(reading.pnl_tone) : Tone::Ink;
		setReadingRow(reading_view, i, reading.labels[i], values[i], tone);
	}
	lv_label_set_text(reading_view.footer, reading.age == nullptr ? "" : reading.age);
}

StatusCopy copyOf(const Status &status)
{
	StatusCopy copy;
	copy.eyebrow = status.eyebrow;
	copy.headline = status.headline;
	copy.tone = status.tone;
	copy.detail = status.detail;
	copy.support = status.support;
	copy.note = status.note;
	return copy;
}

}  // namespace

void build(const Screen &screen)
{
	lv_obj_t *active = lv_screen_active();
	paintGround(active);

	/*
	 * One frame under both archetypes, and it is the touch target.
	 *
	 * The pages themselves are transparent and not clickable (see `makePage`), so a touch anywhere on
	 * the glass lands here whichever kind of screen is up. That is what makes "tap anywhere to set up
	 * wi-fi" true rather than aspirational — it used to be the reading's card, which is inset from the
	 * panel, so the outer ring of glass was dead on the one screen whose entire job is to be pressed.
	 */
	frame = lv_obj_create(active);
	lv_obj_set_pos(frame, 0, 0);
	lv_obj_set_size(frame, PANEL_W, PANEL_H);
	lv_obj_set_style_bg_opa(frame, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(frame, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(frame, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(frame, 0, LV_PART_MAIN);
	lv_obj_remove_flag(frame, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(frame, LV_SCROLLBAR_MODE_OFF);

	reading_view = buildReading(frame);
	status_view = buildStatus(frame, false);

	update(screen);
}

void update(const Screen &screen)
{
	if (frame == nullptr) return;
	if (screen.kind == Screen::Kind::Reading) {
		applyReading(screen.reading);
	} else {
		applyStatus(status_view, copyOf(screen.status));
	}
	show(screen.kind);
}

void setFooter(const char *text)
{
	if (frame == nullptr || text == nullptr) return;
	if (showing == Screen::Kind::Reading) {
		lv_label_set_text(reading_view.footer, text);
		return;
	}
	/*
	 * On a status the bottom line is the note, and it is hidden when empty so the composition stays
	 * centred. Writing to it has to unhide it, or the calibration readout — a touch coordinate, for
	 * four seconds, which is the only way anybody can find out whether the CST820 ever answers — would
	 * land in an object nobody can see.
	 */
	lv_label_set_text(status_view.note, text);
	if (text[0] == '\0') {
		lv_obj_add_flag(status_view.note, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_remove_flag(status_view.note, LV_OBJ_FLAG_HIDDEN);
	}
}

lv_obj_t *surface()
{
	return frame;
}

}  // namespace pulse_ui
