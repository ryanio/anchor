#ifndef ANCHOR_PULSE_FACE_H
#define ANCHOR_PULSE_FACE_H

#include <lvgl.h>
#include <stdint.h>

#include "pulse_companion_model.h"

/*
 * The companion's faces, drawn rather than assembled.
 *
 * The first face was a dozen rounded LVGL objects: ovals for eyes, and crescents made by laying a
 * body-coloured circle over a dark one because arcs were not compiled in. It read as goofy on the
 * glass, every curve was an approximation, and each feature was another object in the LVGL pool the
 * crowded Wi-Fi scan is short of. A face here is a function that paints one frame into a canvas
 * with real arcs, lines and rounded rectangles, so a smile is a smile, and the pool holds one
 * object however elaborate the face.
 *
 * Every face draws every mood, so choosing one in Settings never loses an expression. `Pose` is
 * everything that moves between frames; the companion animates the pose and asks for a repaint.
 */
namespace pulse_face {

enum class Style : uint8_t {
	Halo,   /* a thin glowing ring and two calm eyes: the serious default */
	Visor,  /* a little robot with LED eyes behind glass */
	Pixel,  /* eight-bit, on a grid */
	Buddy,  /* soft and round, the original idea done properly */
	Count,
};

constexpr int32_t CANVAS_W = 240;
constexpr int32_t CANVAS_H = 224;

struct Pose {
	pulse_companion::Mood mood = pulse_companion::Mood::Content;
	uint8_t blink = 0;  /* 0 open, 255 shut */
	int8_t look = 0;    /* px the eyes are turned, negative left */
	uint8_t phase = 0;  /* a slow cycle for anything that pulses or sweeps */
};

const char *name(Style style);
const char *blurb(Style style);
Style next(Style style, int step);

/* Paint `pose` in `style` onto a canvas of CANVAS_W x CANVAS_H, over `background`. */
void paint(lv_obj_t *canvas, Style style, const Pose &pose, uint32_t background);

/* A canvas with its pixels in PSRAM, or nullptr if there is no room. `release` frees both. */
lv_obj_t *makeCanvas(lv_obj_t *parent);
void release(lv_obj_t *canvas);

}  // namespace pulse_face

#endif /* ANCHOR_PULSE_FACE_H */
