#include "pulse_settings.h"

#include <Preferences.h>
#include <stdio.h>
#include <string.h>

#include "pulse_design.h"
#include "pulse_wallets.h"
#include "pulse_wifi.h"

namespace pulse_settings {
namespace {

using namespace pulse_design;
using pulse_companion::Mood;
using pulse_face::Pose;
using pulse_face::Style;

constexpr const char *STORE = "anchor-ui";
constexpr const char *FACE_KEY = "face";

Action wifiAction = nullptr;
bool loaded = false;
bool chosen = false;
Style current = Style::Halo;

const char *storedName(Style style)
{
	switch (style) {
		case Style::Visor:
			return "visor";
		case Style::Pixel:
			return "pixel";
		case Style::Buddy:
			return "buddy";
		case Style::Halo:
		default:
			return "halo";
	}
}

void load()
{
	if (loaded) return;
	loaded = true;
	Preferences prefs;
	prefs.begin(STORE, true);
	const String saved = prefs.getString(FACE_KEY, "");
	prefs.end();
	chosen = saved.length() > 0;
	for (int i = 0; i < (int)Style::Count; i++) {
		if (saved == storedName((Style)i)) current = (Style)i;
	}
}

void save(Style style)
{
	Preferences prefs;
	prefs.begin(STORE, false);
	prefs.putString(FACE_KEY, storedName(style));
	prefs.end();
	current = style;
	chosen = true;
}

/* ------------------------------------------------------------------------------------ one row -- */

/* A setting: what it is on the left, what it is set to on the right, and the whole row a target. */
struct Row {
	lv_obj_t *button = nullptr;
	lv_obj_t *value = nullptr;
};

constexpr int32_t ROW_H = 68;
constexpr int32_t ROW_GAP = space::md;
constexpr int32_t ROWS_Y = 92;

Row makeRow(lv_obj_t *parent, int32_t y, const char *title, lv_event_cb_t onTap)
{
	Row row;
	row.button = lv_button_create(parent);
	lv_obj_set_pos(row.button, INSET, y);
	lv_obj_set_size(row.button, SAFE_W, ROW_H);
	lv_obj_set_style_bg_color(row.button, hex(colour::surface), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(row.button, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(row.button, hex(colour::edge), LV_PART_MAIN);
	lv_obj_set_style_border_width(row.button, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(row.button, radius::lg, LV_PART_MAIN);
	lv_obj_set_style_shadow_width(row.button, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_hor(row.button, space::lg, LV_PART_MAIN);
	lv_obj_set_style_bg_color(row.button, hex(colour::raised), LV_PART_MAIN | LV_STATE_PRESSED);

	lv_obj_t *name = lv_label_create(row.button);
	lv_label_set_text(name, title);
	lv_obj_set_style_text_font(name, type::body(), LV_PART_MAIN);
	lv_obj_set_style_text_color(name, hex(colour::ink), LV_PART_MAIN);
	lv_obj_align(name, LV_ALIGN_LEFT_MID, 0, 0);

	row.value = lv_label_create(row.button);
	lv_label_set_text(row.value, "");
	lv_obj_set_style_text_font(row.value, type::label(), LV_PART_MAIN);
	lv_obj_set_style_text_color(row.value, hex(colour::ink_dim), LV_PART_MAIN);
	lv_obj_align(row.value, LV_ALIGN_RIGHT_MID, 0, 0);

	lv_obj_add_event_cb(row.button, onTap, LV_EVENT_CLICKED, nullptr);
	return row;
}

/* ------------------------------------------------------------------------------------ Settings -- */

struct SettingsScreen {
	lv_obj_t *screen = nullptr;
	lv_obj_t *returnTo = nullptr;
	Row face;
	Row wallets;
	Row wifi;
} settings;

void refreshSettings()
{
	if (settings.screen == nullptr) return;
	char text[40];
	snprintf(text, sizeof(text), "%s  " LV_SYMBOL_RIGHT, pulse_face::name(face()));
	lv_label_set_text(settings.face.value, text);
	const char *state = pulse_wifi::connected()    ? "Connected"
	                    : pulse_wifi::configured() ? "Not connected"
	                                               : "Set up";
	snprintf(text, sizeof(text), "%s  " LV_SYMBOL_RIGHT, state);
	lv_label_set_text(settings.wifi.value, text);
	snprintf(text, sizeof(text), "%u  " LV_SYMBOL_RIGHT, (unsigned)pulse_wallets::count());
	lv_label_set_text(settings.wallets.value, text);
}

void onSettingsScreen(lv_event_t *)
{
	refreshSettings();
}

void closeSettings()
{
	if (settings.screen == nullptr) return;
	lv_obj_t *back = settings.returnTo;
	settings = SettingsScreen{};
	if (back != nullptr) lv_screen_load_anim(back, LV_SCR_LOAD_ANIM_NONE, 0, 0, true);
}

void onSettingsDone(lv_event_t *)
{
	closeSettings();
}

void onFaceRow(lv_event_t *)
{
	openFacePicker(false);
}

void onWalletsRow(lv_event_t *)
{
	pulse_wallets::open();
}

void onWifiRow(lv_event_t *)
{
	if (wifiAction != nullptr) wifiAction();
}

/* -------------------------------------------------------------------------------------- Picker -- */

/*
 * One face at a time, big, running through every mood on its own so the person choosing sees how
 * it looks on a bad day as well as a good one. The arrows step between faces; nothing is saved
 * until "Use this".
 */
constexpr Mood DEMO[] = {Mood::Content, Mood::Happy, Mood::Curious, Mood::Worried, Mood::Sleepy,
                         Mood::Lost};
constexpr uint32_t DEMO_MS = 1500;
constexpr int32_t PREVIEW_X = (PANEL_W - pulse_face::CANVAS_W) / 2;
constexpr int32_t PREVIEW_Y = 58;
constexpr int32_t NAME_Y = PREVIEW_Y + pulse_face::CANVAS_H + space::sm;
constexpr int32_t ARROW_W = 52;
constexpr int32_t ARROW_H = 76;
constexpr int32_t ARROW_Y = PREVIEW_Y + (pulse_face::CANVAS_H - ARROW_H) / 2;

struct PickerScreen {
	lv_obj_t *screen = nullptr;
	lv_obj_t *returnTo = nullptr;
	lv_obj_t *canvas = nullptr;
	lv_obj_t *name = nullptr;
	lv_obj_t *blurb = nullptr;
	lv_obj_t *count = nullptr;
	lv_timer_t *demo = nullptr;
	Style style = Style::Halo;
	Pose pose;
	size_t demoAt = 0;
} picker;

void repaintPicker()
{
	pulse_face::paint(picker.canvas, picker.style, picker.pose, colour::ground);
}

void showPickedFace()
{
	lv_label_set_text(picker.name, pulse_face::name(picker.style));
	lv_label_set_text(picker.blurb, pulse_face::blurb(picker.style));
	char text[16];
	snprintf(text, sizeof(text), "%d of %d", (int)picker.style + 1, (int)Style::Count);
	lv_label_set_text(picker.count, text);
	repaintPicker();
}

void onDemo(lv_timer_t *)
{
	picker.demoAt = (picker.demoAt + 1) % (sizeof(DEMO) / sizeof(DEMO[0]));
	picker.pose.mood = DEMO[picker.demoAt];
	repaintPicker();
}

void setPhase(void *, int32_t phase)
{
	picker.pose.phase = (uint8_t)phase;
	/* Only the moods that sweep or blink by phase need a frame for every step of it. */
	if (picker.pose.mood == Mood::Curious || picker.pose.mood == Mood::Lost || (phase & 15) == 0) {
		repaintPicker();
	}
}

void setLook(void *, int32_t look)
{
	picker.pose.look = (int8_t)look;
	if (picker.pose.mood == Mood::Curious) repaintPicker();
}

void step(int by)
{
	picker.style = pulse_face::next(picker.style, by);
	showPickedFace();
}

void onPrevious(lv_event_t *)
{
	step(-1);
}

void onNext(lv_event_t *)
{
	step(1);
}

void onGesture(lv_event_t *)
{
	const lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_active());
	if (dir == LV_DIR_LEFT) step(1);
	if (dir == LV_DIR_RIGHT) step(-1);
}

void closePicker()
{
	if (picker.screen == nullptr) return;
	lv_anim_delete(&picker, nullptr);
	if (picker.demo != nullptr) lv_timer_delete(picker.demo);
	lv_obj_t *back = picker.returnTo;
	picker = PickerScreen{};
	if (back != nullptr) lv_screen_load_anim(back, LV_SCR_LOAD_ANIM_NONE, 0, 0, true);
}

void onUse(lv_event_t *)
{
	save(picker.style);
	closePicker();
}

void onPickerBack(lv_event_t *)
{
	closePicker();
}

lv_obj_t *makeArrow(lv_obj_t *parent, int32_t x, const char *symbol, lv_event_cb_t onTap)
{
	lv_obj_t *arrow = makeButton(parent, x, ARROW_Y, ARROW_W, ARROW_H, symbol, type::title());
	lv_obj_set_style_bg_opa(arrow, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(arrow, 0, LV_PART_MAIN);
	lv_obj_add_event_cb(arrow, onTap, LV_EVENT_CLICKED, nullptr);
	return arrow;
}

}  // namespace

void begin(Action openWifi)
{
	wifiAction = openWifi;
	load();
}

Style face()
{
	load();
	return current;
}

bool faceChosen()
{
	load();
	return chosen;
}

void openSettings()
{
	if (settings.screen != nullptr) return;
	settings.returnTo = lv_screen_active();
	settings.screen = lv_obj_create(nullptr);
	paintGround(settings.screen);
	lv_obj_remove_flag(settings.screen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_add_event_cb(settings.screen, onSettingsScreen, LV_EVENT_SCREEN_LOAD_START, nullptr);

	lv_obj_t *title = makeLabel(settings.screen, type::title(), colour::ink, INSET, INSET + 4, SAFE_W,
	                            LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(title, "Settings");
	lv_obj_t *sub = makeLabel(settings.screen, type::label(), colour::ink_dim, INSET, INSET + 42,
	                          SAFE_W, LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(sub, "This unit only");

	settings.face = makeRow(settings.screen, ROWS_Y, "Face", onFaceRow);
	settings.wallets = makeRow(settings.screen, ROWS_Y + ROW_H + ROW_GAP, "Wallets", onWalletsRow);
	settings.wifi = makeRow(settings.screen, ROWS_Y + 2 * (ROW_H + ROW_GAP), "Wi-Fi", onWifiRow);

	lv_obj_t *done = makeButton(settings.screen, INSET, PANEL_H - INSET - STATUS_ACTION_H, SAFE_W,
	                            STATUS_ACTION_H, "Done", type::body());
	lv_obj_add_event_cb(done, onSettingsDone, LV_EVENT_CLICKED, nullptr);

	refreshSettings();
	lv_screen_load(settings.screen);
}

void openFacePicker(bool firstRun)
{
	if (picker.screen != nullptr) return;
	picker.returnTo = lv_screen_active();
	picker.style = face();
	picker.screen = lv_obj_create(nullptr);
	paintGround(picker.screen);
	lv_obj_remove_flag(picker.screen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_add_event_cb(picker.screen, onGesture, LV_EVENT_GESTURE, nullptr);

	lv_obj_t *title = makeLabel(picker.screen, type::title(), colour::ink, INSET, INSET, SAFE_W - 72,
	                            LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(title, firstRun ? "Pick a face" : "Face");
	picker.count = makeLabel(picker.screen, type::label(), colour::ink_dim, PANEL_W - INSET - 72,
	                         INSET + 8, 72, LV_TEXT_ALIGN_RIGHT);

	picker.canvas = pulse_face::makeCanvas(picker.screen);
	if (picker.canvas != nullptr) {
		lv_obj_set_pos(picker.canvas, PREVIEW_X, PREVIEW_Y);
		lv_obj_remove_flag(picker.canvas, LV_OBJ_FLAG_CLICKABLE);
	}
	makeArrow(picker.screen, INSET - 8, LV_SYMBOL_LEFT, onPrevious);
	makeArrow(picker.screen, PANEL_W - INSET - ARROW_W + 8, LV_SYMBOL_RIGHT, onNext);

	picker.name = makeLabel(picker.screen, type::title(), colour::ink, INSET, NAME_Y, SAFE_W,
	                        LV_TEXT_ALIGN_CENTER);
	picker.blurb = makeLabel(picker.screen, type::label(), colour::ink_dim, INSET, NAME_Y + 38, SAFE_W,
	                         LV_TEXT_ALIGN_CENTER);

	const int32_t buttonsY = PANEL_H - INSET - STATUS_ACTION_H;
	lv_obj_t *back = makeButton(picker.screen, INSET, buttonsY, STATUS_ACTION_PAIR_W, STATUS_ACTION_H,
	                            firstRun ? "Later" : "Back", type::body());
	lv_obj_add_event_cb(back, onPickerBack, LV_EVENT_CLICKED, nullptr);
	lv_obj_t *use = makeButton(picker.screen, PANEL_W - INSET - STATUS_ACTION_PAIR_W, buttonsY,
	                           STATUS_ACTION_PAIR_W, STATUS_ACTION_H, "Use this", type::body());
	lv_obj_set_style_bg_color(use, hex(colour::accent), LV_PART_MAIN);
	lv_obj_set_style_border_width(use, 0, LV_PART_MAIN);
	lv_obj_t *useLabel = lv_obj_get_child(use, 0);
	if (useLabel != nullptr) lv_obj_set_style_text_color(useLabel, hex(colour::ground), LV_PART_MAIN);
	lv_obj_add_event_cb(use, onUse, LV_EVENT_CLICKED, nullptr);

	picker.pose = Pose{};
	picker.demoAt = 0;
	picker.demo = lv_timer_create(onDemo, DEMO_MS, nullptr);

	lv_anim_t phase;
	lv_anim_init(&phase);
	lv_anim_set_var(&phase, &picker);
	lv_anim_set_exec_cb(&phase, setPhase);
	lv_anim_set_values(&phase, 0, 255);
	lv_anim_set_duration(&phase, 2400);
	lv_anim_set_repeat_count(&phase, LV_ANIM_REPEAT_INFINITE);
	lv_anim_start(&phase);

	lv_anim_t look;
	lv_anim_init(&look);
	lv_anim_set_var(&look, &picker);
	lv_anim_set_exec_cb(&look, setLook);
	lv_anim_set_values(&look, -10, 10);
	lv_anim_set_duration(&look, 1100);
	lv_anim_set_playback_duration(&look, 1100);
	lv_anim_set_repeat_count(&look, LV_ANIM_REPEAT_INFINITE);
	lv_anim_set_path_cb(&look, lv_anim_path_ease_in_out);
	lv_anim_start(&look);

	showPickedFace();
	lv_screen_load(picker.screen);
}

}  // namespace pulse_settings
