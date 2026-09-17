#include <ArduinoJson.h>

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "art.h"
#include "cable.h"
#include "motion.h"
#include "standalone.h"
#include "ui.h"
#include "view.h"

// Anchor on the Cardputer: a panel a desktop paints, and nothing else.
//
// This is an app pack: it lives in the Anchor repository and is built against
// flint, which is a submodule beside it. Nothing here is in flint's tree, and
// an Anchor build compiles none of flint's own views, so the only screen this
// firmware has is the one below. See ../README.md and flint's docs/APPS.md.
//
// Anchor (anchor.ryanio.com) is a crypto wallet that lives in the Omarchy bar.
// Its data service binds 127.0.0.1 and never the LAN, which is the whole
// reason this view reads a cable rather than an API: the numbers on this
// screen are one person's portfolio, and the unit holds no key, no token and
// no address to fetch them with. A desktop composes the screen and pushes it
// down USB, so the Cardputer is exactly as trusted as a keyboard.
//
// What arrives is a rectangle, a surface and a palette. The host owns the
// layout, so the grid below is not a constant in this file: every paint says
// where it goes, and this validates the rectangle against the body and draws
// it. The palette arrives the same way, from the live Omarchy theme, which is
// what makes the panel change colour when the desktop does.
//
// Four surface kinds reach this screen. A tile and a bar are the deck's shapes,
// eight keys and a strip, and they were all this panel drew while the host had
// nothing else to say to a 240x135 screen. A list and a detail are the shapes
// that screen is actually for: rows somebody scrolls with the arrow keys, and
// the one row they stopped on opened in full. Nothing about them is pixels. The
// host sends the same medium neutral surface it sends a Stream Deck and this
// file draws it in flint's own primitives, which is what keeps a collection
// name off the wire as an image and on the glass as text.
//
// What this view can never do is the part worth reading twice. The three
// messages it sends are hello, key and power. There is no message for approve,
// sign, buy or send, so no sequence of keystrokes here can ask for one, and
// nothing on the far end would have a field to read it out of. Anchor enforces
// policy in an executor the unit cannot reach, and a card on a desk that
// anybody walking past can press is the last place that decision belongs.
//
// Typing is a filter over what is already on screen. The host opens a filter
// box, the characters go into it, and Enter sends the string back to narrow
// rows the desktop already has. Nothing evaluates it: it is not a command, an
// address, an amount or a passphrase, and the host never turns it into a
// request. See flint's docs/APPS.md for the seams, and docs/devices-cardputer.md
// in this repository for the protocol.
namespace {

constexpr int PROTOCOL_VERSION = 1;
constexpr const char *FIRMWARE = "flint-anchor 0.1.0";

// The host pings every five seconds. Three missed pings is a link that is gone.
constexpr uint32_t LINK_TIMEOUT_MS = 15000;
constexpr uint32_t HELLO_MS = 2000;
constexpr uint32_t POWER_MS = 5000;

// How long to keep saying "waiting for host" before this unit draws its own screen.
//
// Two numbers, because the two cases are not the same question. A link that *was* up and dropped is
// probably coming back — a desktop restarting the adapter, a cable knocked at a desk — and changing
// the screen out from under somebody for four seconds of that is a change nobody asked for. A unit
// that has never heard a host since this view opened is a unit somebody picked up off a table, and
// making them wait ten seconds to find out what it is was the old behaviour's real cost: the cable
// is for flashing (AGENTS.md), so the case with no host in it is the ordinary one now and it should
// not be the one that waits longest.
//
// Four seconds rather than none, because the device announces itself every two (HELLO_MS) and a
// host answers the next one; anything shorter would flash the browse screen up on a unit that is
// about to link after all.
constexpr uint32_t STANDALONE_GRACE_MS = 10000;
constexpr uint32_t STANDALONE_COLD_MS = 4000;
// How long the identity screen holds before the first trending tiles show.
constexpr uint32_t STANDALONE_INTRO_MS = 3000;

// Tilt to page was here and is deliberately gone.
//
// Tipping the right hand edge down paged forward and the left edge back, sending exactly what Tab
// and shift-Tab send. It worked, and it was removed after being felt in a hand: a unit carried
// around, set down, and picked up again pages itself, and a panel that changes because of how
// somebody happened to be holding it is not a feature they can tell apart from a fault. The gesture
// that survives is the one on the device that is already in a hand for a reason — Maze reads tilt to
// roll its marble, where the tilt *is* the input rather than a side effect of carrying something.
//
// Tab and shift-Tab still page, and the strip still takes a swipe. Nothing else changed.

// One strip, nine tiles and one screen, which is what the host's Cardputer geometry sends.
// Held as a fixed table rather than a map so a frame allocates nothing.
//
// The screen is the odd one and it is last on purpose. It is the body the nine tiles cover, painted
// as one surface instead of nine, which is the only way a list of twenty trending tokens fits on a
// device whose keys are 80x35. So it is the one slot here that overlaps another, and this table is
// drawn in index order. Last means a frame that paints both puts the screen on top rather than
// under. See `slotRects` in devices/src/adapters/cardputer.ts, which declares it last for the same
// reason on the other end of the cable.
constexpr int SLOTS = 11;
constexpr int SLOT_STRIP = 0;
constexpr int SLOT_KEY_0 = 1;
constexpr int SLOT_SCREEN = 10;
constexpr int SEGS_MAX = 6;

// A list surface's rows and a detail surface's lines, held the same way and for the same reason.
//
// Twelve is not how many rows the host may send: it is how many this table holds at once, and the
// parser keeps a window of that size around the selected row rather than the first twelve, so the
// row somebody is looking at is always one of them however long the real list is. The strip under
// the rows counts against the true total the host sent, not against what survived the window, which
// is the difference between a panel that says "4 of 23" and one that quietly says "4 of 12".
constexpr int ROWS_MAX = 12;
constexpr int LINES_MAX = 8;

enum Kind : uint8_t { KIND_NONE, KIND_TILE, KIND_BAR, KIND_LIST, KIND_DETAIL };
enum Emphasis : uint8_t { EM_GROUND, EM_RAISED, EM_ACTIVE };

enum Token : uint8_t {
	GROUND,
	RAISED,
	SUNKEN,
	INK,
	INK_DIM,
	INK_STRONG,
	ACCENT,
	POSITIVE,
	NEGATIVE,
	WARNING,
	LINE,
	TOKEN_COUNT
};

const char *const TOKEN_NAMES[TOKEN_COUNT] = {"ground",   "raised",    "sunken", "ink",
                                              "inkDim",   "inkStrong", "accent", "positive",
                                              "negative", "warning",   "line"};

// flint's own palette until the host sends one. Not a guess at Anchor's
// colours: this view holds none of its own, and until a theme arrives it wears
// the firmware it is running inside.
uint16_t palette[TOKEN_COUNT] = {ui::BG,    ui::PANEL, ui::BG,  ui::FG,   ui::DIM, ui::FG,
                                 ui::CORAL, ui::GOOD,  ui::BAD, ui::WARN, ui::RULE};

struct Seg {
	// Forty rather than the twenty-six a wire segment needs, because the browse strip draws a whole
	// sentence through this: "asking OpenSea what is trending" is thirty-one characters and at
	// twenty-six it read "asking OpenSea what is tr.", which is a status bar admitting it has no
	// room for the status. Font0 is six pixels a character, so forty is the width of the panel and
	// nothing shorter is a real limit. It costs no RAM at all: `Slot`'s union is sized by `rows`
	// (twelve of them), and six of these are still well inside that.
	char text[40];
	uint16_t color;
};

// One row of a list surface: `{ label, value?, icon?, tone? }` off the wire.
struct Row {
	char label[24];
	char value[14];
	// The icon is a character the host's key config chose, and that config writes Font Awesome
	// private use codepoints (config/panel.json is full of them, written as "\uf1fc" and the like).
	// This panel has no such
	// font, so `takeText` folds those to nothing and this holds the empty string, which is the
	// honest outcome and the reason the gutter is reserved per list rather than per row: rows whose
	// icons all vanished keep their labels on the same left edge as rows that never had one.
	char icon[4];
	// Whether the row carried a tone at all, kept rather than folded into a resolved colour because
	// the two ends have to agree on what an absent tone means and it is not one colour: the host's
	// own renderer draws an untoned icon in the accent and an untoned reading in the row's ink, and
	// that ink is the strong one when the row is the selected one. See renderList in
	// devices/src/svg.ts, which is the same surface drawn for a Stream Deck.
	bool hasTone;
	uint16_t tone;
};

// One labelled line of a detail surface: `{ label, value, tone? }`.
struct Line {
	char label[20];
	char value[20];
	bool hasTone;
	uint16_t tone;
};

struct Slot {
	bool used;
	// Set whenever a frame touches this slot, cleared once `draw()` has repainted it. Segment
	// readings (clock, cpu, memory) change on most ticks, and a slot's own draw already clears its
	// rect before it paints — so only redrawing what a frame actually named turns a full-panel flash
	// every second into a redraw of the one tile that changed.
	bool dirty;
	uint8_t kind;
	bool sel;
	int16_t x, y, w, h;

	// A tile's label, and a detail's title. One field rather than two because a slot is one surface
	// at a time and the second name would be a second thing to keep in step for no new capability.
	char label[24];
	char value[16];
	// Eight held a tile's badge, which is a reading like "+4%". A detail's badge is a word, and
	// "TRENDING" is exactly nine bytes with its terminator, so eight drew "TRENDIN." on the first
	// surface that used one.
	char badge[12];
	uint16_t tone;
	uint8_t emphasis;
	bool hasMeter;
	float meter;

	// A sentence under the rows: a list's `empty` and a detail's `footer`. The same field for the
	// same reason `label` carries a title: both are prose the rows above cannot say for themselves,
	// and no surface has both.
	char caption[64];

	// List: which row the host says is current, as an index into `rows` below rather than into what
	// the host sent, and -1 for none. `first` is where the kept window starts and `total` is how
	// many rows actually arrived, which together are what let the strip count honestly.
	int16_t selected;
	int16_t first;
	int16_t total;
	// The first visible row. Carried across frames rather than derived, so a cursor moving one row
	// scrolls the window by one the way flint's own list does (src/views/setup.cpp, drawPicking)
	// instead of jumping the selection back to the middle on every repaint.
	int16_t top;
	bool iconGutter;

	// The three kinds are mutually exclusive, and a fixed table of eleven slots pays for the
	// largest member eleven times over. A union is what keeps a list surface from costing every
	// tile in the table 528 bytes of rows it will never hold. The counts live outside it, so that
	// `Slot next = {}` zeroes them whatever the union's first member happens to be.
	union {
		Seg segs[SEGS_MAX];
		Row rows[ROWS_MAX];
		Line lines[LINES_MAX];
	};
	uint8_t segCount;
	uint8_t rowCount;
	uint8_t lineCount;
};

Slot slots[SLOTS];

char inbox[cable::MAX_LINE + 1];

bool linked = false;
// Whether a host has ever spoken since this view opened, which is what separates "the link dropped"
// from "there is no desktop here at all". See STANDALONE_GRACE_MS.
bool everLinked = false;
bool protocolOk = true;
uint32_t lastHost = 0;
uint32_t lastHello = 0;
uint32_t lastPower = 0;
int32_t sentLevel = -1;
bool sentCharging = false;

// When unlinked started, so STANDALONE_GRACE_MS is measured from the right moment whether this is
// a fresh boot with no cable at all or a cable that dropped after a real session.
uint32_t unlinkedSince = 0;
// What the browse screen was last drawn from. Every one of these is compared rather than polled on
// a timer, so the panel repaints when the thing on it changed and not once a second: a redraw
// nobody can see a difference in is a flash bought for nothing. The reasons are compared by pointer
// on purpose — they are compiled-in sentences from one table, never strings off the network, so
// pointer equality is exactly sentence equality here.
size_t lastStandaloneCount = 0;
standalone::Status lastStandaloneStatus = standalone::Status::Disabled;
const char *lastStandaloneReason = nullptr;
size_t lastHolderCount = 0;
size_t lastEventCount = 0;
const char *lastHoldersReason = nullptr;
const char *lastActivityReason = nullptr;

// Three seconds naming what this is before the tiles start, for whoever just
// picked the unit up off a table and has never seen Anchor before. Zero means
// "not decided yet"; tick() sets it the moment standalone data is first ready
// and clears it (with standaloneIntroShown) the next time the cable drops, so
// somebody who walks up later gets the same three seconds too.
uint32_t standaloneIntroUntil = 0;
bool standaloneIntroShown = false;

bool queryActive = false;
char queryText[72];

uint8_t savedBrightness = 0;

// ------------------------------------------------------------------- helpers

// Slot ids the host and this file agree on. Anything else is dropped rather
// than drawn somewhere plausible.
int slotIndex(const char *id)
{
	if (id == nullptr) {
		return -1;
	}
	if (strcmp(id, "strip:0") == 0) {
		return SLOT_STRIP;
	}
	if (strncmp(id, "key:", 4) == 0 && id[4] >= '0' && id[4] <= '8' && id[5] == '\0') {
		return SLOT_KEY_0 + (id[4] - '0');
	}
	// The body as one surface. Spelled the same on both ends because it is one name in one file:
	// `SCREEN_SLOT` in devices/src/panel.ts, which an ESP32 panel was already painting before this
	// device had anything to put on it.
	if (strcmp(id, "screen:0") == 0) {
		return SLOT_SCREEN;
	}
	return -1;
}

uint16_t tokenColor(const char *name, uint16_t fallback)
{
	if (name == nullptr) {
		return fallback;
	}
	for (uint8_t i = 0; i < TOKEN_COUNT; i++) {
		if (strcmp(name, TOKEN_NAMES[i]) == 0) {
			return palette[i];
		}
	}
	return fallback;
}

// #rrggbb, strictly, and refused rather than half read. Everything on this
// wire is untrusted, colours included.
bool parseHex(const char *text, uint16_t &out)
{
	if (text == nullptr || text[0] != '#') {
		return false;
	}
	uint32_t value = 0;
	for (int i = 1; i <= 6; i++) {
		const char c = text[i];
		uint32_t digit;
		if (c >= '0' && c <= '9') {
			digit = (uint32_t)(c - '0');
		} else if (c >= 'a' && c <= 'f') {
			digit = (uint32_t)(c - 'a' + 10);
		} else if (c >= 'A' && c <= 'F') {
			digit = (uint32_t)(c - 'A' + 10);
		} else {
			return false;
		}
		value = (value << 4) | digit;
	}
	if (text[7] != '\0') {
		return false;
	}
	out = ui::rgb565((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
	return true;
}

// Two colours, some of the way between, in 565. The host draws an active tile
// as a blend of the ground and the tile's tone, and this is the same blend, so
// a key face reads the same on a deck and on this panel.
uint16_t blend(uint16_t a, uint16_t b, float t)
{
	const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
	const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
	const int r = ar + (int)((float)(br - ar) * t);
	const int g = ag + (int)((float)(bg - ag) * t);
	const int bl = ab + (int)((float)(bb - ab) * t);
	return (uint16_t)((r << 11) | (g << 5) | bl);
}

// Every string that reaches the panel goes through here. The panel's fonts are
// ASCII and the payload is UTF-8 written by somebody else: a collection name
// can carry anything at all, and the em dash Anchor uses for a missing reading
// has to survive as something visible rather than as nothing.
void takeText(char *out, size_t n, const char *src)
{
	if (src == nullptr) {
		out[0] = '\0';
		return;
	}
	char folded[128];
	ui::asciify(src, folded, sizeof(folded));
	snprintf(out, n, "%s", folded);
}

// ------------------------------------------------------------------ drawing

void drawTile(const Slot &s)
{
	M5GFX &g = ui::gfx();
	uint16_t fill = palette[GROUND];
	if (s.emphasis == EM_ACTIVE) {
		fill = blend(palette[GROUND], s.tone, 0.3f);
	} else if (s.emphasis == EM_RAISED) {
		fill = palette[RAISED];
	}
	const uint16_t edge =
	    s.sel ? palette[ACCENT] : (s.emphasis == EM_ACTIVE ? s.tone : palette[LINE]);

	g.fillRect(s.x, s.y, s.w, s.h, palette[GROUND]);
	g.fillRoundRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2, 4, fill);
	g.drawRoundRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2, 4, edge);
	// The cursor is a second ring rather than a fill: a tile that announced
	// focus by changing colour would be indistinguishable from a tile whose
	// reading had gone negative.
	if (s.sel) {
		g.drawRoundRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4, 3, edge);
	}

	const int pad = 4;
	const int inner = s.w - pad * 2;
	const int meterRoom = s.hasMeter ? 5 : 0;

	if (s.value[0] != '\0') {
		// A key that says only what it does wastes the surface. What it
		// currently is, is the useful part, so the reading leads and the label
		// becomes its caption.
		g.setFont(&fonts::Font2);
		ui::clip(s.value, s.x + s.w / 2, s.y + 3, inner,
		         s.emphasis == EM_ACTIVE ? palette[INK_STRONG] : palette[INK], fill,
		         textdatum_t::top_center);
		g.setFont(&fonts::Font0);
		ui::clip(s.label, s.x + s.w / 2, s.y + s.h - meterRoom - 11, inner, palette[INK_DIM], fill,
		         textdatum_t::top_center);
	} else if (s.label[0] != '\0') {
		g.setFont(&fonts::Font2);
		ui::clip(s.label, s.x + s.w / 2, s.y + (s.h - meterRoom) / 2, inner,
		         s.emphasis == EM_ACTIVE ? palette[INK_STRONG] : palette[INK], fill,
		         textdatum_t::middle_center);
	}

	if (s.hasMeter) {
		const int barY = s.y + s.h - pad - 1;
		g.fillRect(s.x + pad, barY, inner, 3, palette[LINE]);
		g.fillRect(s.x + pad, barY, (int)((float)inner * s.meter), 3, s.tone);
	}

	if (s.badge[0] != '\0') {
		g.setFont(&fonts::Font0);
		ui::clip(s.badge, s.x + s.w - pad, s.y + pad, inner / 2, palette[ACCENT], fill,
		         textdatum_t::top_right);
	}
}

void drawBar(const Slot &s)
{
	M5GFX &g = ui::gfx();
	g.fillRect(s.x, s.y, s.w, s.h, palette[SUNKEN]);
	g.drawFastHLine(s.x, s.y + s.h - 1, s.w, palette[LINE]);
	g.setFont(&fonts::Font0);

	const int right = s.x + s.w - 3;
	const int middle = s.y + s.h / 2;
	int x = s.x + 3;
	for (uint8_t i = 0; i < s.segCount && x < right; i++) {
		if (s.segs[i].text[0] == '\0') {
			continue;
		}
		if (i > 0) {
			// A drawn rule rather than a bar character. asciify folds the middle
			// dot Anchor writes inside a segment into a bar, and two different
			// separators that look identical is one separator.
			g.drawFastVLine(x + 1, s.y + 4, s.h - 9, palette[LINE]);
			x += 6;
		}
		ui::clip(s.segs[i].text, x, middle, right - x, s.segs[i].color, palette[SUNKEN],
		         textdatum_t::middle_left);
		x += (int)g.textWidth(s.segs[i].text) + 4;
	}
}

// A reading sitting at the right hand end of a row, and how much of the row it leaves for the
// label. Measured in whatever font the caller has set, which is Font2 at both call sites below:
// Font2 is proportional, so measuring is the only way to know, and a label trimmed to a character
// count would run underneath "0.0412 ETH" and stop short of "$4".
//
// The reading is capped at three fifths of the width rather than given whatever it asks for,
// because a row where the number won is a row with no name on it, and the name is what somebody
// scrolling is reading. Both halves are drawn through ui::clip, so whichever one is over budget
// ends in a period instead of running off the panel.
int readingRoom(const char *value, int width)
{
	if (value == nullptr || value[0] == '\0') {
		return 0;
	}
	const int budget = width * 3 / 5;
	const int measured = (int)ui::gfx().textWidth(value);
	return (measured < budget ? measured : budget) + 6;
}

// Rows on a screen: the surface a page becomes on a device with one screen instead of eight keys,
// and the one this panel exists to draw at the offsite: a list of trending tokens somebody scrolls
// with the arrow keys while the host holds the cursor.
//
// Selection is the host's (it is the only end that knows how many rows survived a filter) and the
// window is this end's, because only this end knows how many rows its rect has room for. Which is
// why this takes a mutable slot: `top` is remembered between frames, exactly as flint's own list
// remembers `pickTop` in src/views/setup.cpp, so a cursor walking down the list scrolls it by one
// row at the bottom edge rather than recentring under the reader's eyes every repaint.
void drawList(Slot &s)
{
	M5GFX &g = ui::gfx();
	// Nothing this function draws may leave the rect the host gave it, and unlike a tile it cannot
	// promise that by arithmetic: a row is 15 pixels whatever the slot is, so a slot ten rows tall
	// holds six of them and a slot ten pixels tall holds most of one. The panel asks the driver to
	// hold the line instead. Every return below clears it, because it is global state on the
	// display and a slot that left it set would trim whatever painted next.
	g.setClipRect(s.x, s.y, s.w, s.h);
	g.fillRect(s.x, s.y, s.w, s.h, palette[GROUND]);

	constexpr int PAD = 4;
	// The cursor lives in a gutter of its own, always reserved, so the labels sit on one left edge
	// whether or not the row they are on is the selected one. A list whose text stepped sideways
	// under the cursor would read as the list moving rather than the cursor.
	constexpr int CURSOR_W = 3;
	// Font0 is six pixels a character, and the four left over are the gap between an icon and the
	// label beside it. At eight they touched.
	constexpr int ICON_W = 10;
	const int rowH = ui::LINE_H;
	const int right = s.x + s.w - PAD;

	if (s.rowCount == 0) {
		// An empty list says why it is empty. When the host did not say, this says that much rather
		// than leaving a rectangle somebody has to guess the meaning of: a blank panel and a panel
		// with nothing to put on it are different states and look identical.
		g.setFont(&fonts::Font2);
		ui::clip(s.caption[0] != '\0' ? s.caption : "nothing to show", s.x + s.w / 2, s.y + s.h / 2,
		         s.w - PAD * 2, palette[INK_DIM], palette[GROUND], textdatum_t::middle_center);
		g.clearClipRect();
		return;
	}

	// How many rows fit, and whether a strip at the bottom has to say where in the list they are.
	// The strip is Font0 rather than a row of its own: a whole 15 pixel row spent on "4 of 23" is a
	// row of the actual list, and on a panel with six of them that is a sixth of the screen.
	constexpr int STRIP_H = 9;
	int visible = (s.h - 1) / rowH;
	const bool windowed = s.total > visible;
	if (windowed) {
		visible = (s.h - 1 - STRIP_H) / rowH;
	}
	if (visible < 1) {
		visible = 1;
	}

	// setup.cpp's three lines: move the window only as far as it takes to keep the cursor inside
	// it. The clamp after them is this file's own, because the host resends the whole list every
	// frame, and a list that got shorter would otherwise leave the window past the end of it.
	if (s.selected >= 0) {
		if (s.selected < s.top) {
			s.top = s.selected;
		} else if (s.selected >= s.top + visible) {
			s.top = (int16_t)(s.selected - visible + 1);
		}
	}
	const int last = s.rowCount - visible;
	if (s.top > last) {
		s.top = (int16_t)(last < 0 ? 0 : last);
	}
	if (s.top < 0) {
		s.top = 0;
	}

	// The selected row's band is painted before any text so that the row below it cannot erase the
	// tail of a descender when it clears its own ground: only one row here has a ground of its own.
	const int cursorRow = s.selected - s.top;
	if (cursorRow >= 0 && cursorRow < visible) {
		const int y = s.y + cursorRow * rowH;
		g.fillRect(s.x, y, s.w, rowH, palette[RAISED]);
		// A bar in the gutter rather than a tone over the row, for drawTile's reason: a row that
		// announced focus by changing colour would be indistinguishable from a row whose reading
		// had gone negative.
		g.fillRect(s.x + 1, y + 1, CURSOR_W, rowH - 2, palette[ACCENT]);
	}

	const int labelX = s.x + PAD + CURSOR_W + (s.iconGutter ? ICON_W : 0);
	for (int i = 0; i < visible; i++) {
		const int index = s.top + i;
		if (index >= s.rowCount) {
			break;
		}
		const Row &r = s.rows[index];
		const bool on = index == s.selected;
		const uint16_t ground = on ? palette[RAISED] : palette[GROUND];
		const int middle = s.y + i * rowH + rowH / 2;

		const uint16_t ink = on ? palette[INK_STRONG] : palette[INK];

		if (s.iconGutter && r.icon[0] != '\0') {
			g.setFont(&fonts::Font0);
			ui::clip(r.icon, s.x + PAD + CURSOR_W + 1, middle, ICON_W,
			         r.hasTone ? r.tone : palette[ACCENT], ground, textdatum_t::middle_left);
		}

		g.setFont(&fonts::Font2);
		const int room = readingRoom(r.value, s.w - PAD * 2);
		ui::clip(r.label, labelX, middle, right - labelX - room, ink, ground,
		         textdatum_t::middle_left);
		if (room > 0) {
			ui::clip(r.value, right, middle, room, r.hasTone ? r.tone : ink, ground,
			         textdatum_t::middle_right);
		}
	}

	if (windowed) {
		// Counted against what the host sent rather than against what this table kept, which is the
		// whole point of tracking `first`: a strip reading "4 of 12" on a list of 23 is a plausible
		// number that is not the number it claims to be.
		char strip[32];
		const int at = s.selected >= 0 ? s.first + s.selected + 1 : s.first + s.top + 1;
		snprintf(strip, sizeof(strip), "%d of %d", at, (int)s.total);
		const int y = s.y + s.h - STRIP_H;
		g.fillRect(s.x, y, s.w, STRIP_H, palette[GROUND]);
		g.drawFastHLine(s.x, y, s.w, palette[LINE]);
		g.setFont(&fonts::Font0);
		ui::clip(strip, right, y + 1, s.w / 2, palette[INK_DIM], palette[GROUND],
		         textdatum_t::top_right);
	}
	g.clearClipRect();
}

// One thing, in full: a title, labelled lines under it, and a footer the contract says is never
// truncated. The surface a row opens into, which is the other half of browsing a list on a device
// whose screen is the only place a reading can go.
void drawDetail(const Slot &s)
{
	M5GFX &g = ui::gfx();
	// Held inside its own rect by the driver, for drawList's reason: the title band is 18 pixels and
	// the footer takes what the sentence needs, neither of which shrinks to fit a slot that is
	// smaller than both.
	g.setClipRect(s.x, s.y, s.w, s.h);
	g.fillRect(s.x, s.y, s.w, s.h, palette[GROUND]);

	constexpr int PAD = 4;
	const int right = s.x + s.w - PAD;
	const int rowH = ui::LINE_H;

	// The footer is measured off the bottom before anything else is laid out, and it takes as many
	// rows as it needs. The contract says this one is never truncated because it is where a card
	// says that approving happens somewhere else, and a panel that cut that sentence in half would
	// be making a different claim about what this device can do. So it costs a line of the reading
	// rather than losing its second half: Font0 is six pixels a character, so a 240 wide slot wraps
	// it at about 38.
	constexpr int FOOT_H = 9;
	constexpr int FOOT_LINES = 3;
	char footer[FOOT_LINES][ui::WRAP_MAX];
	int footCount = 0;
	int bottom = s.y + s.h;
	if (s.caption[0] != '\0') {
		footCount = ui::wrap(s.caption, (s.w - PAD * 2) / 6, footer, FOOT_LINES);
		bottom -= footCount * FOOT_H + 2;
	}

	const int top = s.y + ui::TITLE_H + 1;
	int room = (bottom - top) / rowH;
	if (room < 0) {
		room = 0;
	}
	// What did not fit. Counted against what the host sent rather than against what the wire table
	// kept, so a detail cut short by the screen and one cut short by LINES_MAX say the same true
	// thing. And it is said rather than left to be inferred from a reading that stops early: a
	// number somebody cannot see is survivable, a number somebody does not know exists is how a
	// partial answer gets read as the whole one.
	//
	// It goes in the title band beside the badge rather than on a row of its own, which is not
	// tidiness. A 105 pixel slot holds four of these rows, so spending one on the words "1 more"
	// hides a second line in order to admit to the first, and the panel ends up showing three of
	// five readings to say that it is showing four.
	const int shown = s.lineCount < room ? s.lineCount : room;
	const int missing = (int)s.total - shown;

	// The badge shares the title's band for the same reason: a panel this size has four lines to
	// spend and a one word badge is not worth one of them.
	//
	// Drawn as a filled pill in the warning colour with the ground's ink through it, which is what
	// the same surface is on a Stream Deck (renderDetail in devices/src/svg.ts), and the title is
	// in the strong ink there rather than the accent, so it is in the strong ink here too. A badge
	// is a thing stuck to a name: it has to read as attached to that name on both devices, and it
	// is the one place this file draws a filled shape it did not have to.
	int titleRoom = s.w - PAD * 2;
	g.setFont(&fonts::Font0);
	if (s.badge[0] != '\0') {
		const int width = (int)g.textWidth(s.badge) + 10;
		const int height = 12;
		g.fillRoundRect(right - width, s.y + 3, width, height, height / 2, palette[WARNING]);
		ui::clip(s.badge, right - width / 2, s.y + 3 + height / 2, width - 4, palette[SUNKEN],
		         palette[WARNING], textdatum_t::middle_center);
		titleRoom -= width + 6;
	}
	if (missing > 0) {
		// Quiet ink rather than the warning colour, because the badge beside it is already wearing
		// that and two marks in one band in one colour read as one mark. The claim it makes is
		// small: there is more of this than the panel is showing.
		char more[16];
		snprintf(more, sizeof(more), "+%d", missing);
		ui::clip(more, s.x + PAD + titleRoom, s.y + 5, 28, palette[INK_DIM], palette[GROUND],
		         textdatum_t::top_right);
		titleRoom -= (int)g.textWidth(more) + 6;
	}
	g.setFont(&fonts::Font2);
	ui::clip(s.label, s.x + PAD, s.y + 1, titleRoom, palette[INK_STRONG], palette[GROUND],
	         textdatum_t::top_left);
	g.drawFastHLine(s.x, s.y + ui::TITLE_H - 1, s.w, palette[LINE]);

	if (footCount > 0) {
		g.drawFastHLine(s.x, bottom, s.w, palette[LINE]);
		g.setFont(&fonts::Font0);
		for (int i = 0; i < footCount; i++) {
			ui::clip(footer[i], s.x + PAD, bottom + 2 + i * FOOT_H, s.w - PAD * 2, palette[INK_DIM],
			         palette[GROUND], textdatum_t::top_left);
		}
	}

	for (int i = 0; i < shown; i++) {
		const Line &l = s.lines[i];
		const int middle = top + i * rowH + rowH / 2;
		g.setFont(&fonts::Font2);
		const int reading = readingRoom(l.value, s.w - PAD * 2);
		ui::clip(l.label, s.x + PAD, middle, right - (s.x + PAD) - reading, palette[INK_DIM],
		         palette[GROUND], textdatum_t::middle_left);
		if (reading > 0) {
			ui::clip(l.value, right, middle, reading, l.hasTone ? l.tone : palette[INK],
			         palette[GROUND], textdatum_t::middle_right);
		}
	}
	g.clearClipRect();
}

// Waiting, and every moment before a host has spoken. Not an empty panel, and
// certainly not a plausible looking one: it says what it is and what it wants.
void drawStandby(const char *reason)
{
	M5GFX &g = ui::gfx();
	ui::clearBody(palette[GROUND]);
	g.setFont(&fonts::Font4);
	ui::clip("Anchor", ui::W / 2, 14, ui::W - 12, palette[ACCENT], palette[GROUND],
	         textdatum_t::top_center);
	g.setFont(&fonts::Font2);
	ui::clip(reason, ui::W / 2, 50, ui::W - 12, palette[INK], palette[GROUND],
	         textdatum_t::top_center);
	g.setFont(&fonts::Font0);
	ui::clip("a desktop paints this screen over USB", ui::W / 2, 76, ui::W - 12, palette[INK_DIM],
	         palette[GROUND], textdatum_t::top_center);
	ui::clip("anchor-devices --cardputer", ui::W / 2, 90, ui::W - 12, palette[INK_DIM],
	         palette[GROUND], textdatum_t::top_center);
	ui::clip(FIRMWARE, ui::W / 2, 104, ui::W - 12, palette[LINE], palette[GROUND],
	         textdatum_t::top_center);
}

// The first thing a stranger sees once standalone data is ready: what this is, and where to go
// read the code, before it drops into a grid of ticker symbols that mean nothing without that
// context. A printed card on the table is the reliable way to hand someone a scannable link at
// arm's length — this screen is the on device echo of it, not a substitute for one.
void drawStandaloneIntro()
{
	M5GFX &g = ui::gfx();
	ui::clearBody(palette[GROUND]);
	g.setFont(&fonts::Font4);
	ui::clip("Anchor", ui::W / 2, 14, ui::W - 12, palette[ACCENT], palette[GROUND],
	         textdatum_t::top_center);
	g.setFont(&fonts::Font2);
	// Shorter than it was, because it did not fit. "open source, no wallet on this screen" is
	// thirty-six characters and Font2 gives about thirty-six on a 228 pixel line, so `ui::clip`
	// trimmed the last word and drew "on this scre." — a sentence about not holding a wallet,
	// cut off mid-word, on the screen that is meant to reassure somebody holding a stranger's
	// device. Visible in one screenshot and invisible in the source, which is the whole of
	// AGENTS.md's "do not ship a visual change you have only reasoned about".
	ui::clip("open source, no wallet here", ui::W / 2, 50, ui::W - 12, palette[INK],
	         palette[GROUND], textdatum_t::top_center);
	g.setFont(&fonts::Font0);
	ui::clip("trending tokens, live from OpenSea", ui::W / 2, 76, ui::W - 12, palette[INK_DIM],
	         palette[GROUND], textdatum_t::top_center);
	ui::clip("hack it: github.com/ryanio/anchor", ui::W / 2, 90, ui::W - 12, palette[LINE],
	         palette[GROUND], textdatum_t::top_center);
}

// ------------------------------------------------------------------- browse
//
// Browsing trending tokens with nothing plugged in, which is what this device is for.
//
// AGENTS.md settled it: "The Cardputer and the pulse display are wholly independent devices. The
// cable is for flashing them." This mode was built host side first — the same three facets, the same
// state shape, in `#browseDetail` in devices/src/panel.ts — and it only worked on a cable, which is
// exactly the inconsistency that section was written about. So it lives here now, over
// `standalone.cpp`'s own fetches, and the host path below stays only because the Stream Deck's
// sibling code still reads it.
//
// Two things this deliberately keeps from the host:
//
//   1. **The facets, in that order.** Overview, then Holders, then Activity — decreasing certainty:
//      what the thing is, then who holds it, then what just happened to it.
//   2. **The refusal.** A facet never draws holders or activity belonging to a different token than
//      the one open. `panel.ts`'s `#browseDepth` compares ids for this reason and so does
//      `openFacetRows` below: rows under the wrong name are indistinguishable from rows that are
//      simply wrong, and AGENTS.md puts that failure above every other one here.
//
// And one thing it cannot keep: the host's footer says "esc: back", and escape on this keyboard
// never reaches a view. flint takes a bare backtick before any view sees it — the exit convention,
// "no screen can hold anyone" (src/view.cpp) — so backing out of a facet is backspace here, with
// fn and backtick as the escape this keyboard can actually type. The footer says what the device
// has, not what the other end of a cable had.

constexpr int BROWSE_STRIP_H = 18;
constexpr const char *BROWSE_FACETS[] = {"Overview", "Holders", "Activity"};
constexpr int BROWSE_FACET_COUNT = 3;

// The row somebody is on, the facet they are in, and whether anything is open at all. `browseToken`
// is a *copy*, taken when the row opened: the trending list refreshes underneath this every sixty
// seconds and rows move, so an index would quietly come to mean a different token while its holders
// were still on screen. The copy is re-resolved by address on every frame so its readings stay
// live, and it keeps its own address so the depth check has something stable to compare against.
int browseSel = 0;
int browseFacet = 0;
bool browseOpen = false;
standalone::Token browseToken;

// The body, held across frames rather than built on the stack, because `drawList` keeps its scroll
// position in `Slot::top` and a slot rebuilt every frame is a list that snaps back to the top under
// the reader's eyes on every repaint. Reset deliberately, in `browseReset`, when the thing being
// looked at actually changes.
Slot browseBody;

void browseReset()
{
	browseBody.top = 0;
	browseBody.selected = -1;
	browseBody.rowCount = 0;
	browseBody.lineCount = 0;
	browseBody.total = 0;
	browseBody.first = 0;
	browseBody.caption[0] = '\0';
	browseBody.badge[0] = '\0';
	browseBody.label[0] = '\0';
	browseBody.iconGutter = false;
}

Row &pushRow(Slot &s)
{
	Row &r = s.rows[s.rowCount++];
	memset(&r, 0, sizeof(r));
	return r;
}

// Is this depth actually this token's? The whole safety property, in one line, on purpose.
bool depthIsOurs()
{
	return standalone::sameAddress(standalone::detail().address, browseToken.address);
}

// Why a facet has nothing in it. Never a blank list: a facet empty because the request has not gone
// out yet, one empty because OpenSea refused the key, and one empty because the token genuinely has
// no swaps are three different things and look identical as an empty rectangle.
//
// As the list's caption rather than as a row in it, which is a correction. A row's label is
// twenty-four bytes — a width chosen for "1. 0xabcd..1234" — so "asking OpenSea who holds this"
// reached the glass as "asking OpenSea who hold", a sentence about waiting that was itself cut off.
// The caption is sixty-four and `drawList` centres it across the whole panel in the larger font,
// which is the one place on this screen a sentence has room to be a sentence. The subject is not
// lost by dropping the header row with it: the strip above says which token and which facet.
void setReason(Slot &s, const standalone::State &facet)
{
	s.rowCount = 0;
	takeText(s.caption, sizeof(s.caption), facet.reason);
}

// A facet's first row: which facet this is, what it is about, and how much of it there is. The same
// row `panel.ts`'s `#facetHeader` draws, and it is what keeps the subject on screen inside the list
// itself — a Holders list whose own first row says which token it belongs to cannot be misread as
// another token's, whatever else is on the panel.
void pushHeader(Slot &s, const char *value)
{
	Row &r = pushRow(s);
	char text[32];
	snprintf(text, sizeof(text), "%s %s", BROWSE_FACETS[browseFacet],
	         browseToken.symbol[0] != '\0' ? browseToken.symbol : browseToken.name);
	takeText(r.label, sizeof(r.label), text);
	takeText(r.value, sizeof(r.value), value);
	r.hasTone = true;
	r.tone = palette[ACCENT];
}

void buildTrendingRows(Slot &s, const standalone::State &st)
{
	// The same row the host's browse list draws — label the symbol, value the price, tone the
	// direction of the day. Not the change percentage: that is what Overview is one keypress away
	// for, and a row carrying both is a row with no room for a name.
	for (size_t i = 0; i < standalone::tokenCount && s.rowCount < ROWS_MAX; i++) {
		const standalone::Token &t = standalone::tokens[i];
		Row &r = pushRow(s);
		takeText(r.label, sizeof(r.label), t.symbol[0] != '\0' ? t.symbol : t.name);
		takeText(r.value, sizeof(r.value), t.price);
		r.hasTone = true;
		r.tone = t.changePositive ? palette[POSITIVE] : palette[NEGATIVE];
	}
	s.total = (int16_t)s.rowCount;
	s.first = 0;
	if (s.rowCount == 0) {
		s.selected = -1;
		// drawList centres this when there are no rows, which is the one place a whole sentence
		// fits: six words about why the screen is empty, in the middle of the screen that is empty.
		takeText(s.caption, sizeof(s.caption), st.reason);
		return;
	}
	if (browseSel >= (int)s.rowCount) {
		browseSel = (int)s.rowCount - 1;
	}
	s.selected = (int16_t)browseSel;
}

void buildOverview(Slot &s)
{
	s.kind = KIND_DETAIL;
	char title[32];
	if (browseToken.name[0] != '\0' && browseToken.symbol[0] != '\0') {
		snprintf(title, sizeof(title), "%s (%s)", browseToken.name, browseToken.symbol);
	} else {
		snprintf(title, sizeof(title), "%s",
		         browseToken.symbol[0] != '\0' ? browseToken.symbol : browseToken.name);
	}
	takeText(s.label, sizeof(s.label), title);
	takeText(s.badge, sizeof(s.badge), BROWSE_FACETS[0]);
	// The keys this device actually has, on the surface they act on. A Cardputer handed to somebody
	// at a venue comes with no manual, and neither tab nor backspace is a gesture anyone guesses.
	takeText(s.caption, sizeof(s.caption), "tab: Holders, Activity. del: back");

	// The same four readings `tokenOverviewLines` draws host side, in the same order. A second
	// opinion about what a token's summary is would be how one of the two quietly starts reporting a
	// different volume from the other.
	struct {
		const char *label;
		const char *value;
		bool toned;
	} rows[] = {
	    {"Price", browseToken.price, false},
	    {"24h", browseToken.change, true},
	    {"Volume", browseToken.volume, false},
	    {"Chain", browseToken.chain, false},
	};
	for (const auto &row : rows) {
		if (s.lineCount >= LINES_MAX) {
			break;
		}
		Line &l = s.lines[s.lineCount++];
		memset(&l, 0, sizeof(l));
		takeText(l.label, sizeof(l.label), row.label);
		takeText(l.value, sizeof(l.value), row.value);
		l.hasTone = row.toned;
		l.tone = browseToken.changePositive ? palette[POSITIVE] : palette[NEGATIVE];
	}
	s.total = (int16_t)s.lineCount;
}

void buildHolders(Slot &s)
{
	const standalone::Detail &d = standalone::detail();
	// The refusal, before a single row is read. `d` holds one item's worth of depth, and between
	// opening a second token and its fetch landing it still holds the first token's.
	if (!depthIsOurs()) {
		setReason(s, {standalone::Status::Fetching, "asking OpenSea who holds this"});
		return;
	}
	if (d.holderCount == 0) {
		setReason(s, d.holders);
		return;
	}
	pushHeader(s, d.totals[0] != '\0' ? d.totals : "--");
	if (d.health[0] != '\0') {
		// The API's own judgement of how concentrated the supply is, in its own word, rather than a
		// number this device would have to explain. STRONG, HEALTHY, CONCERNING, BAD.
		Row &r = pushRow(s);
		takeText(r.label, sizeof(r.label), "Distribution");
		takeText(r.value, sizeof(r.value), d.health);
		r.hasTone = true;
		r.tone = palette[INK_DIM];
	}
	for (size_t i = 0; i < d.holderCount && s.rowCount < ROWS_MAX; i++) {
		Row &r = pushRow(s);
		char label[28];
		snprintf(label, sizeof(label), "%d. %s", (int)i + 1, d.holderRows[i].who);
		takeText(r.label, sizeof(r.label), label);
		takeText(r.value, sizeof(r.value), d.holderRows[i].share);
	}
}

void buildActivity(Slot &s)
{
	const standalone::Detail &d = standalone::detail();
	if (!depthIsOurs()) {
		setReason(s, {standalone::Status::Fetching, "asking OpenSea what just traded"});
		return;
	}
	if (d.eventCount == 0) {
		setReason(s, d.activity);
		return;
	}
	// "7 swaps", not "7". A bare number at the right hand end of a header row is a reading with no
	// unit, and this column holds dollars on every other row of every other facet.
	char count[12];
	snprintf(count, sizeof(count), "%d swap%s", (int)d.eventCount, d.eventCount == 1 ? "" : "s");
	pushHeader(s, count);
	for (size_t i = 0; i < d.eventCount && s.rowCount < ROWS_MAX; i++) {
		const standalone::Event &e = d.eventRows[i];
		Row &r = pushRow(s);
		char label[28];
		snprintf(label, sizeof(label), "%s %s", e.side, e.counter);
		takeText(r.label, sizeof(r.label), label);
		takeText(r.value, sizeof(r.value), e.value);
		r.hasTone = true;
		r.tone = e.buy ? palette[POSITIVE] : palette[NEGATIVE];
	}
}

// The strip over the browse body: what is being looked at, or why there is nothing to look at.
//
// Which of those it says is decided by what the body is about to draw, and the rule is that the
// screen never says the same sentence twice. An empty list already carries its reason across the
// middle of the panel, in the largest type on the screen, so a strip repeating it above is noise
// where context should be. A list with rows in it has no room for a reason, so the strip takes it.
// And with a token open the strip is that token — its symbol and the chain it is on — because the
// facet's own header row is already carrying the facet's state.
//
// Forty characters of Font0 is the whole width, which is why the sentence never shares the strip
// with anything.
void drawBrowseStrip(const standalone::State &st, bool bodyHasRows)
{
	Slot s = {};
	s.used = true;
	s.kind = KIND_BAR;
	s.x = 0;
	s.y = 0;
	s.w = ui::W;
	s.h = BROWSE_STRIP_H;
	Seg &first = s.segs[s.segCount++];
	if (browseOpen) {
		takeText(first.text, sizeof(first.text),
		         browseToken.symbol[0] != '\0' ? browseToken.symbol : browseToken.name);
		first.color = palette[ACCENT];
		// Which of the three, always, including while a facet is still empty. A facet that says
		// nothing but "asking OpenSea" is a facet whose name has to come from somewhere.
		Seg &facet = s.segs[s.segCount++];
		takeText(facet.text, sizeof(facet.text), BROWSE_FACETS[browseFacet]);
		facet.color = palette[INK];
		// The price rather than the chain, which Overview already carries as a reading. Somebody two
		// facets deep in a holder list has left every number about the token itself behind, and the
		// price is the one worth keeping in front of them.
		Seg &price = s.segs[s.segCount++];
		takeText(price.text, sizeof(price.text), browseToken.price);
		price.color = palette[INK_DIM];
	} else if (st.status == standalone::Status::Online) {
		takeText(first.text, sizeof(first.text), "trending");
		first.color = palette[ACCENT];
		Seg &how = s.segs[s.segCount++];
		takeText(how.text, sizeof(how.text), st.reason);
		how.color = palette[INK_DIM];
	} else if (bodyHasRows) {
		takeText(first.text, sizeof(first.text), st.reason);
		first.color = st.status == standalone::Status::Failed ? palette[WARNING] : palette[INK_DIM];
	} else {
		takeText(first.text, sizeof(first.text), "trending");
		first.color = palette[ACCENT];
	}
	drawBar(s);
}

// Keep the open token's readings live without letting its identity move. The list is refetched
// every sixty seconds and a row can change position or fall off it entirely; the address is what
// this is matched on, and a token that has left the list keeps the readings it had when it was
// opened rather than picking up whichever token inherited its row.
void refreshBrowseToken()
{
	for (size_t i = 0; i < standalone::tokenCount; i++) {
		if (standalone::sameAddress(standalone::tokens[i].address, browseToken.address)) {
			browseToken = standalone::tokens[i];
			return;
		}
	}
}

void drawBrowse()
{
	const standalone::State st = standalone::state();

	Slot &s = browseBody;
	s.used = true;
	s.x = 0;
	s.y = BROWSE_STRIP_H;
	s.w = ui::W;
	s.h = (int16_t)(ui::BODY_H - BROWSE_STRIP_H);
	s.rowCount = 0;
	s.lineCount = 0;
	s.segCount = 0;
	s.caption[0] = '\0';
	s.badge[0] = '\0';
	s.label[0] = '\0';
	s.iconGutter = false;
	s.total = 0;
	s.first = 0;

	if (!browseOpen) {
		s.kind = KIND_LIST;
		buildTrendingRows(s, st);
		// The body is built before the strip is drawn, because what the strip should say depends on
		// whether the body found anything to say for itself.
		drawBrowseStrip(st, s.rowCount > 0);
		drawList(s);
		return;
	}

	refreshBrowseToken();
	drawBrowseStrip(st, true);
	if (browseFacet == 0) {
		buildOverview(s);
		drawDetail(s);
		return;
	}
	s.kind = KIND_LIST;
	// No cursor on a facet. Nothing in a holder list opens, and a cursor is a promise that it does —
	// the host draws these with no `selected` for the same reason. Up and down still move the
	// window, which `drawList` clamps for us.
	s.selected = -1;
	if (browseFacet == 1) {
		buildHolders(s);
	} else {
		buildActivity(s);
	}
	s.total = (int16_t)s.rowCount;
	s.first = 0;
	drawList(s);
}

// True when this unit is drawing its own screen rather than a desktop's. Past the grace period with
// no host, which is the only thing the cable is still consulted about.
bool browsing()
{
	const uint32_t grace = everLinked ? STANDALONE_GRACE_MS : STANDALONE_COLD_MS;
	return !linked && (millis() - unlinkedSince > grace);
}

// The link has gone: cable out, host asleep, the desktop tool stopped. What is
// on the glass stays on the glass, because a blank screen is indistinguishable
// from a unit that is off, and the strip says how old the reading is. A panel
// that wakes into a confident looking old number is the worst thing a device
// like this can do.
void drawLinkDown()
{
	const Slot &strip = slots[0];
	if (!strip.used) {
		return;
	}
	M5GFX &g = ui::gfx();
	char text[40];
	snprintf(text, sizeof(text), "link down | %us since last frame",
	         (unsigned)((millis() - lastHost) / 1000));
	g.fillRect(strip.x, strip.y, strip.w, strip.h, palette[SUNKEN]);
	g.setFont(&fonts::Font0);
	ui::clip(text, strip.x + 3, strip.y + strip.h / 2, strip.w - 6, palette[WARNING],
	         palette[SUNKEN], textdatum_t::middle_left);
}

// The filter box, drawn over the strip. A view control, not a command line,
// and given no prompt of its own so it cannot be mistaken for one.
void drawQuery()
{
	const Slot &strip = slots[0];
	const int x = strip.used ? strip.x : 0;
	const int y = strip.used ? strip.y : 0;
	const int w = strip.used ? strip.w : ui::W;
	const int h = strip.used ? strip.h : 18;

	M5GFX &g = ui::gfx();
	g.fillRect(x, y, w, h, palette[RAISED]);
	g.setFont(&fonts::Font0);
	ui::clip("filter", x + 3, y + h / 2, 40, palette[ACCENT], palette[RAISED],
	         textdatum_t::middle_left);
	char shown[80];
	snprintf(shown, sizeof(shown), "%s_", queryText);
	ui::clip(shown, x + 44, y + h / 2, w - 47, palette[INK_STRONG], palette[RAISED],
	         textdatum_t::middle_left);
}

// Whether the last `draw()` actually put slots on the glass, so the standby-to-content transition
// gets the one full clear it needs and every ordinary update after it does not.
bool hadContent = false;

void draw()
{
	bool any = false;
	for (const Slot &s : slots) {
		if (s.used) {
			any = true;
			break;
		}
	}
	if (!any) {
		hadContent = false;
		if (browsing()) {
			// No longer gated on there being data. The browse screen explains itself now — no key,
			// no network, joining, fetching, failed, each with its own sentence — and a unit with
			// nothing to show has more need of that screen than a unit with eight tokens on it.
			// Gating on `hasData()` is what used to leave the standby screen up saying "waiting for
			// host" on a unit that was never going to get one.
			if (standaloneIntroUntil != 0 && millis() < standaloneIntroUntil) {
				drawStandaloneIntro();
			} else {
				drawBrowse();
			}
			return;
		}
		drawStandby(linked ? "host connected, no frame yet" : "waiting for host");
		return;
	}

	// An overlay paints outside any slot's own rect, and the first frame after standby has nothing
	// on the glass yet — both need the whole panel cleared. Everything else is a tick that changed
	// zero or a few slots (a clock, a reading), and redrawing the rest is a visible flash bought for
	// nothing: `drawTile`/`drawBar` already clear their own rect before they paint.
	const bool overlay = !linked || queryActive;
	const bool full = !hadContent || overlay;
	if (full) {
		ui::clearBody(palette[GROUND]);
	}
	for (Slot &s : slots) {
		if (!s.used || (!full && !s.dirty)) {
			continue;
		}
		if (s.kind == KIND_TILE) {
			drawTile(s);
		} else if (s.kind == KIND_BAR) {
			drawBar(s);
		} else if (s.kind == KIND_LIST) {
			drawList(s);
		} else if (s.kind == KIND_DETAIL) {
			drawDetail(s);
		}
		s.dirty = false;
	}
	hadContent = true;
	if (!linked) {
		drawLinkDown();
	}
	if (queryActive) {
		drawQuery();
	}
}

// ------------------------------------------------------------------ sending

void send(JsonDocument &doc)
{
	char out[192];
	serializeJson(doc, out, sizeof(out));
	cable::writeLine(out);
}

void sendHello()
{
	JsonDocument doc;
	doc["t"] = "hello";
	doc["proto"] = PROTOCOL_VERSION;
	doc["fw"] = FIRMWARE;
	doc["width"] = ui::W;
	doc["height"] = ui::BODY_H;
	send(doc);
}

// One key, and nothing more. The host decides what a key means against a
// config written before this unit was plugged in.
//
// flint's keyboard layer reports that a key fired rather than tracking it up
// and down, so a press is sent with its release behind it. Without the
// release the host would hold a tile in its pressed state forever.
void sendKey(const char *key, bool shift)
{
	for (int i = 0; i < 2; i++) {
		JsonDocument doc;
		doc["t"] = "key";
		doc["key"] = key;
		doc["down"] = i == 0;
		doc["shift"] = shift;
		send(doc);
	}
}

void reportPower()
{
	const int32_t level = M5.Power.getBatteryLevel();
	const bool charging = M5.Power.isCharging() == m5::Power_Class::is_charging;
	if (level < 0 || (level == sentLevel && charging == sentCharging)) {
		return;
	}
	sentLevel = level;
	sentCharging = charging;
	JsonDocument doc;
	doc["t"] = "power";
	doc["percent"] = level;
	doc["charging"] = charging;
	send(doc);
}

// ---------------------------------------------------------------- receiving

void applyTheme(JsonObjectConst message)
{
	JsonObjectConst tokens = message["tokens"].as<JsonObjectConst>();
	if (tokens.isNull()) {
		return;
	}
	for (uint8_t i = 0; i < TOKEN_COUNT; i++) {
		uint16_t colour;
		if (parseHex(tokens[TOKEN_NAMES[i]] | (const char *)nullptr, colour)) {
			palette[i] = colour;
		}
	}

	// And the chrome around this screen, through flint's `ui::setPalette` seam.
	//
	// Until this line a themed unit was themed in one rectangle: the panel wore whatever Omarchy
	// was wearing and the menu, the status bar and the other views stayed flint's coral against
	// near black, so backing out of Anchor left the theme behind at the edge of its own view. The
	// desktop is already sending a whole scheme rather than the handful of colours this file draws
	// with, so passing it on costs one mapping and no new message.
	//
	// The names map by the job each colour does, not by how they look: flint's `bar` is the status
	// bar's ground and Anchor's nearest is `sunken`, its `panel` is an unselected card and Anchor's
	// is `raised`, and its `accent` is whatever this scheme uses to mean "this one" — which is the
	// field flint deliberately named for the job rather than for coral.
	//
	// setPalette drops a palette equal to the one already up, so a host repeating its theme on every
	// frame does not repaint on every frame.
	ui::Palette chrome;
	chrome.bg = palette[GROUND];
	chrome.fg = palette[INK];
	chrome.dim = palette[INK_DIM];
	chrome.rule = palette[LINE];
	chrome.bar = palette[SUNKEN];
	chrome.panel = palette[RAISED];
	chrome.accent = palette[ACCENT];
	chrome.good = palette[POSITIVE];
	chrome.warn = palette[WARNING];
	chrome.bad = palette[NEGATIVE];
	ui::setPalette(chrome);
}

// A rectangle is clamped to the body before a pixel is written. The status bar
// is flint's and a frame cannot paint over it, however the far end asks.
bool takeRect(JsonObjectConst op, Slot &s)
{
	const int x = op["x"] | -1;
	const int y = op["y"] | -1;
	const int w = op["w"] | 0;
	const int h = op["h"] | 0;
	if (x < 0 || y < 0 || w <= 0 || h <= 0) {
		return false;
	}
	if (x + w > ui::W || y + h > ui::BODY_H) {
		return false;
	}
	s.x = (int16_t)x;
	s.y = (int16_t)y;
	s.w = (int16_t)w;
	s.h = (int16_t)h;
	return true;
}

void applyFrame(JsonObjectConst message)
{
	bool paintedScreen = false;
	bool paintedKey = false;
	// Which way the body was being used before this frame, read before the ops below change it.
	const bool wasScreen = slots[SLOT_SCREEN].used;
	bool wasKeys = false;
	for (int i = SLOT_KEY_0; i < SLOT_SCREEN; i++) {
		wasKeys = wasKeys || slots[i].used;
	}

	for (JsonObjectConst op : message["ops"].as<JsonArrayConst>()) {
		const int index = slotIndex(op["id"] | (const char *)nullptr);
		if (index < 0) {
			continue;
		}
		paintedScreen = paintedScreen || index == SLOT_SCREEN;
		paintedKey = paintedKey || (index >= SLOT_KEY_0 && index < SLOT_SCREEN);
		JsonObjectConst surface = op["s"].as<JsonObjectConst>();
		if (surface.isNull()) {
			continue;
		}
		Slot &s = slots[index];
		Slot next = {};
		if (!takeRect(op, next)) {
			continue;
		}
		next.sel = op["sel"] | false;

		const char *kind = surface["kind"] | "";
		if (strcmp(kind, "tile") == 0) {
			next.kind = KIND_TILE;
			takeText(next.label, sizeof(next.label), surface["label"] | "");
			takeText(next.value, sizeof(next.value), surface["value"] | "");
			takeText(next.badge, sizeof(next.badge), surface["badge"] | "");
			next.tone = tokenColor(surface["tone"] | (const char *)nullptr, palette[INK]);
			const char *emphasis = surface["emphasis"] | "ground";
			next.emphasis = strcmp(emphasis, "active") == 0
			                    ? EM_ACTIVE
			                    : (strcmp(emphasis, "raised") == 0 ? EM_RAISED : EM_GROUND);
			next.hasMeter = surface["meter"].is<float>();
			if (next.hasMeter) {
				const float m = surface["meter"].as<float>();
				next.meter = m < 0.0f ? 0.0f : (m > 1.0f ? 1.0f : m);
			}
		} else if (strcmp(kind, "bar") == 0) {
			next.kind = KIND_BAR;
			for (JsonObjectConst segment : surface["segments"].as<JsonArrayConst>()) {
				if (next.segCount >= SEGS_MAX) {
					break;
				}
				Seg &seg = next.segs[next.segCount];
				takeText(seg.text, sizeof(seg.text), segment["text"] | "");
				seg.color = tokenColor(segment["tone"] | (const char *)nullptr, palette[INK]);
				next.segCount++;
			}
		} else if (strcmp(kind, "list") == 0) {
			next.kind = KIND_LIST;
			JsonArrayConst rows = surface["rows"].as<JsonArrayConst>();
			const int total = (int)rows.size();
			// The host counts its selection against the list it actually has, so a selection past
			// the end of the one that arrived is a frame this end cannot draw honestly: no cursor
			// at all beats a cursor on the wrong row.
			int selected = surface["selected"] | -1;
			if (selected < 0 || selected >= total) {
				selected = -1;
			}

			// Which ROWS_MAX of the host's rows to keep. Anchored on the selection rather than on
			// the front of the list, because the selected row is the one thing a window must never
			// drop: it is what the arrow keys are moving and what the strip counts.
			int first = 0;
			if (total > ROWS_MAX) {
				first = selected < 0 ? 0 : selected - ROWS_MAX / 2;
				if (first > total - ROWS_MAX) {
					first = total - ROWS_MAX;
				}
				if (first < 0) {
					first = 0;
				}
			}

			int index = 0;
			for (JsonObjectConst row : rows) {
				if (index++ < first) {
					continue;
				}
				if (next.rowCount >= ROWS_MAX) {
					break;
				}
				Row &r = next.rows[next.rowCount];
				takeText(r.label, sizeof(r.label), row["label"] | "");
				takeText(r.value, sizeof(r.value), row["value"] | "");
				takeText(r.icon, sizeof(r.icon), row["icon"] | "");
				// The same path a tile's tone takes: a token name resolved against the theme the
				// host sent, never a colour off the wire. What an absent tone means is drawList's
				// to decide, so this only records that it was absent.
				const char *tone = row["tone"] | (const char *)nullptr;
				r.hasTone = tone != nullptr;
				r.tone = tokenColor(tone, palette[INK]);
				if (r.icon[0] != '\0') {
					next.iconGutter = true;
				}
				next.rowCount++;
			}
			next.first = (int16_t)first;
			next.total = (int16_t)total;
			next.selected = selected < 0 ? -1 : (int16_t)(selected - first);
			// The scroll position survives the frame that replaced the rows, which is what makes
			// this a list somebody is reading rather than one that re snaps every time the host
			// repaints. Only when the slot was already a list: the same rect holding a tile a
			// moment ago has no window to keep.
			next.top = s.kind == KIND_LIST ? s.top : 0;
			takeText(next.caption, sizeof(next.caption), surface["empty"] | "");
		} else if (strcmp(kind, "detail") == 0) {
			next.kind = KIND_DETAIL;
			takeText(next.label, sizeof(next.label), surface["title"] | "");
			takeText(next.badge, sizeof(next.badge), surface["badge"] | "");
			takeText(next.caption, sizeof(next.caption), surface["footer"] | "");
			JsonArrayConst lines = surface["lines"].as<JsonArrayConst>();
			// How many the host actually sent, which is not how many this table holds. The panel
			// counts what it could not draw against this rather than against LINES_MAX, so a detail
			// truncated by the wire table and one truncated by the screen say the same true thing.
			next.total = (int16_t)lines.size();
			for (JsonObjectConst line : lines) {
				if (next.lineCount >= LINES_MAX) {
					break;
				}
				Line &l = next.lines[next.lineCount];
				takeText(l.label, sizeof(l.label), line["label"] | "");
				takeText(l.value, sizeof(l.value), line["value"] | "");
				const char *tone = line["tone"] | (const char *)nullptr;
				l.hasTone = tone != nullptr;
				l.tone = tokenColor(tone, palette[INK]);
				next.lineCount++;
			}
		} else {
			// A grid surface, which this geometry never asks for: the panel composes one for a
			// touch screen, and this device has keys. Left blank rather than drawn wrong.
			next.kind = KIND_NONE;
		}
		next.used = true;
		s = next;
		s.dirty = true;
	}

	// The screen and the nine keys are two ways of using the same rectangle, and the host paints
	// one or the other (`page.layout`, and the "never both" note on the screen slot in
	// devices/src/adapters/cardputer.ts). A slot left over from the other way is not a stale
	// reading going quietly out of date: it is pixels on top of, or underneath, the ones that are
	// current. So whichever half this frame painted, the other is dropped here, rather than left
	// for the next full repaint to draw over the top of what somebody is reading.
	//
	// Dropped rather than trusted to be covered, because a browse page paints the body with a list
	// and a key page paints nine tiles that leave the strip's row alone: neither covers the other
	// by construction, only by arithmetic that holds today.
	if (paintedScreen) {
		for (int i = SLOT_KEY_0; i < SLOT_SCREEN; i++) {
			slots[i].used = false;
		}
	} else if (paintedKey) {
		slots[SLOT_SCREEN].used = false;
	}
	// And the changeover gets the one full clear it needs, the same way the standby to content
	// transition does. Without it the body is repainted by whichever slots are dirty, which covers
	// the other layout's pixels only because a screen slot happens to be exactly as big as the nine
	// tiles it replaces. That is arithmetic in somebody else's file: `bodyRect` in
	// devices/src/adapters/cardputer.ts is derived from the tile size for this very reason, and a
	// geometry where it came out a row short would leave a stripe of the old layout on the glass.
	const bool toScreen = paintedScreen && (wasKeys || !wasScreen);
	const bool toKeys = paintedKey && !paintedScreen && wasScreen;
	if (toScreen || toKeys) {
		hadContent = false;
	}
	view::repaint();
}

void handle(const char *text)
{
	JsonDocument doc;
	if (deserializeJson(doc, text) != DeserializationError::Ok) {
		// The boot report and the core's debug output share this port. A line
		// that is not one of ours is not an error.
		return;
	}
	JsonObjectConst message = doc.as<JsonObjectConst>();
	if (message.isNull()) {
		return;
	}

	const bool wasLinked = linked;
	lastHost = millis();
	linked = true;
	everLinked = true;
	if (!wasLinked) {
		view::repaint();
	}

	const char *type = message["t"] | "";
	if (strcmp(type, "hello") == 0) {
		protocolOk = (message["proto"] | 0) == PROTOCOL_VERSION;
		if (!protocolOk) {
			drawStandby("host speaks another protocol");
		}
		return;
	}
	if (strcmp(type, "theme") == 0) {
		applyTheme(message);
		view::repaint();
		return;
	}
	if (strcmp(type, "frame") == 0) {
		if (protocolOk) {
			applyFrame(message);
		}
		return;
	}
	if (strcmp(type, "query") == 0) {
		queryActive = message["active"] | false;
		takeText(queryText, sizeof(queryText), message["text"] | "");
		view::repaint();
		return;
	}
	if (strcmp(type, "backlight") == 0) {
		const int percent = message["percent"] | -1;
		if (percent >= 0 && percent <= 100) {
			ui::gfx().setBrightness((uint8_t)((percent * 255 + 50) / 100));
		}
		return;
	}
	if (strcmp(type, "clear") == 0) {
		for (Slot &s : slots) {
			s.used = false;
		}
		view::repaint();
		return;
	}
}

// -------------------------------------------------------------------- view

void enter()
{
	// Whatever arrived while somebody was in the menu is stale, and the front
	// of it is probably half a line. The port itself was opened at boot, in
	// appBegin below.
	cable::drain();
	for (Slot &s : slots) {
		s.used = false;
	}
	queryActive = false;
	queryText[0] = '\0';
	linked = false;
	everLinked = false;
	protocolOk = true;
	lastHost = millis();
	lastHello = 0;
	unlinkedSince = millis();
	standaloneIntroUntil = 0;
	standaloneIntroShown = false;
	// Back at the trending list, on its first row. Somebody who left this view and came back is
	// starting again; a facet of a token they opened five minutes ago is not where they left off,
	// it is a screen they have to work out.
	browseOpen = false;
	browseSel = 0;
	browseFacet = 0;
	browseReset();
	sentLevel = -1;
	savedBrightness = ui::gfx().getBrightness();
	// The host clears its own per slot cache when a device says hello and
	// repaints every slot, which is what turns opening this view into a full
	// panel rather than whatever changed next.
	sendHello();
}

void leave()
{
	// An open filter must not outlive the screen it was filtering. Escape
	// closes it on the host, and the loop took the key before this view could.
	if (queryActive) {
		sendKey("esc", false);
		queryActive = false;
	}
	ui::gfx().setBrightness(savedBrightness);
}

void tick()
{
	while (cable::readLine(inbox, sizeof(inbox))) {
		handle(inbox);
	}

	const uint32_t now = millis();
	if (linked && now - lastHost > LINK_TIMEOUT_MS) {
		linked = false;
		unlinkedSince = now;
		// A fresh unlink is a fresh stranger's chance too, by the same reasoning enter() resets these.
		standaloneIntroUntil = 0;
		standaloneIntroShown = false;
		view::repaint();
	}
	if (!linked && now - lastHello > HELLO_MS) {
		lastHello = now;
		sendHello();
		view::repaint();
	}
	if (now - lastPower > POWER_MS) {
		lastPower = now;
		reportPower();
	}
	// standalone::tick() rate-limits its own network attempts, so calling it every tick costs
	// nothing on the calls that do not fetch. A repaint fires only when the token list actually
	// changed — not on the ticks in between, which is the same discipline draw()'s dirty-slot
	// tracking already holds the cable-fed path to, for the same reason: a redraw nobody can see a
	// difference in is a flash bought for nothing.
	if (browsing()) {
		// The intro is the first thing a stranger sees, so it runs the moment this unit starts
		// drawing its own screen rather than waiting for data to arrive. It used to wait for
		// `hasData()`, which meant a unit with no key or no network never showed it at all — the one
		// case where somebody most needs to be told what they are holding.
		if (!standaloneIntroShown) {
			standaloneIntroShown = true;
			standaloneIntroUntil = now + STANDALONE_INTRO_MS;
			view::repaint();
		}
		standalone::tick();
		// A repaint when something actually changed, and not on the clock ticks in between: the same
		// discipline draw()'s dirty-slot tracking holds the cable-fed path to. The status is in that
		// list because it is drawn — a screen that said "joining the saved network" after it had
		// joined would be a worse lie than a blank one.
		const standalone::State st = standalone::state();
		if (standalone::tokenCount != lastStandaloneCount || st.status != lastStandaloneStatus ||
		    st.reason != lastStandaloneReason ||
		    standalone::detail().holderCount != lastHolderCount ||
		    standalone::detail().eventCount != lastEventCount ||
		    standalone::detail().holders.reason != lastHoldersReason ||
		    standalone::detail().activity.reason != lastActivityReason) {
			lastStandaloneCount = standalone::tokenCount;
			lastStandaloneStatus = st.status;
			lastStandaloneReason = st.reason;
			lastHolderCount = standalone::detail().holderCount;
			lastEventCount = standalone::detail().eventCount;
			lastHoldersReason = standalone::detail().holders.reason;
			lastActivityReason = standalone::detail().activity.reason;
			view::repaint();
		}
		// Nothing else asks for a repaint on a plain clock tick, so the intro's own end needs its own
		// one-shot: past the deadline, draw()'s guard reads standaloneIntroUntil == 0 as "not in the
		// intro any more" the same way it reads it before the intro has ever started.
		if (standaloneIntroUntil != 0 && now >= standaloneIntroUntil) {
			standaloneIntroUntil = 0;
			view::repaint();
		}
	}
}

// Browsing, with nobody to send a keystroke to.
//
// The mapping mirrors `handle`'s in devices/src/panel.ts as closely as this keyboard allows: enter
// opens the selected row and, on an open one, backs out of it; tab and the left and right arrows
// step the facet and wrap; up and down move. What it cannot mirror is escape — see the note above
// `browseReset` — so backspace backs out, and fn with the backtick (the only escape this keyboard
// can type without leaving the view) does the same.
bool browseKey(const view::Key &k)
{
	const int rows = (int)standalone::tokenCount;

	if (k.enter) {
		if (browseOpen) {
			browseOpen = false;
			standalone::closeDetail();
		} else if (rows > 0 && browseSel < rows) {
			browseToken = standalone::tokens[browseSel];
			// Asked for here, fetched in `standalone::tick()` once the key is back up: a fetch
			// started under a held key is a fetch that eats the next keypress, which is flint's own
			// rule and the reason this only ever records the intent.
			standalone::openDetail((size_t)browseSel);
			browseOpen = true;
			browseFacet = 0;
		}
		browseReset();
		view::repaint();
		return true;
	}

	if (k.del || (k.fn && k.ch == '`')) {
		if (!browseOpen) {
			return false;  // nothing open: let flint have it, so the unit is never stuck here
		}
		browseOpen = false;
		standalone::closeDetail();
		browseReset();
		view::repaint();
		return true;
	}

	if (browseOpen && (k.tab || k.left || k.right)) {
		const int step = (k.tab && k.shift) || k.left ? -1 : 1;
		browseFacet = (browseFacet + step + BROWSE_FACET_COUNT) % BROWSE_FACET_COUNT;
		browseReset();
		view::repaint();
		return true;
	}

	if (k.up || k.down) {
		const int step = k.up ? -1 : 1;
		if (browseOpen) {
			// A facet has no cursor, so the arrows move the window itself. `drawList` clamps it to
			// the rows that exist, which is the same clamp it applies to a host-fed list.
			browseBody.top = (int16_t)(browseBody.top + step);
			if (browseBody.top < 0) {
				browseBody.top = 0;
			}
		} else if (rows > 0) {
			browseSel = (browseSel + step + rows) % rows;
		}
		view::repaint();
		return true;
	}
	return false;
}

bool key(const view::Key &k)
{
	// With no host there is nothing to send a keystroke to, and every key means something here
	// instead. Checked before the cable path rather than after, because a unit at a venue is in this
	// state permanently and the cable path's first act is to write JSON at a port nobody is reading.
	if (browsing()) {
		if (browseKey(k)) {
			return true;
		}
		// Anything the browse mode does not use is not forwarded either. A key press that reaches
		// nothing is better than one that reaches a serial line with no listener on it.
		return false;
	}

	// Fn and slash sends the character rather than the arrow, which is how the
	// filter box opens. Every other key with an arrow printed on it is an
	// arrow here, because that is what it is in every other flint view.
	if (k.fn && k.ch == '/') {
		sendKey("/", k.shift);
		return true;
	}
	if (k.fn && k.ch == '`') {
		sendKey("esc", k.shift);
		return true;
	}
	if (!queryActive) {
		if (k.up) {
			sendKey("up", k.shift);
			return true;
		}
		if (k.down) {
			sendKey("down", k.shift);
			return true;
		}
		if (k.left) {
			sendKey("left", k.shift);
			return true;
		}
		if (k.right) {
			sendKey("right", k.shift);
			return true;
		}
	}
	if (k.enter) {
		sendKey("enter", k.shift);
		return true;
	}
	if (k.del) {
		sendKey("backspace", k.shift);
		return true;
	}
	if (k.tab) {
		sendKey("tab", k.shift);
		return true;
	}
	if (k.ch != 0) {
		const char one[2] = {k.ch, '\0'};
		sendKey(one, k.shift);
		return true;
	}
	return false;
}

const view::View kAnchor = {
    .name = "Anchor",
    // The status bar names where the numbers came from, and here that is a
    // desktop on the other end of the cable rather than a public API.
    .source = "ANCHOR",
    // First in the menu. Written out rather than named in view.h, because a
    // view adds itself and never edits the spine.
    .order = 5,
    // An app pack has no id in flint's generated atlas, so it carries its own
    // bitmap. art.h is generated by flint's own icon tool: see ../README.md.
    .art = &anchorart::ANCHOR,
    .enter = enter,
    .leave = leave,
    .draw = draw,
    .tick = tick,
    .key = key,
};

}  // namespace

VIEW_REGISTER(kAnchor);

// flint calls this once at boot, after every view has registered and before
// the first one opens. Opening the port here rather than in enter() means the
// host is answered from the moment the unit is up, whether or not anybody has
// opened this screen yet, and the banner names the build on the same serial
// line the protocol runs over, so `pio device monitor` says what is flashed.
/*
 * Anchor's own colours, for everything on the unit that is not this view.
 *
 * Taken from the mark in `site/brand/favicon.svg`: #06131a ground, #5fd4e4 accent, #0d6b80 for the
 * quieter structural tones, #f7fafb ink. The same scheme the site and the tray icon wear.
 *
 * This exists because of the order things happen in. The live Omarchy theme reaches this firmware
 * over the cable and is applied in `applyTheme`, which runs from this view's `tick` — and `tick`
 * only runs while this view is open. A unit that boots into the menu (which it now does, with three
 * views registered) therefore sat in flint's coral-on-black until somebody opened Anchor once, so
 * the first thing a new unit showed was the wrong brand entirely.
 *
 * So the palette is set once at boot, before any view opens, and the desktop's theme replaces it the
 * moment one arrives. Anchor-branded is the right thing to fall back to: it is what this unit is,
 * and a unit with no host attached at an offsite will never receive a theme at all.
 */
void applyBrandPalette()
{
	ui::Palette brand;
	brand.bg = ui::rgb565(0x06, 0x13, 0x1a);
	brand.fg = ui::rgb565(0xf7, 0xfa, 0xfb);
	brand.dim = ui::rgb565(0x7f, 0x9b, 0xa4);
	brand.rule = ui::rgb565(0x0d, 0x3b, 0x47);
	brand.bar = ui::rgb565(0x04, 0x0d, 0x12);
	brand.panel = ui::rgb565(0x0a, 0x21, 0x2a);
	brand.accent = ui::rgb565(0x5f, 0xd4, 0xe4);
	brand.good = ui::rgb565(0x3d, 0xdc, 0x84);
	brand.warn = ui::rgb565(0xff, 0xb0, 0x20);
	brand.bad = ui::rgb565(0xff, 0x53, 0x70);
	ui::setPalette(brand);
}

void view::appBegin()
{
	applyBrandPalette();
	cable::begin();
	Serial.printf("app: %s, protocol %d\n", FIRMWARE, PROTOCOL_VERSION);
}
