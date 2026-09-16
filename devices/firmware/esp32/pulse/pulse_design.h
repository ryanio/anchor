#ifndef ANCHOR_PULSE_DESIGN_H
#define ANCHOR_PULSE_DESIGN_H

#include <lvgl.h>

/*
 * The design system for this firmware: one palette, one spacing scale, one type scale, and the four
 * shapes of screen this device has.
 *
 * ## Why this file exists
 *
 * It was asked for by name — "make a nice design system for all of this to make everything better,
 * the not set up is weirdly to the right with a lot of blank space" — and that second clause is the
 * evidence for the first. Every state this panel could be in with no data was drawn as *a reading
 * with one row filled*: the status word landed in the right-aligned 40px value column at x=123 and
 * three empty label/value pairs sat under it, leaving about 250px of dead panel. Measured from the
 * simulator's own tree dump before any of this was written:
 *
 *     label  (123, 86) 203x44   "not set up"
 *     label  ( 22,178) 101x24   ""
 *     label  (123,164) 203x44   ""
 *     label  ( 22,396) 304x18   "type a network on the glass"
 *
 * A status is not a reading with blanks in it. It is a different kind of screen, and the fix is not a
 * nudged coordinate — it is for this firmware to have *kinds of screen* at all, so that a state gets
 * the layout a state wants rather than inheriting a portfolio's.
 *
 * ## What was actually duplicated
 *
 * Eleven colour constants existed twice, verbatim, in `pulse_ui.cpp` and `pulse_wifi.cpp`, under a
 * comment that admitted it: "they are copied rather than shared because `pulse_ui.h` deliberately
 * exposes a layout and a reading, not a theme". That reasoning was sound about `pulse_ui.h` and wrong
 * about the conclusion — the answer to "the layout header should not also be the theme" is a theme
 * header, which is this one. The palette below is byte-identical to both copies; unifying it changed
 * no pixel, which is the point. What it buys is that the next screen cannot join with a *nearly*
 * matching grey.
 *
 * The same argument covers the numbers. Both files were full of one-off pixels — 10, 12, 14, 22, 8,
 * 6, 18 — each individually defensible and collectively a layout nobody could hold in their head. A
 * screen now composes from steps, and a step has a name.
 *
 * ## Two constraints from the hardware, and they are not style
 *
 *  1. **`INSET` is 20 because the corners of this panel are not on the glass.** The framebuffer is a
 *     full 368x448 rectangle and the display is a rounded one. This clearance has now been measured
 *     by eye three separate times in this repository — `sensors/sensors.ino` at 20, `svg.gridMetrics`
 *     at 4.5% of the short side (17 here), and `pulse_wifi.cpp` at 12 and then 20 after the "Wi-Fi"
 *     heading came out clipped — which is precisely the kind of finding AGENTS.md says must live
 *     where the next driver will look. It lives here now, and `docs/devices-esp32.md` has it under
 *     its own heading. Nothing this file positions goes outside the safe rectangle.
 *  2. **The type scale starts at 16 and nothing on this panel is smaller.** This is an ambient
 *     display read from across a room, not a phone held at 30 cm; the reading's values are 40px on
 *     purpose and Ryan asked, once, for everything to go a size up. A scale whose bottom step is
 *     legible from the doorway is how that stops being a thing somebody has to remember.
 *
 * ## What this is not
 *
 * It is not a theme the host can send down the cable. `pulse_ui.h` argues at length that a device
 * holding its own palette is a real cost — an Omarchy desktop whose theme changed now disagrees with
 * the panel below it — and that cost is unchanged by writing the palette down once instead of twice.
 * When a host *is* attached and can send colours, this file is the one place that has to learn how.
 */
namespace pulse_design {

/* ---------------------------------------------------------------------------------- the panel --- */

constexpr int32_t PANEL_W = 368;
constexpr int32_t PANEL_H = 448;

/* The corner clearance; see the header comment. Everything below is positioned against the safe
 * rectangle this defines, not against the panel. */
constexpr int32_t INSET = 20;
constexpr int32_t SAFE_W = PANEL_W - 2 * INSET; /* 328 */
constexpr int32_t SAFE_H = PANEL_H - 2 * INSET; /* 408 */

/* ---------------------------------------------------------------------------------- the colour -- */

/*
 * Tokyo Night, named by the job each colour does rather than by what it looks like.
 *
 * The values were sampled from the design target rather than typed from memory —
 * `magick review/devices/pulse-amoled.png -crop 368x448+20+20 -colors 12 -format %c histogram:`,
 * where the +20 drops the bezel the review renderer draws — and they have not been changed here.
 * What changed is that they are now called `ink` and `ink_dim` instead of `TEXT` and `MUTED`, which
 * matters for the one decision this palette keeps getting wrong: `warn` was `bad` for a render,
 * so the word "open" on a network row read as an error when an open network is a perfectly joinable
 * network that happens to carry no encryption. A role named for its meaning is harder to misuse than
 * a role named for its hue.
 */
namespace colour {
constexpr uint32_t ground = 0x13141C;    /* behind everything; on an AMOLED this is nearly free */
constexpr uint32_t surface = 0x1A1B26;   /* the card a reading sits on */
constexpr uint32_t raised = 0x24283B;    /* a key, a button, a list row — a thing you can press */
constexpr uint32_t edge = 0x292E42;      /* borders and rules */
constexpr uint32_t ink = 0xC0CAF5;       /* what you are meant to read */
constexpr uint32_t ink_dim = 0x586089;   /* what labels the thing you are meant to read */
constexpr uint32_t ink_faint = 0x4E556D; /* metadata about the reading, not the reading */
constexpr uint32_t accent = 0x7AA2F7;    /* in progress, or the thing to press */
constexpr uint32_t good = 0x9ECE6A;      /* it went up, or it worked */
constexpr uint32_t bad = 0xF7768E;       /* it went down, or it failed */
constexpr uint32_t warn = 0xE0AF68;      /* notice this, without saying it went wrong */
}  // namespace colour

/*
 * A tone is a meaning. The colour is looked up from it.
 *
 * Call sites say `Tone::Bad` and not `colour::bad`, so that a screen never has to decide what shade
 * a failure is — and so that the one place which decides can be changed without a grep.
 */
enum class Tone : uint8_t {
	Ink,     /* the default: this is text, read it */
	Quiet,   /* secondary */
	Accent,  /* something is happening */
	Good,    /* it worked, or it is up */
	Bad,     /* it failed, or it is down */
	Warn,    /* it is not wrong, but notice it */
};

uint32_t toneColour(Tone tone);

/* A signed number's tone, from the sign its producer already decided. Not a re-parse of the string:
 * a second opinion about whether a number is negative is a second place for it to be wrong. */
inline Tone toneForSign(int sign)
{
	return sign > 0 ? Tone::Good : (sign < 0 ? Tone::Bad : Tone::Ink);
}

/* --------------------------------------------------------------------------------- the spacing -- */

/*
 * Six steps, and `lg` is also the safe inset.
 *
 * That coincidence is deliberate rather than lucky: the corner clearance is the outermost gap on
 * every screen, so making it a *step* rather than a special number means the gutter, the gap under a
 * heading and the space beside a button are all the same rhythm. Everything in this firmware is one
 * of these six, and a layout that wants a seventh is a layout that should be questioned.
 */
namespace space {
constexpr int32_t xs = 4;   /* a hairline gap: between a value and the rule under it */
constexpr int32_t sm = 8;   /* between two things that belong together */
constexpr int32_t md = 12;  /* between two things in a row */
constexpr int32_t lg = 20;  /* the gutter, and the gap under a heading */
constexpr int32_t xl = 32;  /* between sections */
constexpr int32_t xxl = 52; /* around the one thing a screen is about */
}  // namespace space

/* Three radii, matched to what they round: a key, a field, a card. */
namespace radius {
constexpr int32_t sm = 8;
constexpr int32_t md = 12;
constexpr int32_t lg = 18;
}  // namespace radius

/* ------------------------------------------------------------------------------------ the type -- */

/*
 * Nine steps, named for what they are for, every one of them a Montserrat face `lv_conf.h` already
 * carries — a tenth would be flash spent, so the scale is the list of faces and the list of faces is
 * the scale.
 *
 * The bottom is 16 and that is the constraint from the hardware, not a preference: this panel is
 * read from across a room. LVGL's own `LV_FONT_DEFAULT` is still Montserrat 14 because anything that
 * renders text without being told a font needs one; nothing in this firmware asks for it.
 *
 * `shout` and `display` each exist for exactly one job — the key drawn under a fingertip, and the
 * magnifier above it — which is worth saying so that a future screen reaches for `hero` instead of
 * inventing a reason to use the biggest thing in the box.
 */
namespace type {
inline const lv_font_t *caption() { return &lv_font_montserrat_16; } /* a footer, a row's metadata */
inline const lv_font_t *label() { return &lv_font_montserrat_18; }   /* a hint, a small button */
inline const lv_font_t *body() { return &lv_font_montserrat_20; }    /* a sentence, at arm's length */
inline const lv_font_t *subhead() { return &lv_font_montserrat_22; } /* what labels a big number */
inline const lv_font_t *heading() { return &lv_font_montserrat_24; } /* a keyboard key, a field */
inline const lv_font_t *title() { return &lv_font_montserrat_28; }   /* what a screen is called */
inline const lv_font_t *shout() { return &lv_font_montserrat_32; }   /* the key under a finger */
inline const lv_font_t *hero() { return &lv_font_montserrat_40; }    /* the number, and the state */
inline const lv_font_t *display() { return &lv_font_montserrat_48; } /* the magnifier */
}  // namespace type

/* ------------------------------------------------------------------------------- the primitives - */

lv_color_t hex(uint32_t rgb);

/*
 * A label that does not move when its text does.
 *
 * `lv_label` sizes itself to its content by default, so a right-aligned value would re-anchor every
 * time the number got a digit longer — on a screen showing money, a column that jitters. Pinning the
 * width and letting the text align inside it is what keeps `$3,299` and `$48,214` on one right edge,
 * and it is also the whole of the fifth Wi-Fi bug's fix: Arduino_GFX *wrapped* a 32-character SSID
 * onto the top row of the keyboard, and the old module's answer was a character budget computed per
 * call site — a different guess about a different string in three places, wrong in all three.
 */
lv_obj_t *makeLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t colour, int32_t x, int32_t y,
                    int32_t width, lv_text_align_t align);

/* The same, for a label a flex container places. No x/y: the container decides. */
lv_obj_t *makeFlowLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t colour, int32_t width,
                        bool wrap);

lv_obj_t *makeButton(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h, const char *text,
                     const lv_font_t *font, lv_obj_t **label_out = nullptr);

/* A full-panel layer. Transparent, so the screen's own ground shows through and exactly one object in
 * the tree paints a background. Not clickable, so a gesture attached to the frame underneath still
 * sees the touch — the ambient screen's "the whole panel is the button" depends on that. */
lv_obj_t *makePage(lv_obj_t *parent);

/* A one-pixel rule, as a filled rectangle rather than `lv_line` — a widget this build does not
 * enable, for a mark that is a rectangle. */
lv_obj_t *makeRule(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, uint32_t colour = colour::edge);

/* The card a reading sits on. */
lv_obj_t *makeSurface(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h);

/* Paint a screen's ground and stop it scrolling. An `lv_obj` is a scroll container by default, so a
 * child one pixel past the edge silently turns a readout into a thing that can be dragged — on a
 * panel with a finger on it, a screen that slides away when somebody brushes it. */
void paintGround(lv_obj_t *screen);

/* ------------------------------------------------------------------------------ the archetypes -- */

/*
 * Four shapes of screen, and every screen in this firmware is one of them.
 *
 * Each is a builder that returns the objects it made, rather than a widget that owns behaviour. That
 * split is the same seam `pulse_ui.h` already argues for about touch: the thing that draws should
 * not also be the place product decisions accumulate. So `buildChooser` gives you three buttons and
 * has no opinion about what they do; `pulse_wifi.cpp` decides that they rescan, type a hidden name,
 * and close.
 */

/*
 * **Reading** — one subject, four labelled values, a footer saying how old it is.
 *
 * Laid out against coordinates rather than through a flex container, and that is still right: four
 * rows and a footer is not a layout problem, it is five y-coordinates, and the failure being guarded
 * against is a value running into its label — which is checked by looking at the render, not by
 * trusting a solver. The value column is right-aligned to a single edge so that four numbers of
 * different widths form a column.
 */
struct ReadingView {
	lv_obj_t *page = nullptr;
	lv_obj_t *card = nullptr;
	lv_obj_t *title = nullptr;
	lv_obj_t *row_label[4] = {nullptr, nullptr, nullptr, nullptr};
	lv_obj_t *row_value[4] = {nullptr, nullptr, nullptr, nullptr};
	lv_obj_t *footer = nullptr;
	/* Where the value column starts and how wide it is, so `setReadingRow` can re-place a value it
	 * has just changed the size of without the metrics leaving this module. */
	int32_t value_x = 0;
	int32_t value_w = 0;
};
ReadingView buildReading(lv_obj_t *parent);

/* Fill one row. Goes through here rather than through `lv_label_set_text` at the call site because
 * the value's *face* depends on its length — see `valueFont` — and a caller setting the text without
 * the font would silently reintroduce the truncated price this fixed. */
void setReadingRow(const ReadingView &view, int row, const char *label, const char *value, Tone tone);

/*
 * **Status** — one state, said plainly, with what to do about it.
 *
 * The archetype Ryan's complaint asked for. No card: a status is the *device* speaking rather than a
 * widget reporting, so it is full-bleed on the ground colour, which also removes the framed
 * rectangle that made the blank space look like a reading that failed to fill in.
 *
 * Composed by a flex column centred on its main axis, which is the one place in this firmware a
 * solver earns its keep. The slots are optional — a joining screen has no note, an ambient one has
 * no buttons — and a fixed y per slot would leave exactly the dead panel this replaced. Hidden
 * children are skipped by LVGL's flex, so an unused slot costs no space at all and the block stays
 * centred whether it holds three lines or six.
 *
 *   eyebrow   what this is about, small and dim: WI-FI, TRENDING
 *   headline  the state itself, in the largest type that fits it, in its tone
 *   bar       a short rule in the same tone — the colour again, for somebody across the room
 *   detail    what to do about it, or what is being waited for
 *   support   what the layer underneath said, quieter
 *   actions   buttons, when there are any
 *   note      provenance: an age, a reason, a coordinate
 */
struct StatusView {
	lv_obj_t *page = nullptr;
	lv_obj_t *eyebrow = nullptr;
	lv_obj_t *headline = nullptr;
	lv_obj_t *bar = nullptr;
	lv_obj_t *detail = nullptr;
	lv_obj_t *support = nullptr;
	lv_obj_t *actions = nullptr;
	lv_obj_t *note = nullptr;
};

/* What a status says. Every field may be empty, and an empty field is not drawn. */
struct StatusCopy {
	const char *eyebrow = "";
	const char *headline = "";
	Tone tone = Tone::Ink;
	const char *detail = "";
	const char *support = "";
	const char *note = "";
};

/* How tall a button in that row is, and how wide two of them are side by side. Exported because the
 * caller makes the buttons — the archetype has no opinion about how many there are. */
constexpr int32_t STATUS_ACTION_H = 56;
constexpr int32_t STATUS_ACTION_PAIR_W = (SAFE_W - space::md) / 2; /* 158 */

/* `with_actions` reserves a row for buttons the caller adds to `StatusView::actions`, which is a flex
 * row. Without it the row is never created and never takes space. */
StatusView buildStatus(lv_obj_t *parent, bool with_actions = false);
void applyStatus(const StatusView &view, const StatusCopy &copy);

/*
 * **Chooser** — a heading, a line of context, a scrolling list, and up to three actions.
 *
 * The list scrolls and its scrollbar is always on rather than fading, because the scrollbar is the
 * only thing that tells somebody a seventh network exists — the fix for a list that silently held
 * entries nobody could reach.
 */
struct ChooserView {
	lv_obj_t *page = nullptr;
	lv_obj_t *title = nullptr;
	lv_obj_t *subtitle = nullptr;
	lv_obj_t *list = nullptr;
	lv_obj_t *action[3] = {nullptr, nullptr, nullptr};
};
ChooserView buildChooser(lv_obj_t *parent, const char *title, const char *action_0,
                         const char *action_1, const char *action_2);

/* Style one row of a chooser's list. Called per row because the list is rebuilt from data. */
void styleChooserRow(lv_obj_t *row);

/*
 * **Input** — a heading, a line of context, one field with a reveal button, a hint, and a keyboard.
 *
 * `lv_keyboard` and `lv_textarea` own hit-testing, shift state, scrolling and password masking, which
 * is four of the seven bugs the hand-drawn module had. What is left for this file is the geometry,
 * and the geometry is where that module's remaining mistakes lived.
 */
struct InputView {
	lv_obj_t *page = nullptr;
	lv_obj_t *title = nullptr;
	lv_obj_t *subtitle = nullptr;
	lv_obj_t *field = nullptr;
	lv_obj_t *reveal = nullptr;
	lv_obj_t *reveal_label = nullptr;
	lv_obj_t *hint = nullptr;
	lv_obj_t *keyboard = nullptr;
};
InputView buildInput(lv_obj_t *parent, const char *placeholder);

/* The magnifier: one key, drawn large, above the finger, on `lv_layer_top()`. Built here because it
 * is a piece of this system's appearance; driven from `pulse_wifi.cpp`, which owns the input. */
constexpr int32_t MAG_W = 112;
constexpr int32_t MAG_H = 124;
lv_obj_t *makeMagnifier();

}  // namespace pulse_design

#endif /* ANCHOR_PULSE_DESIGN_H */
