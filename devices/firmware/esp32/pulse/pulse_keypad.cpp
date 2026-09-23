#include "pulse_keypad.h"

#include "pulse_design.h"
#include "pulse_keypad_model.h"

namespace pulse_keypad {
namespace {

using namespace pulse_design;

Model model;
lv_obj_t *keys = nullptr;
lv_obj_t *field = nullptr;

/*
 * Push the model's current layout into the matrix.
 *
 * The whole control map is written every time. `lv_buttonmatrix_set_map` keeps the previous control
 * bits when the new map has the same number of keys, and the letter and digit pages both have
 * thirteen, so flags OR-ed in per key would carry one page's delete-key repeat onto the other page's
 * "0". Typing keys fire on release (`CLICK_TRIG`), which means sliding off a key cancels it and a
 * group's chooser never receives the release of the tap that opened it. Delete fires on press and
 * repeats while held, the one key where holding should mean "more".
 */
void apply()
{
	static lv_buttonmatrix_ctrl_t ctrl[MAX_KEYS];
	lv_buttonmatrix_set_map(keys, model.map());
	for (size_t i = 0; i < model.keyCount(); i++) {
		uint32_t bits = 1; /* width: one unit */
		if (!model.repeats(i)) {
			bits |= LV_BUTTONMATRIX_CTRL_NO_REPEAT | LV_BUTTONMATRIX_CTRL_CLICK_TRIG;
		}
		/* CHECKED is only a style selector here: control keys are drawn darker, and nothing on this
		 * keypad is checkable. */
		if (model.control(i)) bits |= LV_BUTTONMATRIX_CTRL_CHECKED;
		ctrl[i] = (lv_buttonmatrix_ctrl_t)bits;
	}
	lv_buttonmatrix_set_ctrl_map(keys, ctrl);
	/* A chooser's keys are single characters in rows of three to five, and there is room to draw them
	 * at the magnifier's size. The grid's labels are up to nine glyphs and stay one step smaller. */
	lv_obj_set_style_text_font(keys, model.choosing() ? type::display() : type::shout(),
	                           LV_PART_ITEMS);
}

void onValue(lv_event_t *event)
{
	(void)event;
	const uint32_t id = lv_buttonmatrix_get_selected_button(keys);
	if (id == LV_BUTTONMATRIX_BUTTON_NONE) return;
	const bool choosing = model.choosing();
	const Page page = model.page();
	const Action action = model.press(id);
	if (model.choosing() != choosing || model.page() != page) apply();
	switch (action.kind) {
		case ActionKind::Insert:
			lv_textarea_add_char(field, (uint32_t)(unsigned char)action.ch);
			break;
		case ActionKind::Delete:
			lv_textarea_delete_char(field);
			break;
		case ActionKind::Submit:
			lv_obj_send_event(keys, LV_EVENT_READY, nullptr);
			break;
		case ActionKind::None:
			break;
	}
}

}  // namespace

lv_obj_t *create(lv_obj_t *parent, lv_obj_t *textarea)
{
	if (keys != nullptr) return keys;
	field = textarea;
	keys = lv_buttonmatrix_create(parent);
	Labels labels;
	labels.backspace = LV_SYMBOL_BACKSPACE;
	labels.submit = LV_SYMBOL_OK;
	labels.back = LV_SYMBOL_LEFT " Back";
	model.setLabels(labels);

	lv_obj_set_style_bg_color(keys, hex(colour::ground), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(keys, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_width(keys, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(keys, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(keys, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_gap(keys, space::sm, LV_PART_MAIN);

	lv_obj_set_style_bg_color(keys, hex(colour::raised), LV_PART_ITEMS);
	lv_obj_set_style_bg_opa(keys, LV_OPA_COVER, LV_PART_ITEMS);
	lv_obj_set_style_text_color(keys, hex(colour::ink), LV_PART_ITEMS);
	lv_obj_set_style_border_color(keys, hex(colour::edge), LV_PART_ITEMS);
	lv_obj_set_style_border_width(keys, 1, LV_PART_ITEMS);
	lv_obj_set_style_radius(keys, radius::sm, LV_PART_ITEMS);
	/* The stock dark theme is off in `lv_conf.h`, so a state left unstyled draws white keys with
	 * black glyphs. Every state this keypad uses is named here. */
	lv_obj_set_style_bg_color(keys, hex(colour::edge), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_text_color(keys, hex(colour::ink), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_border_color(keys, hex(colour::ink_dim), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_bg_color(keys, hex(colour::accent), LV_PART_ITEMS | LV_STATE_PRESSED);
	lv_obj_set_style_text_color(keys, hex(colour::ground), LV_PART_ITEMS | LV_STATE_PRESSED);

	lv_obj_add_event_cb(keys, onValue, LV_EVENT_VALUE_CHANGED, nullptr);
	apply();
	return keys;
}

void reset(lv_obj_t *keypad, const char *submitLabel)
{
	if (keypad == nullptr || keypad != keys) return;
	Labels labels;
	labels.backspace = LV_SYMBOL_BACKSPACE;
	labels.submit = submitLabel != nullptr ? submitLabel : LV_SYMBOL_OK;
	labels.back = LV_SYMBOL_LEFT " Back";
	model.setLabels(labels);
	model.reset();
	apply();
}

void cancel(lv_obj_t *keypad)
{
	if (keypad != nullptr) lv_obj_send_event(keypad, LV_EVENT_CANCEL, nullptr);
}

}  // namespace pulse_keypad
