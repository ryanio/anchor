#include "pulse_companion.h"

#include <stdio.h>
#include <string.h>

#include "pulse_design.h"
#include "pulse_face.h"
#include "pulse_settings.h"
#include "pulse_ui.h"

namespace pulse_companion {
namespace {

using namespace pulse_design;
using pulse_face::Pose;

/* ------------------------------------------------------------------------------------ geometry -- */

/*
 * The face fills the top two thirds of the panel and the words sit under it. On an AMOLED the black
 * around a face costs nothing, and the face is the one soft thing on the screen, which is most of
 * why a character reads well here. What the face looks like is `pulse_face`'s business; this file
 * decides what it feels and when it moves.
 */
constexpr int32_t FACE_X = (PANEL_W - pulse_face::CANVAS_W) / 2; /* 64 */
constexpr int32_t FACE_Y = 70;
constexpr int32_t BREATHE = 5; /* px the face rises and falls */
constexpr int32_t BOUNCE = 22; /* px a tap lifts it */
constexpr int32_t LOOK = 10;   /* px the eyes travel when looking around */

constexpr int32_t HEAD_Y = 306;
constexpr int32_t SUB_Y = 342;

constexpr int32_t CORNER_BUTTON_Y = 24;
constexpr int32_t CORNER_BUTTON_H = 44;
constexpr int32_t EXPLORE_W = 108;
constexpr int32_t SETTINGS_W = 52;

/* --------------------------------------------------------------------------------------- state -- */

lv_obj_t *screen = nullptr;
lv_obj_t *previous = nullptr;
lv_obj_t *stage = nullptr; /* everything that is built and deleted with the screen's visits */
lv_obj_t *face = nullptr;
lv_obj_t *thought = nullptr; /* "z" while asleep, "?" while lost */
lv_obj_t *head = nullptr;
lv_obj_t *sub = nullptr;
lv_timer_t *blinker = nullptr;
lv_timer_t *hopper = nullptr;
lv_timer_t *delight = nullptr;

Action exploreAction = nullptr;
Action wifiAction = nullptr;

pulse_face::Style style = pulse_face::Style::Halo;
Pose pose;
Mood drawn = Mood::Content;
bool drawnOnce = false;
size_t lineIndex = 0;
int32_t breatheY = 0;
int32_t bounceY = 0;
bool populated = false; /* whether the screen's children exist; see `depopulate` */

/* Copies of what `update` was handed. The feed's strings live only for the call, and a tap needs to
 * word the next line after the call has returned. */
struct Stored {
	char total[24];
	char change[16];
	char topSymbol[12];
	char topPrice[16];
	char topChange[10];
	char age[24];
	Inputs inputs;
} stored;

template <size_t N>
const char *keep(char (&into)[N], const char *text)
{
	snprintf(into, N, "%s", text == nullptr ? "" : text);
	return into;
}

bool showing()
{
	return populated && lv_screen_active() == screen;
}

/* ------------------------------------------------------------------------------------- drawing -- */

void repaint()
{
	if (populated) pulse_face::paint(face, style, pose, colour::ground);
}

void place()
{
	if (face != nullptr) lv_obj_set_y(face, FACE_Y + breatheY + bounceY);
}

/* Every mood that the eyes can close in blinks; a blink runs the pose's `blink` up and back. */
bool blinks(Mood mood)
{
	return mood == Mood::Content || mood == Mood::Curious || mood == Mood::Worried;
}

void setBlink(void *, int32_t value)
{
	pose.blink = (uint8_t)value;
	repaint();
}

void setLook(void *, int32_t value)
{
	pose.look = (int8_t)value;
	repaint();
}

/*
 * A slow cycle every face may use: Halo's glow breathes on it, Visor sweeps its glass and blinks a
 * lost LED. Most moods need only a few frames of it a second, so it repaints on every sixteenth step
 * unless the mood is one that sweeps.
 */
void setPhase(void *, int32_t value)
{
	pose.phase = (uint8_t)value;
	if (pose.mood == Mood::Curious || pose.mood == Mood::Lost || (value & 15) == 0) repaint();
}

void setBreathe(void *, int32_t value)
{
	breatheY = value;
	place();
}

void setBounce(void *, int32_t value)
{
	bounceY = value;
	place();
}

void blink(lv_timer_t *)
{
	if (!showing() || !blinks(pose.mood)) return;
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_var(&anim, &pose);
	lv_anim_set_exec_cb(&anim, setBlink);
	lv_anim_set_values(&anim, 0, 255);
	lv_anim_set_duration(&anim, 90);
	lv_anim_set_playback_duration(&anim, 110);
	lv_anim_start(&anim);
}

void lookAround(bool on)
{
	lv_anim_delete(&pose, setLook);
	pose.look = 0;
	if (!on) return;
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_var(&anim, &pose);
	lv_anim_set_exec_cb(&anim, setLook);
	lv_anim_set_values(&anim, -LOOK, LOOK);
	lv_anim_set_duration(&anim, 1100);
	lv_anim_set_playback_duration(&anim, 1100);
	lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
	lv_anim_set_path_cb(&anim, lv_anim_path_ease_in_out);
	lv_anim_start(&anim);
}

/* ----------------------------------------------------------------------------------- the moods -- */

/* A glyph drifting up and fading from the top right of the face: "z" asleep, "?" lost. */
void thinking(const char *glyph)
{
	lv_anim_delete(thought, nullptr);
	if (glyph == nullptr) {
		lv_obj_add_flag(thought, LV_OBJ_FLAG_HIDDEN);
		return;
	}
	lv_label_set_text(thought, glyph);
	lv_obj_remove_flag(thought, LV_OBJ_FLAG_HIDDEN);
	lv_anim_t rise;
	lv_anim_init(&rise);
	lv_anim_set_var(&rise, thought);
	lv_anim_set_exec_cb(&rise, [](void *obj, int32_t y) { lv_obj_set_y((lv_obj_t *)obj, y); });
	lv_anim_set_values(&rise, FACE_Y + 20, FACE_Y - 20);
	lv_anim_set_duration(&rise, 2200);
	lv_anim_set_repeat_count(&rise, LV_ANIM_REPEAT_INFINITE);
	lv_anim_start(&rise);
	lv_anim_t fade;
	lv_anim_init(&fade);
	lv_anim_set_var(&fade, thought);
	lv_anim_set_exec_cb(&fade, [](void *obj, int32_t opa) {
		lv_obj_set_style_text_opa((lv_obj_t *)obj, (lv_opa_t)opa, LV_PART_MAIN);
	});
	lv_anim_set_values(&fade, LV_OPA_COVER, LV_OPA_TRANSP);
	lv_anim_set_duration(&fade, 2200);
	lv_anim_set_repeat_count(&fade, LV_ANIM_REPEAT_INFINITE);
	lv_anim_start(&fade);
}

void express(Mood mood)
{
	pose.mood = mood;
	pose.blink = 0;
	lookAround(mood == Mood::Curious || mood == Mood::Lost);
	thinking(mood == Mood::Sleepy ? "z" : mood == Mood::Lost ? "?" : nullptr);
	repaint();
	drawn = mood;
	drawnOnce = true;
}

/* ------------------------------------------------------------------------------------ the words -- */

void say()
{
	char text[112];
	line(stored.inputs, lineIndex, text, sizeof(text));
	char *split = strchr(text, '\n');
	const char *second = "";
	if (split != nullptr) {
		*split = '\0';
		second = split + 1;
	}
	lv_label_set_text(head, text);
	lv_label_set_text(sub, second);
}

/* -------------------------------------------------------------------------------------- touches -- */

/* A tap is a small delight: the happy face for a moment, then back to whatever the readings say. */
void endDelight(lv_timer_t *)
{
	delight = nullptr;
	if (populated) express(moodFor(stored.inputs));
}

void hop(int32_t height)
{
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_var(&anim, &bounceY);
	lv_anim_set_exec_cb(&anim, setBounce);
	lv_anim_set_values(&anim, 0, -height);
	lv_anim_set_duration(&anim, 140);
	lv_anim_set_playback_duration(&anim, 260);
	lv_anim_set_path_cb(&anim, lv_anim_path_ease_out);
	lv_anim_start(&anim);
}

void onTap(lv_event_t *)
{
	if (!stored.inputs.wifiConfigured && wifiAction != nullptr) {
		wifiAction();
		return;
	}
	lineIndex++;
	say();
	express(Mood::Happy);
	drawnOnce = false; /* so the next update restores the real mood even if it matches */
	if (delight != nullptr) lv_timer_delete(delight);
	delight = lv_timer_create(endDelight, 900, nullptr);
	lv_timer_set_repeat_count(delight, 1);
	hop(BOUNCE);
}

/* A happy companion hops now and then without being asked. */
void onHop(lv_timer_t *)
{
	if (showing() && drawn == Mood::Happy && delight == nullptr) hop(BOUNCE / 2);
}

void onExplore(lv_event_t *)
{
	if (exploreAction != nullptr) exploreAction();
}

void onSettings(lv_event_t *)
{
	pulse_settings::openSettings();
}

}  // namespace

/* ---------------------------------------------------------------------------------------- build -- */

void begin(Action openExplore, Action openWifi)
{
	exploreAction = openExplore;
	wifiAction = openWifi;
}

namespace {

/*
 * The companion's objects exist only while its screen is showing.
 *
 * They and their animations take LVGL pool, and the pool's tightest moment is a 32-network Wi-Fi
 * scan. Built at boot, the companion made that scan run out of pool, and LVGL wrote through a null
 * pointer. Built once and kept, it did the same whenever Wi-Fi was opened from it. So its children
 * are created when the screen starts loading and deleted when another screen replaces it. The screen
 * object itself stays, so Explore and Wi-Fi can still return to it. The face's pixels are in PSRAM
 * and go with the canvas.
 */
void depopulate()
{
	if (!populated) return;
	lv_anim_delete(&pose, nullptr);
	lv_anim_delete(&bounceY, nullptr);
	lv_anim_delete(&breatheY, nullptr);
	if (delight != nullptr) {
		lv_timer_delete(delight);
		delight = nullptr;
	}
	lv_obj_clean(stage);
	face = thought = head = sub = nullptr;
	populated = false;
}

void populate();

void onScreen(lv_event_t *event)
{
	if (lv_event_get_code(event) == LV_EVENT_SCREEN_LOAD_START) {
		populate();
	} else if (lv_event_get_code(event) == LV_EVENT_SCREEN_UNLOADED) {
		depopulate();
	}
}

void build()
{
	if (screen != nullptr) return;
	screen = lv_obj_create(nullptr);
	paintGround(screen);
	lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_add_event_cb(screen, onScreen, LV_EVENT_SCREEN_LOAD_START, nullptr);
	lv_obj_add_event_cb(screen, onScreen, LV_EVENT_SCREEN_UNLOADED, nullptr);

	/* The stage holds what is built per visit. It is clickable so a tap or hold on empty glass lands
	 * on it, which is where `pulse_wifi::attachOpenGesture` listens, as it does on the ambient screen. */
	stage = lv_obj_create(screen);
	lv_obj_remove_flag(stage, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_style_border_width(stage, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(stage, 0, LV_PART_MAIN);
	lv_obj_set_style_shadow_width(stage, 0, LV_PART_MAIN);
	lv_obj_set_pos(stage, 0, 0);
	lv_obj_set_size(stage, PANEL_W, PANEL_H);
	lv_obj_set_style_bg_opa(stage, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_radius(stage, 0, LV_PART_MAIN);
	lv_obj_add_flag(stage, LV_OBJ_FLAG_CLICKABLE);

	/* The battery chip stays for the whole life of the screen, because it carries the hold that
	 * switches the unit off, and that gesture must exist on whatever screen is home. */
	constexpr int32_t BATTERY_X = PANEL_W - space::md - space::lg - BATTERY_W;
	constexpr int32_t BATTERY_Y = PANEL_H - INSET - BATTERY_H;
	pulse_ui::addBatteryChip(screen, BATTERY_X, BATTERY_Y);

	blinker = lv_timer_create(blink, 3900, nullptr);
	hopper = lv_timer_create(onHop, 4700, nullptr);
}

void populate()
{
	if (populated || screen == nullptr) return;
	populated = true;
	style = pulse_settings::face();

	face = pulse_face::makeCanvas(stage);
	if (face != nullptr) {
		lv_obj_set_pos(face, FACE_X, FACE_Y);
		lv_obj_add_flag(face, LV_OBJ_FLAG_CLICKABLE);
		lv_obj_add_event_cb(face, onTap, LV_EVENT_CLICKED, nullptr);
	}

	thought = lv_label_create(stage);
	lv_obj_set_style_text_font(thought, type::title(), LV_PART_MAIN);
	lv_obj_set_style_text_color(thought, hex(colour::ink_dim), LV_PART_MAIN);
	lv_obj_set_pos(thought, FACE_X + pulse_face::CANVAS_W - 34, FACE_Y);
	lv_obj_add_flag(thought, LV_OBJ_FLAG_HIDDEN);

	head = makeLabel(stage, type::heading(), colour::ink, INSET, HEAD_Y, SAFE_W,
	                 LV_TEXT_ALIGN_CENTER);
	sub = makeLabel(stage, type::body(), colour::ink_dim, INSET, SUB_Y, SAFE_W,
	                LV_TEXT_ALIGN_CENTER);
	lv_label_set_long_mode(head, LV_LABEL_LONG_DOT);
	lv_label_set_long_mode(sub, LV_LABEL_LONG_DOT);

	lv_obj_t *explore = makeButton(stage, PANEL_W - INSET - EXPLORE_W, CORNER_BUTTON_Y, EXPLORE_W,
	                               CORNER_BUTTON_H, "Explore", type::label());
	lv_obj_add_event_cb(explore, onExplore, LV_EVENT_CLICKED, nullptr);
	lv_obj_t *settings = makeButton(stage, INSET, CORNER_BUTTON_Y, SETTINGS_W, CORNER_BUTTON_H,
	                                LV_SYMBOL_SETTINGS, type::label());
	lv_obj_add_event_cb(settings, onSettings, LV_EVENT_CLICKED, nullptr);

	/* Breathing, forever, eased at both ends so it never looks like a stutter. */
	lv_anim_t breathe;
	lv_anim_init(&breathe);
	lv_anim_set_var(&breathe, &breatheY);
	lv_anim_set_exec_cb(&breathe, setBreathe);
	lv_anim_set_values(&breathe, 0, BREATHE);
	lv_anim_set_duration(&breathe, 1800);
	lv_anim_set_playback_duration(&breathe, 1800);
	lv_anim_set_repeat_count(&breathe, LV_ANIM_REPEAT_INFINITE);
	lv_anim_set_path_cb(&breathe, lv_anim_path_ease_in_out);
	lv_anim_start(&breathe);

	lv_anim_t phase;
	lv_anim_init(&phase);
	lv_anim_set_var(&phase, &pose);
	lv_anim_set_exec_cb(&phase, setPhase);
	lv_anim_set_values(&phase, 0, 255);
	lv_anim_set_duration(&phase, 2400);
	lv_anim_set_repeat_count(&phase, LV_ANIM_REPEAT_INFINITE);
	lv_anim_start(&phase);

	breatheY = bounceY = 0;
	drawnOnce = false;
	express(moodFor(stored.inputs));
	say();
}

}  // namespace

void open()
{
	build();
	if (screen == nullptr || active()) return;
	previous = lv_screen_active();
	lv_screen_load(screen);
}

lv_obj_t *surface()
{
	build();
	return stage;
}

bool active()
{
	return screen != nullptr && lv_screen_active() == screen;
}

void update(const Inputs &in)
{
	stored.inputs = in;
	stored.inputs.total = keep(stored.total, in.total);
	stored.inputs.change = keep(stored.change, in.change);
	stored.inputs.topSymbol = keep(stored.topSymbol, in.topSymbol);
	stored.inputs.topPrice = keep(stored.topPrice, in.topPrice);
	stored.inputs.topChange = keep(stored.topChange, in.topChange);
	stored.inputs.age = keep(stored.age, in.age);

	if (!populated) return;
	const Mood next = moodFor(stored.inputs);
	if (!drawnOnce || next != drawn) express(next);
	say();
}

Mood mood()
{
	return drawn;
}

}  // namespace pulse_companion
