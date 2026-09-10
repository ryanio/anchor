#include <ArduinoJson.h>

#include <stdio.h>
#include <string.h>

#include "art.h"
#include "cable.h"
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

// One strip and nine tiles, which is what the host's Cardputer geometry sends.
// Held as a fixed table rather than a map so a frame allocates nothing.
constexpr int SLOTS = 10;
constexpr int SEGS_MAX = 6;

enum Kind : uint8_t { KIND_NONE, KIND_TILE, KIND_BAR };
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

const char *const TOKEN_NAMES[TOKEN_COUNT] = {"ground",  "raised",    "sunken",   "ink",
                                              "inkDim",  "inkStrong", "accent",   "positive",
                                              "negative", "warning",  "line"};

// flint's own palette until the host sends one. Not a guess at Anchor's
// colours: this view holds none of its own, and until a theme arrives it wears
// the firmware it is running inside.
uint16_t palette[TOKEN_COUNT] = {ui::BG,   ui::PANEL, ui::BG,   ui::FG,  ui::DIM, ui::FG,
                                 ui::CORAL, ui::GOOD, ui::BAD,  ui::WARN, ui::RULE};

struct Seg {
	char text[26];
	uint16_t color;
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

	char label[24];
	char value[16];
	char badge[8];
	uint16_t tone;
	uint8_t emphasis;
	bool hasMeter;
	float meter;

	Seg segs[SEGS_MAX];
	uint8_t segCount;
};

Slot slots[SLOTS];

char inbox[cable::MAX_LINE + 1];

bool linked = false;
bool protocolOk = true;
uint32_t lastHost = 0;
uint32_t lastHello = 0;
uint32_t lastPower = 0;
int32_t sentLevel = -1;
bool sentCharging = false;

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
		return 0;
	}
	if (strncmp(id, "key:", 4) == 0 && id[4] >= '0' && id[4] <= '8' && id[5] == '\0') {
		return 1 + (id[4] - '0');
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
		ui::clip(s.value, s.x + s.w / 2, s.y + 3,
		         inner, s.emphasis == EM_ACTIVE ? palette[INK_STRONG] : palette[INK], fill,
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
	for (JsonObjectConst op : message["ops"].as<JsonArrayConst>()) {
		const int index = slotIndex(op["id"] | (const char *)nullptr);
		if (index < 0) {
			continue;
		}
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
		} else {
			// A list or a detail surface, which this geometry never asks for.
			// Left blank rather than drawn wrong.
			next.kind = KIND_NONE;
		}
		next.used = true;
		s = next;
		s.dirty = true;
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
	protocolOk = true;
	lastHost = millis();
	lastHello = 0;
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
}

bool key(const view::Key &k)
{
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
void view::appBegin()
{
	cable::begin();
	Serial.printf("app: %s, protocol %d\n", FIRMWARE, PROTOCOL_VERSION);
}
