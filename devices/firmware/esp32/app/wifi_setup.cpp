#include "wifi_setup.h"

#include <Preferences.h>
#include <WiFi.h>

namespace wifi_setup {

namespace {

/*
 * Timing. Both are "how long before this module decides for itself", never a block: `tick()`
 * returns immediately every pass regardless, and these are read against `millis()` deltas.
 *
 * GRACE_MS mirrors the Cardputer's STANDALONE_GRACE_MS in spirit — long enough that a host mid-boot
 * is never pre-empted by a screen it didn't ask for, short enough that a unit with nothing saved
 * doesn't sit on a black panel for a worrying length of time.
 */
constexpr uint32_t GRACE_MS = 5000;
constexpr uint32_t BG_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 20000;

/* Top-left 64x64 is the re-open gesture; top-right 64x64 is cancel on every screen that has one. */
constexpr int16_t CORNER_ZONE_PX = 64;
constexpr int CORNER_TAPS_NEEDED = 5;
constexpr uint32_t CORNER_WINDOW_MS = 3000;

/*
 * The rounded-corner clearance `sensors/sensors.ino` measured by eye: this panel's addressable
 * framebuffer runs past the glass at the top-left, so anything read starts here rather than at 0.
 */
constexpr int16_t LEFT_MARGIN = 20;

constexpr size_t SSID_MAX = 32;
constexpr size_t PASSPHRASE_MAX = 63;

/* Clearly not black, clearly not a password field: the same tone `app.ino` waits on before a host
 * has sent a first frame, reused here for the same reason — a flat fill that cannot be mistaken for
 * content. Key backgrounds use it too, so the keyboard reads as one surface rather than a patchwork.
 */
constexpr uint16_t BG = 0x2124;
constexpr uint16_t KEY_BG = 0x39C7;
constexpr uint16_t KEY_BORDER = 0x528A;

/*
 * How many networks are kept, and how many are shown. They are the same number on purpose.
 *
 * They were 8 and 6, and nothing scrolls: `pickScroll` is read in three places and assigned zero in
 * two of them, so entries seven and eight were collected, sorted, and then unreachable — a list
 * that silently held two networks nobody could pick. Six rows is what the panel has room for
 * between the title and the controls, so six is what `collectScan` keeps.
 */
constexpr int MAX_LISTED = 6;
constexpr int DISPLAY_ROWS = MAX_LISTED;

enum class State : uint8_t { Idle, Picking, Typing, Connecting };

/* Which characters a key press produces. Rendered large on purpose — a compact five-row phone
 * keyboard is illegible at this panel's 322ppi and a fussy keyboard nobody can read is worse than a
 * fussy keyboard that at least shows what it typed. */
constexpr const char *PAGE_LOWER[3] = {"qwertyuiop", "asdfghjkl", "zxcvbnm"};
constexpr const char *PAGE_UPPER[3] = {"QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"};
constexpr const char *PAGE_SYMBOLS[3] = {"1234567890", "-_/:;()$&@", "\"*+.,?!'#"};

Arduino_CO5300 *gfx_ = nullptr;
uint16_t W_ = 0;
uint16_t H_ = 0;

State state = State::Idle;
bool everDecided = false;
uint32_t bootAt = 0;

Preferences prefs;
bool haveSavedCreds = false;
String savedSsid;
String savedPass;

/* Scanning / picking. */
struct Net {
	String ssid;
	int32_t rssi;
	bool open;
};
Net nets[MAX_LISTED];
int netCount = 0;
int pickScroll = 0;
bool scanning = false;
uint32_t lastSpin = 0;
int spinFrame = 0;

/* Typing. */
bool typingSsid = false;
String targetSsid;
bool targetOpen = false;
String entry;
int page = 0;  // 0 lower, 1 upper, 2 symbols
bool reveal = false;

/* Connecting. */
String connectingSsid;
/*
 * The passphrase this join was actually made with.
 *
 * Kept separately from `entry` because they are not the same thing and a run in `sim/` proved it:
 * `entry` is whatever is in the keyboard's buffer now, which survives a cancel back to the network
 * list. Type three characters for one network, back out, tap an *open* one, and the unit joins with
 * no passphrase — `WiFi.begin(ssid)` — and then saved those three characters as that network's
 * password. The next boot replays a credential that was never the one that worked.
 */
String connectingPass;
uint32_t connectStartedAt = 0;
bool connectResultKnown = false;
bool connectSucceeded = false;

/* The corner-tap gesture that reopens setup with a network already saved. */
uint32_t cornerTapTimes[CORNER_TAPS_NEEDED];
int cornerTapCount = 0;

bool inZone(int x, int y, int zx, int zy, int zw, int zh) {
	return x >= zx && x < zx + zw && y >= zy && y < zy + zh;
}

/* -------------------------------------------------------------------------------- drawing ---- */

void clearScreen() {
	gfx_->fillScreen(BG);
}

/*
 * `bg` is a parameter because the glcd font draws its own background.
 *
 * Every character is a 6x8 cell filled with `textbgcolor` behind the glyph, so text centred over
 * the screen ground with `KEY_BG` behind it paints a key-coloured rectangle around itself on a
 * screen with no key there. It defaults to the key colour because most callers are labelling a key;
 * the ones that are not say so, and `sim/` is where the stray rectangles behind "connecting" and
 * "join failed" were visible for the first time.
 */
void centerText(int x, int y, int w, int h, const char *s, uint8_t size, uint16_t color,
                uint16_t bg = KEY_BG) {
	const int charW = 6 * size;
	const int charH = 8 * size;
	const int textW = (int)strlen(s) * charW;
	const int tx = x + (w - textW) / 2;
	const int ty = y + (h - charH) / 2;
	gfx_->setTextSize(size);
	gfx_->setTextColor(color, bg);
	gfx_->setCursor(tx < x ? x : tx, ty < y ? y : ty);
	gfx_->print(s);
}

void drawKey(int x, int y, int w, int h, const char *label, uint8_t size) {
	gfx_->fillRoundRect(x + 2, y + 2, w - 4, h - 4, 6, KEY_BG);
	gfx_->drawRoundRect(x + 2, y + 2, w - 4, h - 4, 6, KEY_BORDER);
	centerText(x, y, w, h, label, size, RGB565_WHITE);
}

void drawCancelCorner() {
	gfx_->fillRoundRect((int)W_ - CORNER_ZONE_PX + 8, 8, CORNER_ZONE_PX - 16, CORNER_ZONE_PX - 16, 6,
	                     KEY_BG);
	centerText((int)W_ - CORNER_ZONE_PX, 0, CORNER_ZONE_PX, CORNER_ZONE_PX, "X", 2, RGB565_YELLOW);
}

/*
 * The title, truncated to the room it actually has.
 *
 * Arduino_GFX wraps rather than clips, so a title one character too long does not run off the edge
 * — it drops onto the next line, over whatever is drawn there. A 32 character SSID is 384px at text
 * size 2 against a 368px panel, and `sim/` photographed exactly that: the name of the network
 * broken across two lines on the connecting screen. Shorter names had a quieter version of the same
 * fault, running under the cancel key in the top right, which is drawn first and therefore lost.
 *
 * So the room is computed here, once, from the panel's own width less the margin and the corner the
 * cancel key occupies — rather than at each call site, where it was a per-screen guess about a
 * different string each time and wrong on all three.
 */
void drawTitle(const char *s) {
	const int charW = 6 * 2;
	const int maxChars = ((int)W_ - LEFT_MARGIN - CORNER_ZONE_PX) / charW;
	char shown[64];
	const int n = (int)strlen(s);
	if (n <= maxChars || maxChars < 3 || maxChars > (int)sizeof(shown) - 1) {
		snprintf(shown, sizeof(shown), "%s", s);
	} else {
		snprintf(shown, sizeof(shown), "%.*s..", maxChars - 2, s);
	}
	gfx_->setTextSize(2);
	gfx_->setTextColor(RGB565_WHITE, BG);
	gfx_->setCursor(LEFT_MARGIN, 16);
	gfx_->print(shown);
}

/*
 * Keyboard geometry lives in one place so hit-testing and drawing can never disagree, the same
 * argument `svg.gridCellAt` makes on the host side for the tap grid.
 *
 * The rows are as tall as the panel allows, which is the whole point of the number.
 *
 * At 52 the four rows ended around y=304 and left the bottom third of a 448px panel black — dead
 * glass above a keyboard whose keys were the thing hardest to hit. 84 spends all of it: four rows
 * from 96 reach 432, and the 16 left over is the rounded corner's clearance, the same allowance
 * `LEFT_MARGIN` makes sideways. Key *width* is fixed by the ten columns a QWERTY row needs (about
 * 36px, roughly 3mm on this 322ppi glass) and cannot be helped without splitting the alphabet
 * across pages; height is the axis that was free, and a 7mm target is far nearer the 9-10mm
 * `TOUCH_TARGET_PX` is derived from than a 4mm one. Seen in `sim/`, not reasoned about.
 */
constexpr int KB_TOP = 96;
constexpr int KB_ROW_H = 84;

int rowKeyCount(int row) {
	const char *const *p = page == 0 ? PAGE_LOWER : page == 1 ? PAGE_UPPER : PAGE_SYMBOLS;
	return (int)strlen(p[row]);
}

char rowKeyChar(int row, int col) {
	const char *const *p = page == 0 ? PAGE_LOWER : page == 1 ? PAGE_UPPER : PAGE_SYMBOLS;
	return p[row][col];
}

void drawKeyboard() {
	char label[2] = {0, 0};
	for (int row = 0; row < 3; row++) {
		const int n = rowKeyCount(row);
		const int keyW = (int)W_ / n;
		const int y = KB_TOP + row * KB_ROW_H;
		for (int col = 0; col < n; col++) {
			label[0] = rowKeyChar(row, col);
			drawKey(col * keyW, y, keyW, KB_ROW_H, label, 3);
		}
	}
	const int controlY = KB_TOP + 3 * KB_ROW_H;
	const int controlW = (int)W_ / 4;
	drawKey(0, controlY, controlW, KB_ROW_H, page == 0 ? "ABC" : page == 1 ? "123" : "abc", 2);
	drawKey(controlW, controlY, controlW, KB_ROW_H, "SPACE", 1);
	drawKey(controlW * 2, controlY, controlW, KB_ROW_H, "DEL", 2);
	drawKey(controlW * 3, controlY, controlW, KB_ROW_H, "JOIN", 2);
}

void drawEntryField() {
	gfx_->fillRoundRect(LEFT_MARGIN, 40, (int)W_ - LEFT_MARGIN * 2, 36, 6, KEY_BG);
	gfx_->drawRoundRect(LEFT_MARGIN, 40, (int)W_ - LEFT_MARGIN * 2, 36, 6, KEY_BORDER);
	char shown[PASSPHRASE_MAX + 2];
	if (!typingSsid && !reveal) {
		const size_t n = entry.length() < PASSPHRASE_MAX ? entry.length() : PASSPHRASE_MAX;
		memset(shown, '*', n);
		shown[n] = '\0';
	} else {
		snprintf(shown, sizeof(shown), "%s", entry.c_str());
	}
	strlcat(shown, "_", sizeof(shown));
	/*
	 * The tail, not the head: a field with the cursor at the end shows the end.
	 *
	 * The field is 312px of usable width, which is 26 characters at text size 2, and a WPA2
	 * passphrase may be 63. The overflow does not stop at the edge — it wraps onto the keyboard,
	 * because that is what `Arduino_GFX::write` does — so a long passphrase used to paint itself
	 * across the top row of keys. Showing the last 26 characters keeps the cursor and the last
	 * keystroke visible, which is the part somebody typing is actually looking at.
	 */
	const int maxChars = ((int)W_ - LEFT_MARGIN * 2 - 16) / (6 * 2);
	const int length = (int)strlen(shown);
	const char *tail = (maxChars > 0 && length > maxChars) ? shown + (length - maxChars) : shown;
	gfx_->setTextSize(2);
	gfx_->setTextColor(RGB565_WHITE, KEY_BG);
	gfx_->setCursor(LEFT_MARGIN + 8, 48);
	gfx_->print(tail);
}

void drawPicking() {
	clearScreen();
	drawTitle(scanning ? "Scanning..." : netCount > 0 ? "Pick a network" : "No networks found");
	drawCancelCorner();

	if (scanning) {
		const char *frames[4] = {".", "..", "...", "...."};
		centerText(0, 60, (int)W_, 30, frames[spinFrame % 4], 2, RGB565_CYAN, BG);
		return;
	}

	const int rowH = 48;
	const int top = 64;
	const int shown = netCount - pickScroll < DISPLAY_ROWS ? netCount - pickScroll : DISPLAY_ROWS;
	for (int i = 0; i < shown; i++) {
		const Net &net = nets[pickScroll + i];
		const int y = top + i * rowH;
		gfx_->fillRoundRect(LEFT_MARGIN, y, (int)W_ - LEFT_MARGIN * 2, rowH - 6, 6, KEY_BG);
		gfx_->setTextSize(2);
		gfx_->setTextColor(RGB565_WHITE, KEY_BG);
		gfx_->setCursor(LEFT_MARGIN + 8, y + 12);
		char text[40];
		String name = net.ssid.length() > 16 ? net.ssid.substring(0, 15) + ".." : net.ssid;
		snprintf(text, sizeof(text), "%s%s", net.open ? "" : "* ", name.c_str());
		gfx_->print(text);
	}

	const int controlsY = top + DISPLAY_ROWS * rowH + 6;
	const int controlW = (int)W_ / 2;
	drawKey(0, controlsY, controlW, 44, "RESCAN", 2);
	drawKey(controlW, controlsY, controlW, 44, "TYPE NAME", 2);
}

void drawTyping() {
	clearScreen();
	if (typingSsid) {
		drawTitle("Network name");
	} else {
		String label = targetSsid.length() > 18 ? targetSsid.substring(0, 17) + ".." : targetSsid;
		char text[40];
		snprintf(text, sizeof(text), "Password: %s", label.c_str());
		drawTitle(text);
	}
	drawCancelCorner();
	drawEntryField();
	drawKeyboard();
}

void drawConnecting() {
	clearScreen();
	drawTitle(connectingSsid.c_str());
	if (!connectResultKnown) {
		centerText(0, 90, (int)W_, 40, "connecting", 2, RGB565_CYAN, BG);
		const char *frames[4] = {".", "..", "...", "...."};
		centerText(0, 130, (int)W_, 30, frames[spinFrame % 4], 2, RGB565_CYAN, BG);
		return;
	}
	if (connectSucceeded) {
		centerText(0, 90, (int)W_, 40, "connected", 2, RGB565_GREEN, BG);
		centerText(0, 130, (int)W_, 30, WiFi.localIP().toString().c_str(), 2, RGB565_WHITE, BG);
		centerText(0, 200, (int)W_, 30, "saved on this unit", 1, RGB565_WHITE, BG);
	} else {
		centerText(0, 90, (int)W_, 40, "join failed", 2, RGB565_RED, BG);
		centerText(0, 130, (int)W_, 30, "check the password", 1, RGB565_WHITE, BG);
		const int controlW = (int)W_ / 2;
		drawKey(0, 220, controlW, 48, "TRY AGAIN", 2);
		drawKey(controlW, 220, controlW, 48, "CANCEL", 2);
	}
}

void draw() {
	switch (state) {
		case State::Picking:
			drawPicking();
			break;
		case State::Typing:
			drawTyping();
			break;
		case State::Connecting:
			drawConnecting();
			break;
		default:
			break;
	}
}

/* --------------------------------------------------------------------------------- actions ---- */

void loadCredentials() {
	prefs.begin("anchor-wifi", true);
	savedSsid = prefs.getString("ssid", "");
	savedPass = prefs.getString("pass", "");
	prefs.end();
	haveSavedCreds = savedSsid.length() > 0;
}

void saveCredentials(const String &ssid, const String &pass) {
	prefs.begin("anchor-wifi", false);
	prefs.putString("ssid", ssid);
	prefs.putString("pass", pass);
	prefs.end();
	haveSavedCreds = true;
	savedSsid = ssid;
	savedPass = pass;
}

void abortToIdle() {
	state = State::Idle;
	scanning = false;
	netCount = 0;
	pickScroll = 0;
	entry = "";
	reveal = false;
	// Nothing left to show: a host that just linked repaints within its own next frame and manages
	// brightness itself; a cancelled setup with no host has nothing true to display, and a lit,
	// stale keyboard screen is exactly the "half-true" picture `sink_blank` exists to avoid elsewhere.
	gfx_->fillScreen(RGB565_BLACK);
	gfx_->setBrightness(0);
}

void startScan() {
	// The one place backlight is forced up: every path into Setup — first boot with nothing saved,
	// a failed background reconnect, or the corner-tap gesture — runs through here. Without this a
	// unit that has never had a host attach sits behind a backlight left at 0 by `setup()`, showing
	// nothing at all rather than the screen it is about to draw.
	gfx_->setBrightness(178);  // 70%, app.ino's own default
	WiFi.mode(WIFI_STA);
	WiFi.scanDelete();
	WiFi.scanNetworks(true /* async */);
	scanning = true;
	netCount = 0;
	pickScroll = 0;
	state = State::Picking;
}

/* Strongest first. A hidden network has no name to show, so it is skipped rather than listed as
 * blank — "type name" is the path for one of those. */
void collectScan() {
	const int16_t n = (int16_t)WiFi.scanComplete();
	if (n == WIFI_SCAN_RUNNING) return;
	scanning = false;
	netCount = 0;
	if (n <= 0) return;
	for (int16_t i = 0; i < n; i++) {
		String ssid = WiFi.SSID(i);
		if (ssid.isEmpty()) continue;
		Net candidate = {ssid, WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN};
		/*
		 * Once the list is full the weakest goes, rather than the loop stopping.
		 *
		 * It used to stop — `i < n && netCount < MAX_LISTED` — which sorted the first six results
		 * the radio happened to return and dropped every one after them, strength notwithstanding.
		 * On a quiet desk the two are the same list; in a building with thirty access points the
		 * comment above this function was simply false, and the network somebody is standing next
		 * to can be the one that is missing.
		 */
		if (netCount == MAX_LISTED) {
			if (nets[MAX_LISTED - 1].rssi >= candidate.rssi) continue;
			netCount--;
		}
		int slot = netCount++;
		while (slot > 0 && nets[slot - 1].rssi < candidate.rssi) {
			nets[slot] = nets[slot - 1];
			slot--;
		}
		nets[slot] = candidate;
	}
	WiFi.scanDelete();
}

void beginTyping(const String &ssid, bool forSsid, bool open) {
	targetSsid = ssid;
	targetOpen = open;
	typingSsid = forSsid;
	entry = "";
	reveal = false;
	page = 0;
	state = State::Typing;
}

void startConnecting(const String &ssid, const String &pass, bool open) {
	connectingSsid = ssid;
	connectingPass = pass;
	// What TRY AGAIN has to know. Reached from the network list this was never set, so a failed join
	// on an open network offered a passphrase screen for a network that does not want one.
	targetSsid = ssid;
	targetOpen = open;
	connectStartedAt = millis();
	connectResultKnown = false;
	connectSucceeded = false;
	state = State::Connecting;
	WiFi.mode(WIFI_STA);
	if (pass.isEmpty()) {
		WiFi.begin(ssid.c_str());
	} else {
		WiFi.begin(ssid.c_str(), pass.c_str());
	}
}

/* ------------------------------------------------------------------------------------ tick ---- */

void tickPicking() {
	if (scanning) {
		collectScan();
	}
	if (millis() - lastSpin > 220) {
		lastSpin = millis();
		spinFrame++;
	}
}

void tickConnecting() {
	if (connectResultKnown) return;
	const wl_status_t st = WiFi.status();
	if (st == WL_CONNECTED) {
		connectResultKnown = true;
		connectSucceeded = true;
		// Only persisted once a connection is actually proven — the measurement AGENTS.md asks for,
		// not the assumption that typing "Join" means it worked.
		saveCredentials(connectingSsid, connectingPass);
		return;
	}
	/*
	 * A refusal is an answer, and it arrives long before the timeout.
	 *
	 * `WL_CONNECT_FAILED` is what the core reports when the AP rejects the passphrase — seconds,
	 * not twenty of them — and this used to ignore it and sit on the timeout regardless, so the one
	 * mistake this screen exists to let somebody correct took twenty seconds to be told about. The
	 * simulator's failure case is what surfaced it: the radio said no at two seconds and the panel
	 * spun until the run ended.
	 *
	 * Only this status, and not `WL_DISCONNECTED` or `WL_NO_SSID_AVAIL`: both appear transiently
	 * while the station is still trying, and treating either as final would report a failure over a
	 * join that was about to succeed. The timeout still covers everything that never resolves.
	 */
	if (st == WL_CONNECT_FAILED || millis() - connectStartedAt > CONNECT_TIMEOUT_MS) {
		connectResultKnown = true;
		connectSucceeded = false;
		return;
	}
	if (millis() - lastSpin > 220) {
		lastSpin = millis();
		spinFrame++;
	}
}

}  // namespace

void begin(Arduino_CO5300 *gfx, uint16_t width, uint16_t height) {
	gfx_ = gfx;
	W_ = width;
	H_ = height;
	bootAt = millis();
	loadCredentials();
	if (haveSavedCreds) {
		WiFi.mode(WIFI_STA);
		WiFi.begin(savedSsid.c_str(), savedPass.c_str());
	}
}

bool active() {
	return state != State::Idle;
}

void tick(bool hostLinked) {
	// No panel means `begin()` was never called (see `app.ino`'s "nopanel" id) — nothing here can
	// draw, and `startScan()` dereferencing a null `gfx_` would be a second failure worse than the
	// first. `handleTouch`'s corner gesture is guarded the same way, for the same reason.
	if (gfx_ == nullptr) return;
	if (hostLinked) {
		if (state != State::Idle) abortToIdle();
		return;
	}

	if (state == State::Idle && !everDecided) {
		const uint32_t elapsed = millis() - bootAt;
		if (!haveSavedCreds) {
			if (elapsed > GRACE_MS) {
				everDecided = true;
				startScan();
				draw();
			}
		} else {
			const bool resolved = WiFi.status() == WL_CONNECTED || elapsed > BG_CONNECT_TIMEOUT_MS;
			if (resolved) {
				everDecided = true;
				if (WiFi.status() != WL_CONNECTED) {
					startScan();
					draw();
				}
				// Connected quietly in the background: nothing to show without a standalone
				// renderer, and building one is a separate decision — see wifi_setup.h.
			}
		}
	}

	const State before = state;
	const int beforeSpin = spinFrame;
	const bool wasScanning = scanning;
	const bool hadResult = connectResultKnown;
	switch (state) {
		case State::Picking:
			tickPicking();
			break;
		case State::Connecting:
			tickConnecting();
			break;
		default:
			break;
	}
	/*
	 * Redraw when a spinner frame advanced, a scan finished, or a connect result just landed —
	 * never on every pass, so this does not repaint at loop() speed for nothing to look at.
	 *
	 * `connectResultKnown` is in that list because it was *missing* from it, and the simulator
	 * caught it on the first realistic run: `tickConnecting()` records the result and returns
	 * without touching the state, the spinner or the scan flag, so none of the three conditions
	 * fired and nothing ever repainted. The unit joined the network, wrote the credentials to NVS,
	 * and went on showing "connecting" with a frozen spinner for as long as anyone watched — and
	 * the failure case was worse, because `onConnectingTap` accepts TRY AGAIN and CANCEL at
	 * coordinates where nothing had been drawn. See `sim/` for the run that found it.
	 */
	if (state != before || spinFrame != beforeSpin || wasScanning != scanning ||
	    connectResultKnown != hadResult) {
		draw();
	}
}

namespace {

void onPickingTap(int x, int y) {
	if (inZone(x, y, (int)W_ - CORNER_ZONE_PX, 0, CORNER_ZONE_PX, CORNER_ZONE_PX)) {
		abortToIdle();
		return;
	}
	if (scanning) return;

	const int rowH = 48;
	const int top = 64;
	const int shown = netCount - pickScroll < DISPLAY_ROWS ? netCount - pickScroll : DISPLAY_ROWS;
	if (y >= top && y < top + shown * rowH) {
		const int i = pickScroll + (y - top) / rowH;
		if (i < netCount) {
			const Net &net = nets[i];
			if (net.open) {
				startConnecting(net.ssid, "", true);
			} else {
				beginTyping(net.ssid, false, false);
			}
			draw();
			return;
		}
	}
	const int controlsY = top + DISPLAY_ROWS * rowH + 6;
	if (y >= controlsY && y < controlsY + 44) {
		if (x < (int)W_ / 2) {
			startScan();
		} else {
			beginTyping("", true, false);
		}
		draw();
	}
}

void onTypingTap(int x, int y) {
	if (inZone(x, y, (int)W_ - CORNER_ZONE_PX, 0, CORNER_ZONE_PX, CORNER_ZONE_PX)) {
		state = State::Picking;
		draw();
		return;
	}
	if (y < KB_TOP) return;  // title / entry field: not tappable

	const size_t limit = typingSsid ? SSID_MAX : PASSPHRASE_MAX;
	if (y < KB_TOP + 3 * KB_ROW_H) {
		const int row = (y - KB_TOP) / KB_ROW_H;
		const int n = rowKeyCount(row);
		const int keyW = (int)W_ / n;
		int col = x / keyW;
		if (col >= n) col = n - 1;
		if (entry.length() < limit) entry += rowKeyChar(row, col);
		draw();
		return;
	}

	/*
	 * The control row ends where it is drawn.
	 *
	 * Without this the test was "below the letters", and the letters end 144px above the bottom of a
	 * 448px panel — so a third of the glass, all of it blank, fired JOIN or DEL depending only on
	 * where across it a hand landed. A tap at (320, 420) started a join in `sim/`, which is a
	 * passphrase submitted by a palm. A control you cannot see must not be a control you can press.
	 */
	if (y >= KB_TOP + 4 * KB_ROW_H) return;

	const int controlW = (int)W_ / 4;
	if (x < controlW) {
		page = (page + 1) % 3;
	} else if (x < controlW * 2) {
		if (entry.length() < limit) entry += ' ';
	} else if (x < controlW * 3) {
		if (!entry.isEmpty()) entry.remove(entry.length() - 1);
	} else {
		if (typingSsid) {
			if (!entry.isEmpty()) beginTyping(entry, false, false);
		} else if (!entry.isEmpty() || targetOpen) {
			startConnecting(targetSsid, entry, targetOpen);
		}
	}
	draw();
}

void onConnectingTap(int x, int y) {
	if (!connectResultKnown) return;
	if (connectSucceeded) {
		abortToIdle();
		return;
	}
	const int controlW = (int)W_ / 2;
	if (y >= 220 && y < 268) {
		if (x < controlW) {
			beginTyping(connectingSsid, false, targetOpen);
		} else {
			abortToIdle();
		}
		draw();
	}
}

void trackCornerGesture(int x, int y) {
	if (!(x < CORNER_ZONE_PX && y < CORNER_ZONE_PX)) return;
	const uint32_t now = millis();
	if (cornerTapCount > 0 && now - cornerTapTimes[0] > CORNER_WINDOW_MS) cornerTapCount = 0;
	if (cornerTapCount < CORNER_TAPS_NEEDED) cornerTapTimes[cornerTapCount++] = now;
	if (cornerTapCount >= CORNER_TAPS_NEEDED) {
		cornerTapCount = 0;
		if (!active()) {
			everDecided = true;  // a manual re-open should not be immediately re-decided by tick()
			startScan();
			draw();
		}
	}
}

}  // namespace

void handleTouch(const sensors::Event &event) {
	if (gfx_ == nullptr) return;  // see the same guard in `tick()`
	if (event.kind != sensors::Kind::Tap) return;
	trackCornerGesture(event.a, event.b);
	if (!active()) return;
	switch (state) {
		case State::Picking:
			onPickingTap(event.a, event.b);
			break;
		case State::Typing:
			onTypingTap(event.a, event.b);
			break;
		case State::Connecting:
			onConnectingTap(event.a, event.b);
			break;
		default:
			break;
	}
}

}  // namespace wifi_setup
