#include "pulse_companion.h"

#include <stdio.h>
#include <string.h>

#include "pulse_design.h"

namespace pulse_companion {
namespace {

using namespace pulse_design;

/* ------------------------------------------------------------------------------------ geometry -- */

/*
 * The character: a rounded body with two eyes and a mouth, centred in the top two thirds of the
 * panel, with a glow behind it. On an AMOLED the black around it costs nothing and the glow is the
 * one soft thing on the screen, which is most of why a character reads well on this panel.
 *
 * Every feature is a plain rounded object, because arcs are not compiled into this firmware. A curve
 * is a crescent: a dark circle with a body-coloured circle laid over it a few pixels up or down. A
 * one-sided border on a circle was tried first and LVGL draws that as a short, shallow arc, which read
 * as a flat dash on the panel.
 */
constexpr int32_t BODY_W = 184;
constexpr int32_t BODY_H = 168;
constexpr int32_t BODY_X = (PANEL_W - BODY_W) / 2; /* 92 */
constexpr int32_t BODY_Y = 96;
constexpr int32_t BREATHE = 6;  /* px the body rises and falls */
constexpr int32_t HALO = 44;    /* how far the outer glow reaches past the body, both sides together */
constexpr int32_t BOUNCE = 22;  /* px a tap lifts it */

constexpr int32_t EYE_W = 30;
constexpr int32_t EYE_H = 46;
constexpr int32_t EYE_Y = 48;
constexpr int32_t EYE_GAP = 22; /* between the two eyes */
constexpr int32_t EYE_LEFT_X = (BODY_W - 2 * EYE_W - EYE_GAP) / 2;
constexpr int32_t EYE_RIGHT_X = EYE_LEFT_X + EYE_W + EYE_GAP;
constexpr int32_t LOOK = 10; /* px the eyes travel when looking around */

constexpr int32_t MOUTH_Y = 104;
constexpr int32_t STROKE = 7;

constexpr int32_t HEAD_Y = 306;
constexpr int32_t SUB_Y = 342;

constexpr uint32_t BODY_COLOUR = colour::ink;
constexpr uint32_t FEATURE_COLOUR = colour::ground;

/* --------------------------------------------------------------------------------------- state -- */

lv_obj_t *screen = nullptr;
lv_obj_t *previous = nullptr;
lv_obj_t *bob = nullptr;  /* breathes */
lv_obj_t *body = nullptr; /* bounces inside `bob` when tapped */
lv_obj_t *eyes[2] = {nullptr, nullptr};
lv_obj_t *eyeCovers[2] = {nullptr, nullptr};
lv_obj_t *mouth = nullptr;
lv_obj_t *mouthCover = nullptr;
lv_obj_t *snore = nullptr;
lv_obj_t *head = nullptr;
lv_obj_t *sub = nullptr;
lv_timer_t *blinker = nullptr;

Action exploreAction = nullptr;
Action wifiAction = nullptr;

Mood drawn = Mood::Content;
bool drawnOnce = false;
size_t lineIndex = 0;
bool eyesOpen = true; /* whether the current mood blinks */
int32_t eyeHeight = EYE_H;
int32_t eyeOffset = 0;
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

/* ---------------------------------------------------------------------------------- primitives -- */

lv_obj_t *plain(lv_obj_t *parent)
{
	lv_obj_t *obj = lv_obj_create(parent);
	lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_remove_flag(obj, LV_OBJ_FLAG_CLICKABLE);
	lv_obj_set_style_pad_all(obj, 0, LV_PART_MAIN);
	lv_obj_set_style_border_width(obj, 0, LV_PART_MAIN);
	lv_obj_set_style_shadow_width(obj, 0, LV_PART_MAIN);
	return obj;
}

/* A feature drawn solid, or as one side of a rounded outline. */
void shape(lv_obj_t *obj, int32_t x, int32_t y, int32_t w, int32_t h, lv_border_side_t outline)
{
	lv_obj_set_pos(obj, x, y);
	lv_obj_set_size(obj, w, h);
	lv_obj_set_style_radius(obj, LV_RADIUS_CIRCLE, LV_PART_MAIN);
	if (outline == LV_BORDER_SIDE_NONE) {
		lv_obj_set_style_bg_color(obj, hex(FEATURE_COLOUR), LV_PART_MAIN);
		lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, LV_PART_MAIN);
		lv_obj_set_style_border_width(obj, 0, LV_PART_MAIN);
	} else {
		lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, LV_PART_MAIN);
		lv_obj_set_style_border_color(obj, hex(FEATURE_COLOUR), LV_PART_MAIN);
		lv_obj_set_style_border_width(obj, STROKE, LV_PART_MAIN);
		lv_obj_set_style_border_side(obj, outline, LV_PART_MAIN);
	}
}

/* ------------------------------------------------------------------------------------ crescents -- */

/* A solid oval, with its cover hidden. */
void solid(lv_obj_t *feature, lv_obj_t *cover, int32_t x, int32_t y, int32_t w, int32_t h)
{
	shape(feature, x, y, w, h, LV_BORDER_SIDE_NONE);
	lv_obj_add_flag(cover, LV_OBJ_FLAG_HIDDEN);
}

/* A crescent from a circle of diameter `d` at (x, y) with its cover `shift` pixels down (positive:
 * the arch of a happy eye or a frown) or up (negative: a smile, or a closed eye). */
void crescent(lv_obj_t *feature, lv_obj_t *cover, int32_t x, int32_t y, int32_t d, int32_t shift)
{
	shape(feature, x, y, d, d, LV_BORDER_SIDE_NONE);
	lv_obj_remove_flag(cover, LV_OBJ_FLAG_HIDDEN);
	lv_obj_set_pos(cover, x - 2, y + shift);
	lv_obj_set_size(cover, d + 4, d + 4);
}

/* ------------------------------------------------------------------------------------- the eyes -- */

/* Open eyes are solid ovals; their height is what a blink animates, around their centre. */
void placeOpenEyes()
{
	const int32_t top = EYE_Y + (EYE_H - eyeHeight) / 2;
	solid(eyes[0], eyeCovers[0], EYE_LEFT_X + eyeOffset, top, EYE_W, eyeHeight);
	solid(eyes[1], eyeCovers[1], EYE_RIGHT_X + eyeOffset, top, EYE_W, eyeHeight);
}

void setEyeHeight(void *, int32_t height)
{
	eyeHeight = height;
	if (eyesOpen) placeOpenEyes();
}

void setEyeOffset(void *, int32_t offset)
{
	eyeOffset = offset;
	if (eyesOpen) placeOpenEyes();
}

void blink(lv_timer_t *)
{
	if (!eyesOpen || !populated || lv_screen_active() != screen) return;
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_exec_cb(&anim, setEyeHeight);
	lv_anim_set_values(&anim, EYE_H, 6);
	lv_anim_set_duration(&anim, 90);
	lv_anim_set_playback_duration(&anim, 110);
	lv_anim_start(&anim);
}

void lookAround(bool on)
{
	lv_anim_delete(nullptr, setEyeOffset);
	eyeOffset = 0;
	if (!on) return;
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_exec_cb(&anim, setEyeOffset);
	lv_anim_set_values(&anim, -LOOK, LOOK);
	lv_anim_set_duration(&anim, 1100);
	lv_anim_set_playback_duration(&anim, 1100);
	lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
	lv_anim_set_path_cb(&anim, lv_anim_path_ease_in_out);
	lv_anim_start(&anim);
}

/* ----------------------------------------------------------------------------------- the moods -- */

void snoring(bool on)
{
	lv_anim_delete(snore, nullptr);
	if (!on) {
		lv_obj_add_flag(snore, LV_OBJ_FLAG_HIDDEN);
		return;
	}
	lv_obj_remove_flag(snore, LV_OBJ_FLAG_HIDDEN);
	lv_anim_t rise;
	lv_anim_init(&rise);
	lv_anim_set_var(&rise, snore);
	lv_anim_set_exec_cb(&rise, [](void *obj, int32_t y) { lv_obj_set_y((lv_obj_t *)obj, y); });
	lv_anim_set_values(&rise, BODY_Y - 4, BODY_Y - 44);
	lv_anim_set_duration(&rise, 2200);
	lv_anim_set_repeat_count(&rise, LV_ANIM_REPEAT_INFINITE);
	lv_anim_start(&rise);
	lv_anim_t fade;
	lv_anim_init(&fade);
	lv_anim_set_var(&fade, snore);
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
	eyeHeight = EYE_H;
	eyesOpen = mood == Mood::Content || mood == Mood::Curious || mood == Mood::Worried ||
	           mood == Mood::Lost;
	lookAround(mood == Mood::Curious || mood == Mood::Lost);
	snoring(mood == Mood::Sleepy);

	/* The mouth is centred; `d` is its circle, and the cover's shift sets how deep the curve is. */
	const auto mouthAt = [](int32_t d, int32_t y, int32_t shift) {
		crescent(mouth, mouthCover, (BODY_W - d) / 2, y, d, shift);
	};
	switch (mood) {
		case Mood::Happy:
			/* Arched, closed eyes and a wide smile. */
			crescent(eyes[0], eyeCovers[0], EYE_LEFT_X - 2, EYE_Y + 6, EYE_W + 4, 14);
			crescent(eyes[1], eyeCovers[1], EYE_RIGHT_X - 2, EYE_Y + 6, EYE_W + 4, 14);
			mouthAt(72, 74, -18);
			break;
		case Mood::Worried:
			placeOpenEyes();
			/* Kept high enough that the cover stays inside the body's rounded bottom. */
			mouthAt(44, 100, 12);
			break;
		case Mood::Curious:
		case Mood::Lost:
			/* A small round mouth, as if about to ask something. */
			placeOpenEyes();
			solid(mouth, mouthCover, (BODY_W - 24) / 2, MOUTH_Y + 8, 24, 24);
			break;
		case Mood::Sleepy:
			/* Closed eyes curving down, and a flat mouth. */
			crescent(eyes[0], eyeCovers[0], EYE_LEFT_X - 2, EYE_Y + 8, EYE_W + 4, -12);
			crescent(eyes[1], eyeCovers[1], EYE_RIGHT_X - 2, EYE_Y + 8, EYE_W + 4, -12);
			solid(mouth, mouthCover, (BODY_W - 28) / 2, MOUTH_Y + 16, 28, STROKE);
			break;
		case Mood::Content:
		default:
			placeOpenEyes();
			mouthAt(54, 88, -12);
			break;
	}
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

void setBounce(void *, int32_t y)
{
	lv_obj_set_y(body, HALO / 2 + y);
}

void onTap(lv_event_t *)
{
	if (!stored.inputs.wifiConfigured && wifiAction != nullptr) {
		wifiAction();
		return;
	}
	lineIndex++;
	say();
	lv_anim_t anim;
	lv_anim_init(&anim);
	lv_anim_set_exec_cb(&anim, setBounce);
	lv_anim_set_values(&anim, 0, -BOUNCE);
	lv_anim_set_duration(&anim, 140);
	lv_anim_set_playback_duration(&anim, 260);
	lv_anim_set_path_cb(&anim, lv_anim_path_ease_out);
	lv_anim_start(&anim);
}

void onExplore(lv_event_t *)
{
	if (exploreAction != nullptr) exploreAction();
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
 * object itself stays, so Explore and Wi-Fi can still return to it.
 */

void depopulate()
{
	if (!populated) return;
	/* Animations whose variable is null are not removed with the objects they move. */
	lv_anim_delete(nullptr, setEyeHeight);
	lv_anim_delete(nullptr, setEyeOffset);
	lv_anim_delete(nullptr, setBounce);
	lv_obj_clean(screen);
	bob = body = mouth = mouthCover = snore = head = sub = nullptr;
	eyes[0] = eyes[1] = eyeCovers[0] = eyeCovers[1] = nullptr;
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
	blinker = lv_timer_create(blink, 3900, nullptr);
}

void populate()
{
	if (populated || screen == nullptr) return;
	populated = true;

	/* Breathing moves `bob`; a tap moves `body` inside it, so the two never fight over one y. */
	/* `bob` is big enough for the glow, because a child is clipped to its parent's rectangle and a
	 * glow clipped to the body's box renders as a square. */
	bob = plain(screen);
	lv_obj_set_style_bg_opa(bob, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_pos(bob, BODY_X - HALO / 2, BODY_Y - HALO / 2);
	lv_obj_set_size(bob, BODY_W + HALO, BODY_H + HALO);
	lv_obj_set_style_radius(bob, 0, LV_PART_MAIN);

	/*
	 * The glow: two faint, larger rounded shapes behind the body rather than a shadow.
	 *
	 * An LVGL shadow this wide renders through a temporary buffer sized by the shadow and the corner
	 * radius, and at 64 px on this body the allocation failed and LVGL wrote through a null pointer:
	 * the simulator crashed the moment the screen drew. Two translucent layers read the same on an
	 * AMOLED, need no buffer, and animate with the body because they are its siblings in `bob`.
	 */
	for (int ring = 0; ring < 2; ring++) {
		const int32_t grow = ring == 0 ? HALO : HALO / 2;
		lv_obj_t *halo = plain(bob);
		lv_obj_set_pos(halo, (HALO - grow) / 2, (HALO - grow) / 2);
		lv_obj_set_size(halo, BODY_W + grow, BODY_H + grow);
		lv_obj_set_style_radius(halo, (BODY_H + grow) / 2, LV_PART_MAIN);
		lv_obj_set_style_bg_color(halo, hex(colour::accent), LV_PART_MAIN);
		lv_obj_set_style_bg_opa(halo, ring == 0 ? LV_OPA_10 : LV_OPA_20, LV_PART_MAIN);
	}

	body = plain(bob);
	lv_obj_set_pos(body, HALO / 2, HALO / 2);
	lv_obj_set_size(body, BODY_W, BODY_H);
	lv_obj_set_style_radius(body, BODY_H / 2, LV_PART_MAIN);
	lv_obj_set_style_bg_color(body, hex(BODY_COLOUR), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(body, LV_OPA_COVER, LV_PART_MAIN);
	/* One flat colour, because the crescents' covers are that colour. A gradient was tried, and a
	 * frown's cover showed as a pale patch where it crossed into the shaded part. The glow gives the
	 * depth instead. */
	lv_obj_add_flag(body, LV_OBJ_FLAG_CLICKABLE);
	lv_obj_add_event_cb(body, onTap, LV_EVENT_CLICKED, nullptr);

	/* Each feature, then its cover, so the cover draws over it. */
	for (int i = 0; i < 2; i++) {
		eyes[i] = plain(body);
		eyeCovers[i] = plain(body);
	}
	mouth = plain(body);
	mouthCover = plain(body);
	lv_obj_t *covers[3] = {eyeCovers[0], eyeCovers[1], mouthCover};
	for (lv_obj_t *cover : covers) {
		lv_obj_set_style_radius(cover, LV_RADIUS_CIRCLE, LV_PART_MAIN);
		lv_obj_set_style_bg_color(cover, hex(BODY_COLOUR), LV_PART_MAIN);
		lv_obj_set_style_bg_opa(cover, LV_OPA_COVER, LV_PART_MAIN);
		lv_obj_add_flag(cover, LV_OBJ_FLAG_HIDDEN);
	}

	snore = lv_label_create(screen);
	lv_label_set_text(snore, "z");
	lv_obj_set_style_text_font(snore, type::title(), LV_PART_MAIN);
	lv_obj_set_style_text_color(snore, hex(colour::ink_dim), LV_PART_MAIN);
	lv_obj_set_pos(snore, BODY_X + BODY_W - 10, BODY_Y);
	lv_obj_add_flag(snore, LV_OBJ_FLAG_HIDDEN);

	head = makeLabel(screen, type::heading(), colour::ink, INSET, HEAD_Y, SAFE_W,
	                 LV_TEXT_ALIGN_CENTER);
	sub = makeLabel(screen, type::body(), colour::ink_dim, INSET, SUB_Y, SAFE_W,
	                LV_TEXT_ALIGN_CENTER);
	lv_label_set_long_mode(head, LV_LABEL_LONG_DOT);
	lv_label_set_long_mode(sub, LV_LABEL_LONG_DOT);

	lv_obj_t *explore = makeButton(screen, PANEL_W - INSET - 108, 24, 108, 44, "Explore",
	                               type::label());
	lv_obj_add_event_cb(explore, onExplore, LV_EVENT_CLICKED, nullptr);

	/* Breathing, forever, eased at both ends so it never looks like a stutter. */
	lv_anim_t breathe;
	lv_anim_init(&breathe);
	lv_anim_set_var(&breathe, bob);
	lv_anim_set_exec_cb(&breathe, [](void *obj, int32_t y) { lv_obj_set_y((lv_obj_t *)obj, y); });
	lv_anim_set_values(&breathe, BODY_Y - HALO / 2, BODY_Y - HALO / 2 + BREATHE);
	lv_anim_set_duration(&breathe, 1800);
	lv_anim_set_playback_duration(&breathe, 1800);
	lv_anim_set_repeat_count(&breathe, LV_ANIM_REPEAT_INFINITE);
	lv_anim_set_path_cb(&breathe, lv_anim_path_ease_in_out);
	lv_anim_start(&breathe);

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
