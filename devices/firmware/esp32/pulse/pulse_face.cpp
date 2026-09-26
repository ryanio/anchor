#include "pulse_face.h"

#include <esp_heap_caps.h>
#include <initializer_list>
#include <stdlib.h>
#include <string.h>

#include "pulse_design.h"

namespace pulse_face {

using pulse_companion::Mood;
namespace colour = pulse_design::colour;

namespace {

constexpr int32_t CX = CANVAS_W / 2;
constexpr int32_t CY = CANVAS_H / 2;

/* ---------------------------------------------------------------------------------- primitives -- */

lv_color_t rgb(uint32_t hex)
{
	return lv_color_hex(hex);
}

void arc(lv_layer_t *layer, int32_t x, int32_t y, int32_t r, int32_t width, int32_t from, int32_t to,
         uint32_t colour, lv_opa_t opa = LV_OPA_COVER)
{
	lv_draw_arc_dsc_t dsc;
	lv_draw_arc_dsc_init(&dsc);
	dsc.center.x = x;
	dsc.center.y = y;
	dsc.radius = (uint16_t)r;
	dsc.width = width;
	dsc.start_angle = from;
	dsc.end_angle = to;
	dsc.color = rgb(colour);
	dsc.opa = opa;
	dsc.rounded = 1;
	lv_draw_arc(layer, &dsc);
}

void line(lv_layer_t *layer, int32_t x1, int32_t y1, int32_t x2, int32_t y2, int32_t width,
          uint32_t colour, lv_opa_t opa = LV_OPA_COVER)
{
	lv_draw_line_dsc_t dsc;
	lv_draw_line_dsc_init(&dsc);
	dsc.p1.x = x1;
	dsc.p1.y = y1;
	dsc.p2.x = x2;
	dsc.p2.y = y2;
	dsc.width = width;
	dsc.color = rgb(colour);
	dsc.opa = opa;
	dsc.round_start = 1;
	dsc.round_end = 1;
	lv_draw_line(layer, &dsc);
}

void box(lv_layer_t *layer, int32_t x, int32_t y, int32_t w, int32_t h, int32_t radius, uint32_t colour,
         lv_opa_t opa = LV_OPA_COVER)
{
	lv_draw_rect_dsc_t dsc;
	lv_draw_rect_dsc_init(&dsc);
	dsc.bg_color = rgb(colour);
	dsc.bg_opa = opa;
	dsc.radius = radius;
	lv_area_t area = {x, y, x + w - 1, y + h - 1};
	lv_draw_rect(layer, &dsc, &area);
}

void outline(lv_layer_t *layer, int32_t x, int32_t y, int32_t w, int32_t h, int32_t radius,
             int32_t width, uint32_t colour, lv_opa_t opa = LV_OPA_COVER)
{
	lv_draw_rect_dsc_t dsc;
	lv_draw_rect_dsc_init(&dsc);
	dsc.bg_opa = LV_OPA_TRANSP;
	dsc.border_color = rgb(colour);
	dsc.border_width = width;
	dsc.border_opa = opa;
	dsc.radius = radius;
	lv_area_t area = {x, y, x + w - 1, y + h - 1};
	lv_draw_rect(layer, &dsc, &area);
}

void disc(lv_layer_t *layer, int32_t x, int32_t y, int32_t r, uint32_t colour, lv_opa_t opa = LV_OPA_COVER)
{
	box(layer, x - r, y - r, 2 * r, 2 * r, LV_RADIUS_CIRCLE, colour, opa);
}

/* A pill standing on its centre, closing towards a line as `blink` rises. */
void capsule(lv_layer_t *layer, int32_t x, int32_t y, int32_t w, int32_t h, uint8_t blink, uint32_t colour)
{
	int32_t shown = h * (255 - blink) / 255;
	if (shown < 5) shown = 5;
	box(layer, x - w / 2, y - shown / 2, w, shown, LV_RADIUS_CIRCLE, colour);
}

/* Arc angles run clockwise from three o'clock, so the lower half of a circle is 0..180. */
constexpr int32_t SMILE_FROM = 35;
constexpr int32_t SMILE_TO = 145;
constexpr int32_t ARCH_FROM = 205; /* the top of a circle: a happy, closed eye */
constexpr int32_t ARCH_TO = 335;

/* The colour a mood wears, for the faces that tint with it. */
uint32_t moodColour(Mood mood)
{
	switch (mood) {
		case Mood::Happy:
			return colour::good;
		case Mood::Worried:
			return colour::warn;
		case Mood::Sleepy:
			return colour::ink_faint;
		case Mood::Lost:
			return colour::ink_dim;
		case Mood::Curious:
		case Mood::Content:
		default:
			return colour::accent;
	}
}

/* ---------------------------------------------------------------------------------------- Halo -- */

/*
 * A thin ring with a soft glow and two capsule eyes. The ring takes the mood's colour, so the
 * portfolio's day reads from across a room before the face does.
 */
void paintHalo(lv_layer_t *layer, const Pose &pose)
{
	const uint32_t ring = moodColour(pose.mood);
	const lv_opa_t breathe = (lv_opa_t)(20 + (pose.phase > 127 ? 255 - pose.phase : pose.phase) / 8);
	arc(layer, CX, CY, 98, 24, 0, 360, ring, breathe);
	arc(layer, CX, CY, 98, 10, 0, 360, ring, 50);
	arc(layer, CX, CY, 98, 3, 0, 360, ring);

	const uint32_t ink = colour::ink;
	const int32_t eyeY = CY - 16;
	const int32_t lx = CX - 36 + pose.look;
	const int32_t rx = CX + 36 + pose.look;
	const int32_t mx = CX + pose.look / 2;

	switch (pose.mood) {
		case Mood::Happy:
			arc(layer, lx, eyeY + 12, 16, 7, ARCH_FROM, ARCH_TO, ink);
			arc(layer, rx, eyeY + 12, 16, 7, ARCH_FROM, ARCH_TO, ink);
			arc(layer, mx, CY + 12, 38, 7, 25, 155, ink);
			break;
		case Mood::Worried:
			capsule(layer, lx, eyeY + 8, 16, 30, pose.blink, ink);
			capsule(layer, rx, eyeY + 8, 16, 30, pose.blink, ink);
			line(layer, lx - 18, eyeY - 18, lx + 14, eyeY - 28, 6, ink);
			line(layer, rx + 18, eyeY - 18, rx - 14, eyeY - 28, 6, ink);
			arc(layer, mx, CY + 64, 24, 6, 215, 325, ink);
			break;
		case Mood::Sleepy:
			arc(layer, lx, eyeY - 2, 15, 6, SMILE_FROM, SMILE_TO, colour::ink_dim);
			arc(layer, rx, eyeY - 2, 15, 6, SMILE_FROM, SMILE_TO, colour::ink_dim);
			line(layer, mx - 12, CY + 44, mx + 12, CY + 44, 6, colour::ink_dim);
			break;
		case Mood::Curious:
			capsule(layer, lx, eyeY, 18, 44, pose.blink, ink);
			capsule(layer, rx, eyeY - 4, 20, 50, pose.blink, ink);
			arc(layer, mx, CY + 42, 9, 5, 0, 360, ink);
			break;
		case Mood::Lost:
			disc(layer, lx, eyeY + 4, 9, ink);
			disc(layer, rx, eyeY + 4, 9, ink);
			arc(layer, mx, CY + 42, 8, 5, 0, 360, ink);
			break;
		case Mood::Content:
		default:
			capsule(layer, lx, eyeY, 18, 44, pose.blink, ink);
			capsule(layer, rx, eyeY, 18, 44, pose.blink, ink);
			arc(layer, mx, CY + 16, 30, 6, 40, 140, ink);
			break;
	}
}

/* --------------------------------------------------------------------------------------- Visor -- */

/*
 * A rounded head with a band of dark glass across it and two LED eyes behind the glass. It has no
 * mouth; a row of grille dots lights up when it is pleased, and a sweep crosses the glass while it
 * is asking OpenSea something.
 */
void paintVisor(lv_layer_t *layer, const Pose &pose)
{
	box(layer, CX - 110, CY - 22, 12, 44, 5, colour::edge);
	box(layer, CX + 98, CY - 22, 12, 44, 5, colour::edge);
	box(layer, CX - 100, CY - 86, 200, 172, 58, colour::surface);
	outline(layer, CX - 100, CY - 86, 200, 172, 58, 2, colour::edge);

	const int32_t glassX = CX - 82;
	const int32_t glassY = CY - 48;
	const int32_t glassW = 164;
	const int32_t glassH = 70;
	box(layer, glassX, glassY, glassW, glassH, 35, 0x05060A);
	line(layer, glassX + 26, glassY + 7, glassX + 96, glassY + 7, 2, 0xFFFFFF, 26);

	const uint32_t led = moodColour(pose.mood);
	const int32_t eyeY = glassY + glassH / 2;
	const int32_t lx = CX - 34 + pose.look;
	const int32_t rx = CX + 34 + pose.look;

	switch (pose.mood) {
		case Mood::Happy:
			arc(layer, lx, eyeY + 9, 15, 6, ARCH_FROM, ARCH_TO, led);
			arc(layer, rx, eyeY + 9, 15, 6, ARCH_FROM, ARCH_TO, led);
			break;
		case Mood::Worried:
			line(layer, lx - 15, eyeY + 5, lx + 14, eyeY - 5, 10, led);
			line(layer, rx + 15, eyeY + 5, rx - 14, eyeY - 5, 10, led);
			break;
		case Mood::Sleepy:
			box(layer, lx - 17, eyeY + 4, 34, 4, 2, led);
			box(layer, rx - 17, eyeY + 4, 34, 4, 2, led);
			break;
		case Mood::Lost: {
			const lv_opa_t on = pose.phase < 128 ? LV_OPA_COVER : LV_OPA_40;
			box(layer, lx - 6, eyeY - 6, 12, 12, 3, colour::warn, on);
			box(layer, rx - 6, eyeY - 6, 12, 12, 3, colour::warn, on);
			break;
		}
		case Mood::Curious:
		case Mood::Content:
		default: {
			int32_t h = 20 * (255 - pose.blink) / 255;
			if (h < 3) h = 3;
			box(layer, lx - 22, eyeY - h / 2 - 5, 44, h + 10, 10, led, 40);
			box(layer, rx - 22, eyeY - h / 2 - 5, 44, h + 10, 10, led, 40);
			box(layer, lx - 17, eyeY - h / 2, 34, h, 6, led);
			box(layer, rx - 17, eyeY - h / 2, 34, h, 6, led);
			break;
		}
	}
	if (pose.mood == Mood::Curious) {
		const int32_t sweep = glassX + 14 + (int32_t)pose.phase * (glassW - 28) / 255;
		line(layer, sweep, glassY + 10, sweep, glassY + glassH - 10, 3, led, 90);
	}

	const uint32_t grille = pose.mood == Mood::Happy ? colour::good : colour::edge;
	for (int i = -2; i <= 2; i++) disc(layer, CX + i * 16, CY + 50, 3, grille);
}

/* --------------------------------------------------------------------------------------- Pixel -- */

/*
 * Eight bits on a fourteen by fourteen grid, with the unlit cells faintly visible the way an old
 * LCD shows its segments. Each mood is a pair of eye sprites and a mouth sprite; `#` is lit.
 */
constexpr int32_t CELL = 12;
constexpr int32_t GRID = 14;
constexpr int32_t GRID_X = CX - GRID * CELL / 2;
constexpr int32_t GRID_Y = CY - GRID * CELL / 2;

struct Sprite {
	int8_t rows;
	int8_t cols;
	const char *cells; /* rows * cols characters */
};

void sprite(lv_layer_t *layer, const Sprite &s, int32_t col, int32_t row, uint32_t colour)
{
	if (strlen(s.cells) != (size_t)(s.rows * s.cols)) return;
	for (int r = 0; r < s.rows; r++) {
		for (int c = 0; c < s.cols; c++) {
			if (s.cells[r * s.cols + c] != '#') continue;
			const int32_t gc = col + c;
			const int32_t gr = row + r;
			if (gc < 0 || gc >= GRID || gr < 0 || gr >= GRID) continue;
			box(layer, GRID_X + gc * CELL + 1, GRID_Y + gr * CELL + 1, CELL - 2, CELL - 2, 2, colour);
		}
	}
}

const Sprite EYE_OPEN = {4, 3, "##." "###" "###" "###"};
const Sprite EYE_SHUT = {4, 3, "..." "..." "###" "..."};
const Sprite EYE_ARCH = {4, 3, "..." ".#." "#.#" "..."};
const Sprite EYE_LOW = {4, 3, "..." "###" "###" "..."};
const Sprite EYE_DOT = {4, 3, "..." ".#." ".#." "..."};

const Sprite MOUTH_SMILE = {3, 8, "........" "#......#" ".######."};
const Sprite MOUTH_GRIN = {3, 8, "#......#" ".#....#." "..####.."};
const Sprite MOUTH_FROWN = {3, 8, "..####.." ".#....#." "........"};
const Sprite MOUTH_O = {3, 8, "...##..." "..#..#.." "...##..."};
const Sprite MOUTH_FLAT = {3, 8, "........" "..####.." "........"};

void paintPixel(lv_layer_t *layer, const Pose &pose)
{
	box(layer, GRID_X - 14, GRID_Y - 14, GRID * CELL + 28, GRID * CELL + 28, 30, 0x0E1017);
	outline(layer, GRID_X - 14, GRID_Y - 14, GRID * CELL + 28, GRID * CELL + 28, 30, 2, colour::edge);
	for (int r = 0; r < GRID; r++) {
		for (int c = 0; c < GRID; c++) {
			box(layer, GRID_X + c * CELL + 1, GRID_Y + r * CELL + 1, CELL - 2, CELL - 2, 2, colour::edge, 70);
		}
	}

	const uint32_t lit = moodColour(pose.mood);
	const int32_t shift = pose.look > 4 ? 1 : (pose.look < -4 ? -1 : 0);
	const Sprite *eye = &EYE_OPEN;
	const Sprite *mouth = &MOUTH_SMILE;
	switch (pose.mood) {
		case Mood::Happy:
			eye = &EYE_ARCH;
			mouth = &MOUTH_GRIN;
			break;
		case Mood::Worried:
			eye = &EYE_LOW;
			mouth = &MOUTH_FROWN;
			break;
		case Mood::Sleepy:
			eye = &EYE_SHUT;
			mouth = &MOUTH_FLAT;
			break;
		case Mood::Lost:
			eye = &EYE_DOT;
			mouth = &MOUTH_O;
			break;
		case Mood::Curious:
			mouth = &MOUTH_O;
			break;
		case Mood::Content:
		default:
			break;
	}
	if (eye == &EYE_OPEN && pose.blink > 128) eye = &EYE_SHUT;
	sprite(layer, *eye, 3 + shift, 3, lit);
	sprite(layer, *eye, 8 + shift, 3, lit);
	sprite(layer, *mouth, 3, 9, lit);
}

/* --------------------------------------------------------------------------------------- Buddy -- */

/*
 * The first face's idea, drawn properly: a soft round body with a faint glow, small dark eyes with
 * catch-lights, a thin mouth, and blush or a sweat drop when the day calls for one.
 */
void paintBuddy(lv_layer_t *layer, const Pose &pose)
{
	arc(layer, CX, CY, 96, 10, 0, 360, colour::accent, 36);
	disc(layer, CX, CY, 90, colour::ink);
	disc(layer, CX - 24, CY - 32, 52, 0xFFFFFF, 22);

	const uint32_t dark = colour::ground;
	const int32_t eyeY = CY - 14;
	const int32_t lx = CX - 30 + pose.look;
	const int32_t rx = CX + 30 + pose.look;
	const int32_t mx = CX + pose.look / 2;

	const auto openEyes = [&](int32_t h, int32_t drop) {
		for (const int32_t x : {lx, rx}) {
			capsule(layer, x, eyeY + drop, 22, h, pose.blink, dark);
			if (pose.blink < 100) disc(layer, x + 5, eyeY + drop - h / 4, 4, 0xFFFFFF);
		}
	};

	switch (pose.mood) {
		case Mood::Happy:
			arc(layer, lx, eyeY + 10, 13, 7, ARCH_FROM, ARCH_TO, dark);
			arc(layer, rx, eyeY + 10, 13, 7, ARCH_FROM, ARCH_TO, dark);
			box(layer, CX - 66, CY + 8, 30, 14, LV_RADIUS_CIRCLE, colour::bad, 90);
			box(layer, CX + 36, CY + 8, 30, 14, LV_RADIUS_CIRCLE, colour::bad, 90);
			arc(layer, mx, CY + 10, 30, 6, 30, 150, dark);
			break;
		case Mood::Worried:
			openEyes(24, 6);
			disc(layer, CX + 62, CY - 38, 7, 0x7DCFFF);
			arc(layer, mx, CY + 58, 20, 6, 215, 325, dark);
			break;
		case Mood::Sleepy:
			arc(layer, lx, eyeY - 2, 12, 6, SMILE_FROM, SMILE_TO, dark);
			arc(layer, rx, eyeY - 2, 12, 6, SMILE_FROM, SMILE_TO, dark);
			line(layer, mx - 10, CY + 36, mx + 10, CY + 36, 6, dark);
			break;
		case Mood::Curious:
		case Mood::Lost:
			openEyes(pose.mood == Mood::Lost ? 22 : 32, 0);
			arc(layer, mx, CY + 34, 8, 5, 0, 360, dark);
			break;
		case Mood::Content:
		default:
			openEyes(32, 0);
			arc(layer, mx, CY + 12, 24, 6, 40, 140, dark);
			break;
	}
}

void freeBuffer(lv_event_t *event)
{
	void *buffer = lv_event_get_user_data(event);
	if (buffer != nullptr) heap_caps_free(buffer);
}

}  // namespace

const char *name(Style style)
{
	switch (style) {
		case Style::Visor:
			return "Visor";
		case Style::Pixel:
			return "Pixel";
		case Style::Buddy:
			return "Buddy";
		case Style::Halo:
		default:
			return "Halo";
	}
}

const char *blurb(Style style)
{
	switch (style) {
		case Style::Visor:
			return "A small robot, all business";
		case Style::Pixel:
			return "Eight bits, always cheerful";
		case Style::Buddy:
			return "Soft, round and friendly";
		case Style::Halo:
		default:
			return "Calm and minimal";
	}
}

Style next(Style style, int step)
{
	const int count = (int)Style::Count;
	int at = ((int)style + step) % count;
	if (at < 0) at += count;
	return (Style)at;
}

void paint(lv_obj_t *canvas, Style style, const Pose &pose, uint32_t background)
{
	if (canvas == nullptr) return;
	lv_canvas_fill_bg(canvas, lv_color_hex(background), LV_OPA_COVER);
	lv_layer_t layer;
	lv_canvas_init_layer(canvas, &layer);
	switch (style) {
		case Style::Visor:
			paintVisor(&layer, pose);
			break;
		case Style::Pixel:
			paintPixel(&layer, pose);
			break;
		case Style::Buddy:
			paintBuddy(&layer, pose);
			break;
		case Style::Halo:
		default:
			paintHalo(&layer, pose);
			break;
	}
	lv_canvas_finish_layer(canvas, &layer);
}

lv_obj_t *makeCanvas(lv_obj_t *parent)
{
	void *buffer = heap_caps_malloc((size_t)CANVAS_W * CANVAS_H * 2u, MALLOC_CAP_SPIRAM);
	if (buffer == nullptr) return nullptr;
	lv_obj_t *canvas = lv_canvas_create(parent);
	lv_canvas_set_buffer(canvas, buffer, CANVAS_W, CANVAS_H, LV_COLOR_FORMAT_RGB565);
	/* The pixels live outside LVGL's pool, so they are freed with the object rather than by it; a
	 * screen that cleans its children then cannot leak a face. */
	lv_obj_add_event_cb(canvas, freeBuffer, LV_EVENT_DELETE, buffer);
	return canvas;
}

void release(lv_obj_t *canvas)
{
	if (canvas != nullptr) lv_obj_delete(canvas);
}

}  // namespace pulse_face
