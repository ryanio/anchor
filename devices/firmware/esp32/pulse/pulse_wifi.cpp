#include "pulse_wifi.h"

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace pulse_wifi {

namespace {

/* ------------------------------------------------------------------------------ the palette ---- */

/*
 * Tokyo Night again, and yes these eight lines also exist in `pulse_ui.cpp`.
 *
 * They are copied rather than shared because `pulse_ui.h` deliberately exposes a layout and a
 * reading, not a theme, and widening its interface to hand out colours would make it the place a
 * palette lives — which is one more thing for a screen to depend on. The real fix, when the host can
 * send its Omarchy theme down the cable, deletes both copies at once. Until then two files agreeing
 * on eight constants is cheaper than a header that exists to hold them.
 */
constexpr uint32_t GROUND = 0x13141C;
constexpr uint32_t CARD = 0x1A1B26;
constexpr uint32_t EDGE = 0x292E42;
constexpr uint32_t KEY = 0x24283B;
constexpr uint32_t TEXT = 0xC0CAF5;
constexpr uint32_t MUTED = 0x586089;
constexpr uint32_t FAINT = 0x4E556D;
constexpr uint32_t GAIN = 0x9ECE6A;
constexpr uint32_t LOSS = 0xF7768E;
constexpr uint32_t ACCENT = 0x7AA2F7;
/*
 * Tokyo Night's yellow, for the word "open" on a network row.
 *
 * It was `LOSS` — the red the P&L uses — for one render, and on the glass that reads as an error
 * rather than as a caution: an open network is a perfectly joinable network that happens to carry no
 * encryption, and the row is not a failure. Yellow is the one colour in this palette that says
 * "notice this" without saying "this went wrong", which is exactly the distinction wanted.
 */
constexpr uint32_t WARN = 0xE0AF68;

/* ------------------------------------------------------------------------------- the metrics --- */

/*
 * The panel is 368x448 and everything is inset from it, by the amount `INSET` argues for below.
 *
 * Every number below is the one the render was checked at, not the one that was typed first — see
 * the notes against the keyboard and the button row, both of which moved after looking at a PNG.
 */
constexpr int32_t PANEL_W = 368;
constexpr int32_t PANEL_H = 448;
/*
 * 20, because the corners of this panel are not on the glass.
 *
 * The framebuffer is a full 368x448 rectangle and the display is a rounded one, so anything drawn
 * into a corner is partly behind the bezel's curve. This was 12 and the "Wi-Fi" heading lost a few
 * pixels off the left of the W — reported from the desk, and the third time this exact radius has
 * caught something: `sensors/sensors.ino` measured the same clearance at 20 for the same reason, and
 * `svg.gridMetrics` insets its tile grid by 4.5% of the short side, which is 17 here.
 *
 * It is a margin measured by eye against a unit rather than a published number — the radius is not
 * in this tree and Waveshare's 3D model gives no clean value for it — so it is deliberately the
 * larger of the three rather than the tightest that happened to work.
 */
constexpr int32_t INSET = 20;
constexpr int32_t INNER_W = PANEL_W - 2 * INSET; /* 328 */

/* The pick page. */
constexpr int32_t PICK_TITLE_Y = 12;
constexpr int32_t PICK_STATUS_Y = 44;
constexpr int32_t LIST_Y = 72;
/*
 * `LIST_HEIGHT` and not `LIST_H`, which is a name this file cannot have.
 *
 * `LIST_H` is an include guard in one of the headers the ESP32 core drags in behind `WiFi.h`, so on
 * the board it expands to nothing and the line becomes `constexpr int32_t = 296;`. The desktop
 * simulator compiles this file against shims that include no such header and was perfectly happy —
 * which is worth writing down, because it is the one class of mistake this harness cannot catch and
 * the only cure is to compile for the board before believing it.
 */
constexpr int32_t LIST_HEIGHT = 296; /* 72..368 */
constexpr int32_t PICK_BUTTON_Y = 380;
constexpr int32_t PICK_BUTTON_H = 54;
constexpr int32_t PICK_BUTTON_W = 109; /* three of these plus two 8 px gaps is 343 of 344 */
constexpr int32_t PICK_BUTTON_GAP = 8;

/* The typing page. */
constexpr int32_t TYPE_TITLE_Y = 10;
constexpr int32_t TYPE_SUB_Y = 40;
constexpr int32_t ENTRY_Y = 66;
constexpr int32_t ENTRY_H = 54;
constexpr int32_t REVEAL_W = 72;
constexpr int32_t ENTRY_W = INNER_W - REVEAL_W - 8; /* 264 */
constexpr int32_t HINT_Y = 130;
/*
 * The keyboard: 360 wide at x=4, 244 tall from y=196 to y=440.
 *
 * Not full-bleed, because of the corners above; not shorter, because key height is the axis that is
 * free here and `app/wifi_setup.cpp` measured what happens when it is spent badly — four rows ending
 * at y=304 left the bottom third of the panel dead while the keys were the hardest thing on it to
 * hit. LVGL's default map is four rows, so 244/4 is 61 px a row, about 4.8 mm on this 322 ppi glass,
 * against the 9-10 mm `TOUCH_TARGET_PX` is derived from. That is still under target and it is the
 * best this panel can do with ten columns; the popovers below are what closes the rest of the gap.
 *
 * The 56 px between the hint line and the top of the keyboard is not slack — it is where LVGL draws
 * the popover for a pressed key on the top row, and a keyboard flush against the hint would have the
 * popover cover the text somebody is checking.
 */
constexpr int32_t KB_X = 4;
constexpr int32_t KB_W = PANEL_W - 2 * KB_X; /* 360 */
constexpr int32_t KB_Y = 196;
constexpr int32_t KB_H = 244;

/* The result page. */
constexpr int32_t RESULT_HEADLINE_Y = 110;
constexpr int32_t RESULT_DETAIL_Y = 158;
constexpr int32_t RESULT_INFO_Y = 198;
constexpr int32_t RESULT_NOTE_Y = 240;
constexpr int32_t RESULT_BUTTON_Y = 320;
constexpr int32_t RESULT_BUTTON_H = 56;
constexpr int32_t RESULT_BUTTON_W = 166;

/* --------------------------------------------------------------------------------- timings ---- */

/*
 * How long a fresh unit shows its ambient screen before opening setup by itself.
 *
 * `app/wifi_setup.cpp` waited five seconds, because on that firmware a host might still be coming up
 * on the cable and a screen it did not ask for would have pre-empted it. There is no host here by
 * definition, so the only thing this delay buys is that the boot frame is on the glass long enough
 * to be seen — which is worth something on a unit somebody just powered on and is watching.
 */
constexpr uint32_t AUTO_OPEN_MS = 2000;

/* A join has this long to resolve before it is called a failure. Twenty seconds is the figure
 * `app/wifi_setup.cpp` used and it is generous on purpose: DHCP on a busy AP is slow, and a timeout
 * that fires early reports a failure over a join that was about to land. The *fast* failures below
 * are what stop that generosity from being felt. */
constexpr uint32_t JOIN_TIMEOUT_MS = 20000;

/*
 * `WL_NO_SSID_AVAIL` has to persist this long before it is believed.
 *
 * It appears transiently while the station is still scanning for the AP it was told to join, so
 * treating the first one as final would fail a join that was merely early — the same trap
 * `app/wifi_setup.cpp` names for `WL_DISCONNECTED`. Five seconds of nothing but that status is a
 * different claim: no access point answered to this name, which is the usual outcome of typing a
 * hidden network's SSID with one character wrong, and is worth saying before the twenty.
 */
constexpr uint32_t NO_SSID_GRACE_MS = 5000;

/* How often a unit with saved credentials that is not associated tries again. Quietly, in the
 * background, without taking the screen: an AP that rebooted comes back on its own and a device that
 * gave up after one attempt would need a person to notice. */
constexpr uint32_t RETRY_EVERY_MS = 30000;

/* About 1.4 s of deliberate contact; see `attachOpenGesture` in the header. */
constexpr int OPEN_HOLD_REPEATS = 10;

/* ---------------------------------------------------------------------------------- state ----- */

constexpr size_t SSID_MAX = 32;   /* 802.11 says 32 octets */
constexpr size_t PASS_MAX = 63;   /* WPA2-PSK passphrase maximum */
constexpr size_t PASS_MIN = 8;    /* and its minimum, which is worth saying before a join, not after */
constexpr int MAX_NETWORKS = 32;  /* what the list keeps; it scrolls, so this is memory, not a view */

enum class State : uint8_t {
	Closed,     /* not on screen */
	Scanning,   /* on screen, waiting for the radio */
	Picking,    /* on screen, a list to choose from */
	TypingSsid, /* on screen, a hidden network's name */
	TypingPass, /* on screen, a passphrase */
	Joining,    /* on screen, waiting for the radio */
	Joined,     /* on screen, it worked */
	Failed,     /* on screen, it did not, and why */
};

struct Network {
	char ssid[SSID_MAX + 1];
	int32_t rssi;
	bool open;
};

/*
 * The credential the radio was actually handed.
 *
 * This struct existing is the fix for the second of the seven. `app/wifi_setup.cpp` saved from the
 * keyboard's live buffer, which is a different value from the one `WiFi.begin()` was called with the
 * moment anything cancels or navigates. Here `startJoin()` is the only writer and `persist()` is the
 * only reader, so there is no second source for "what worked" to be taken from — the wrong-passphrase
 * bug has nowhere to live rather than being fixed by remembering to copy at the right moment.
 */
struct Attempt {
	char ssid[SSID_MAX + 1];
	char pass[PASS_MAX + 1];
	bool open;
};

State state = State::Closed;
bool built = false;
bool auto_open_done = false;
uint32_t booted_at = 0;

Preferences prefs;
bool have_saved = false;
char saved_ssid[SSID_MAX + 1] = {0};
char saved_pass[PASS_MAX + 1] = {0};
uint32_t last_retry_at = 0;

Network networks[MAX_NETWORKS];
int network_count = 0;
uint32_t scan_started_at = 0;
int scan_seconds_shown = -1;

Attempt attempt = {{0}, {0}, false};
bool typing_ssid = false;
char pending_ssid[SSID_MAX + 1] = {0}; /* the hidden name typed on the first of the two pages */
bool pending_open = false;
uint32_t join_started_at = 0;
uint32_t no_ssid_since = 0;
int join_seconds_shown = -1;

char status_text[96] = "wi-fi: not started";

int hold_repeats = 0;

/* ---------------------------------------------------------------------------- the objects ----- */

lv_obj_t *screen = nullptr;
lv_obj_t *return_screen = nullptr;

lv_obj_t *pick_page = nullptr;
lv_obj_t *pick_title = nullptr;
lv_obj_t *pick_status = nullptr;
lv_obj_t *list = nullptr;

lv_obj_t *type_page = nullptr;
lv_obj_t *type_title = nullptr;
lv_obj_t *type_sub = nullptr;
lv_obj_t *entry = nullptr;
lv_obj_t *reveal_label = nullptr;
lv_obj_t *keyboard = nullptr;

lv_obj_t *result_page = nullptr;
lv_obj_t *result_headline = nullptr;
lv_obj_t *result_detail = nullptr;
lv_obj_t *result_info = nullptr;
lv_obj_t *result_note = nullptr;
lv_obj_t *result_retry = nullptr;
lv_obj_t *result_dismiss = nullptr;
lv_obj_t *result_dismiss_label = nullptr;

lv_color_t hex(uint32_t rgb)
{
	return lv_color_hex(rgb);
}

void setStatus(const char *format, ...)
{
	va_list args;
	va_start(args, format);
	vsnprintf(status_text, sizeof(status_text), format, args);
	va_end(args);
}

/* ------------------------------------------------------------------------------- the widgets --- */

/*
 * A label that does not move when its text does, and ellipsises rather than wrapping.
 *
 * `LV_LABEL_LONG_DOT` against a pinned width is the whole of the fifth bug's fix. Arduino_GFX wraps
 * — a 32-character SSID at size 2 is 384 px on a 368 px panel and lands on the next line, over the
 * keyboard — and the old module's answer was to compute a character budget per call site, which was
 * a different guess about a different string in three places and wrong in all three. A width and a
 * long mode is one decision, made once, that LVGL enforces for every string it is ever given.
 */
lv_obj_t *makeLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t colour, int32_t x, int32_t y,
                    int32_t width, lv_text_align_t align)
{
	lv_obj_t *label = lv_label_create(parent);
	lv_obj_set_pos(label, x, y);
	lv_obj_set_width(label, width);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(colour), LV_PART_MAIN);
	lv_obj_set_style_text_align(label, align, LV_PART_MAIN);
	lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
	return label;
}

lv_obj_t *makeButton(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h, const char *text,
                     const lv_font_t *font, lv_obj_t **label_out = nullptr)
{
	lv_obj_t *button = lv_button_create(parent);
	lv_obj_set_pos(button, x, y);
	lv_obj_set_size(button, w, h);
	lv_obj_set_style_bg_color(button, hex(KEY), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(button, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(button, hex(EDGE), LV_PART_MAIN);
	lv_obj_set_style_border_width(button, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(button, 10, LV_PART_MAIN);
	lv_obj_set_style_shadow_width(button, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(button, 0, LV_PART_MAIN);
	lv_obj_t *label = lv_label_create(button);
	lv_label_set_text(label, text);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(TEXT), LV_PART_MAIN);
	lv_obj_center(label);
	if (label_out != nullptr) *label_out = label;
	return button;
}

/* A full-panel page. Transparent, so the screen's own ground shows through and only one object in
 * the tree paints the background. */
lv_obj_t *makePage(lv_obj_t *parent)
{
	lv_obj_t *page = lv_obj_create(parent);
	lv_obj_set_pos(page, 0, 0);
	lv_obj_set_size(page, PANEL_W, PANEL_H);
	lv_obj_set_style_bg_opa(page, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(page, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(page, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(page, 0, LV_PART_MAIN);
	lv_obj_remove_flag(page, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(page, LV_SCROLLBAR_MODE_OFF);
	return page;
}

void showPage(lv_obj_t *page)
{
	if (pick_page == nullptr) return;
	lv_obj_t *const pages[3] = {pick_page, type_page, result_page};
	for (lv_obj_t *one : pages) {
		if (one == page) {
			lv_obj_remove_flag(one, LV_OBJ_FLAG_HIDDEN);
		} else {
			lv_obj_add_flag(one, LV_OBJ_FLAG_HIDDEN);
		}
	}
}

/* ------------------------------------------------------------------------------- credentials --- */

void loadCredentials()
{
	prefs.begin("anchor-wifi", true);
	const String ssid = prefs.getString("ssid", "");
	const String pass = prefs.getString("pass", "");
	prefs.end();
	snprintf(saved_ssid, sizeof(saved_ssid), "%s", ssid.c_str());
	snprintf(saved_pass, sizeof(saved_pass), "%s", pass.c_str());
	have_saved = saved_ssid[0] != '\0';
}

/*
 * Write the credential that joined, and only that one.
 *
 * Called from exactly one place: the `WL_CONNECTED` branch of `tickJoining()`. Saving on the way
 * *into* a join — which is what "the user pressed Join, so this must be right" amounts to — is the
 * bug this reproduces if it is ever called anywhere else, and it is worth saying plainly because the
 * convenient place to put this call is the place that is wrong.
 *
 * The compare-before-write is not premature: NVS is flash with a finite erase count, a unit that
 * reconnects to its own saved network on every boot would otherwise rewrite the same two strings
 * forever, and a write that changes nothing is indistinguishable from no write at all except in
 * wear.
 */
void persist(const Attempt &joined)
{
	if (strcmp(saved_ssid, joined.ssid) == 0 && strcmp(saved_pass, joined.pass) == 0) return;
	prefs.begin("anchor-wifi", false);
	prefs.putString("ssid", String(joined.ssid));
	prefs.putString("pass", String(joined.pass));
	prefs.end();
	snprintf(saved_ssid, sizeof(saved_ssid), "%s", joined.ssid);
	snprintf(saved_pass, sizeof(saved_pass), "%s", joined.pass);
	have_saved = true;
}

/* ---------------------------------------------------------------------------------- the scan --- */

/*
 * Every result, sorted by strength, deduplicated by name.
 *
 * Two departures from `app/wifi_setup.cpp`, both of which its own comments asked for and its code
 * did not deliver:
 *
 *   1. **The sort is over everything the radio returned.** That module kept six and called them the
 *      strongest six; the loop that filled them stopped at six. On a quiet desk those are the same
 *      list, and in a building with thirty access points — an offsite venue, say — the network
 *      somebody is standing next to is exactly the one that goes missing. Here every result is
 *      considered and the list scrolls, so nothing is dropped for want of a row to put it in.
 *   2. **One row per name.** A mesh answers on two or three radios with the same SSID, which filled
 *      the old six-row list with three copies of one network. The strongest of each name wins, which
 *      is also the one the station would have picked.
 *
 * A hidden network has no name to show and is skipped rather than listed blank — the Hidden button
 * is the path to one of those.
 */
void collectScan(int16_t found)
{
	network_count = 0;
	for (int16_t i = 0; i < found && i < 64; i++) {
		char ssid[SSID_MAX + 1];
		snprintf(ssid, sizeof(ssid), "%s", WiFi.SSID((uint8_t)i).c_str());
		if (ssid[0] == '\0') continue;

		const int32_t rssi = WiFi.RSSI((uint8_t)i);
		const bool open = WiFi.encryptionType((uint8_t)i) == WIFI_AUTH_OPEN;

		int existing = -1;
		for (int j = 0; j < network_count; j++) {
			if (strcmp(networks[j].ssid, ssid) == 0) {
				existing = j;
				break;
			}
		}
		if (existing >= 0) {
			if (networks[existing].rssi >= rssi) continue;
			/* Drop the weaker duplicate and let the stronger one be inserted in its right place. */
			for (int j = existing; j + 1 < network_count; j++) networks[j] = networks[j + 1];
			network_count--;
		} else if (network_count == MAX_NETWORKS) {
			if (networks[MAX_NETWORKS - 1].rssi >= rssi) continue;
			network_count--;
		}

		int slot = network_count++;
		while (slot > 0 && networks[slot - 1].rssi < rssi) {
			networks[slot] = networks[slot - 1];
			slot--;
		}
		snprintf(networks[slot].ssid, sizeof(networks[slot].ssid), "%s", ssid);
		networks[slot].rssi = rssi;
		networks[slot].open = open;
	}
	WiFi.scanDelete();
}

void onNetworkPicked(lv_event_t *event);

/*
 * The list, rebuilt from `networks`.
 *
 * Each row carries its strength and whether it wants a passphrase, in text rather than in an icon.
 * There is no padlock in LVGL's symbol font and inventing one out of a warning triangle would make
 * the most important bit on the row a glyph somebody has to learn; "-47 dBm · WPA" is longer and is
 * read correctly the first time. It also makes the sort visible, which is the only way anybody
 * checks a claim like "strongest first" from a screenshot.
 */
void rebuildList()
{
	if (list == nullptr) return;
	lv_obj_clean(list);
	for (int i = 0; i < network_count; i++) {
		lv_obj_t *row = lv_list_add_button(list, LV_SYMBOL_WIFI, networks[i].ssid);
		lv_obj_set_style_bg_color(row, hex(KEY), LV_PART_MAIN);
		lv_obj_set_style_bg_opa(row, LV_OPA_COVER, LV_PART_MAIN);
		lv_obj_set_style_text_color(row, hex(TEXT), LV_PART_MAIN);
		lv_obj_set_style_text_font(row, &lv_font_montserrat_20, LV_PART_MAIN);
		/* Clear of the scrollbar, which the list draws inside its own right edge. Without this the
		 * security word ends underneath it and reads as clipped even though the label fits. */
		lv_obj_set_style_pad_right(row, 14, LV_PART_MAIN);
		lv_obj_set_style_border_width(row, 0, LV_PART_MAIN);
		lv_obj_set_style_radius(row, 8, LV_PART_MAIN);
		lv_obj_set_style_pad_hor(row, 10, LV_PART_MAIN);
		lv_obj_set_style_pad_ver(row, 12, LV_PART_MAIN);
		lv_obj_set_style_bg_color(row, hex(EDGE), LV_PART_MAIN | LV_STATE_PRESSED);

		/*
		 * `lv_list_add_button` gives its text label `LV_LABEL_LONG_SCROLL_CIRCULAR`, which animates a
		 * long SSID sideways forever. That is a repaint of a 344 px row every frame, on a device whose
		 * whole idle story is that an unchanged screen costs nothing, for a name that ellipsis reports
		 * just as well. The label is the last child because the icon was added first.
		 */
		lv_obj_t *name = lv_obj_get_child(row, -1);
		if (name != nullptr && lv_obj_check_type(name, &lv_label_class)) {
			lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
			/*
			 * The name takes the slack, so the reading on the right never gets pushed off.
			 *
			 * A list button lays its children out in a flex row, and without a grow the name sizes to
			 * its text and the `-42 dBm  WPA` after it simply runs past the row's right edge — which
			 * it did the moment `INSET` went from 12 to 20 and took 16 px out of the row. Growing the
			 * name instead means a long SSID ellipsises, which is what `LONG_DOT` is there for, and
			 * the signal and security — the two things somebody is comparing rows on — always fit.
			 */
			lv_obj_set_flex_grow(name, 1);
		}

		char detail[96];
		snprintf(detail, sizeof(detail), "%d dBm  %s", (int)networks[i].rssi,
		         networks[i].open ? "open" : "WPA");
		lv_obj_t *meta = lv_label_create(row);
		lv_label_set_text(meta, detail);
		lv_obj_set_style_text_font(meta, &lv_font_montserrat_16, LV_PART_MAIN);
		lv_obj_set_style_text_color(meta, networks[i].open ? hex(WARN) : hex(MUTED), LV_PART_MAIN);

		lv_obj_set_user_data(row, (void *)(intptr_t)i);
		lv_obj_add_event_cb(row, onNetworkPicked, LV_EVENT_CLICKED, nullptr);
	}
}

/* --------------------------------------------------------------------------------- the pages --- */

void refreshPickStatus()
{
	if (pick_status == nullptr) return;
	char line[96];
	if (state == State::Scanning) {
		const uint32_t seconds = (millis() - scan_started_at) / 1000u;
		snprintf(line, sizeof(line), "Looking for networks... %us", (unsigned)seconds);
	} else if (network_count == 0) {
		/*
		 * Every one of these is kept under about 40 characters, which is what 344 px of 16 px
		 * Montserrat holds. Past that `LV_LABEL_LONG_DOT` clips it — which is the right failure, but
		 * the render showed "Nothing on the air. Rescan, or type a hid..." and a sentence whose verb
		 * has been ellipsised away is worse than a shorter one.
		 */
		snprintf(line, sizeof(line), "Nothing on the air. Try Rescan.");
	} else if (connected()) {
		snprintf(line, sizeof(line), "On %s - %d network%s", saved_ssid, network_count,
		         network_count == 1 ? "" : "s");
	} else if (network_count == 1) {
		snprintf(line, sizeof(line), "One network.");
	} else {
		snprintf(line, sizeof(line), "%d networks, strongest first.", network_count);
	}
	lv_label_set_text(pick_status, line);
}

void showResult()
{
	showPage(result_page);
	lv_label_set_text(result_detail, attempt.ssid);
	switch (state) {
		case State::Joining:
			lv_obj_set_style_text_color(result_headline, hex(ACCENT), LV_PART_MAIN);
			lv_label_set_text(result_headline, "Joining");
			/*
			 * The elapsed count is this screen's proof of life.
			 *
			 * The first render of it was the word "Joining" over an empty panel, and there is no way
			 * to tell that apart from a firmware that has hung — which is exactly the state the old
			 * module was actually in, showing "connecting" and a frozen spinner over a unit that had
			 * already joined and saved. A number that goes up cannot be mistaken for a stopped one,
			 * and naming the budget it is counting towards says what happens when it runs out.
			 */
			join_seconds_shown = -1;
			lv_label_set_text(result_info, "0s of 20");
			lv_label_set_text(result_note, "");
			lv_obj_add_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_add_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			break;
		case State::Joined:
			lv_obj_set_style_text_color(result_headline, hex(GAIN), LV_PART_MAIN);
			lv_label_set_text(result_headline, "Connected");
			lv_label_set_text(result_info, WiFi.localIP().toString().c_str());
			lv_label_set_text(result_note, "Saved on this unit.");
			lv_obj_add_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_remove_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			lv_label_set_text(result_dismiss_label, "Done");
			break;
		case State::Failed:
			lv_obj_set_style_text_color(result_headline, hex(LOSS), LV_PART_MAIN);
			lv_label_set_text(result_headline, "Did not join");
			/* `result_info` is written by whoever decided it failed, so the reason survives to here. */
			lv_label_set_text(result_note, "Nothing was saved.");
			lv_obj_remove_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_remove_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			lv_label_set_text(result_dismiss_label, "Back");
			break;
		default:
			break;
	}
	/*
	 * One button sits in the middle, two sit apart.
	 *
	 * The success screen first put its only button where the right-hand one of a pair goes, leaving a
	 * 166 px hole beside it that reads as a second button that failed to draw. Which button is
	 * showing is already decided above, so the position follows from it rather than being a third
	 * thing to keep in step.
	 */
	const bool alone = lv_obj_has_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
	lv_obj_set_pos(result_dismiss, alone ? (PANEL_W - RESULT_BUTTON_W) / 2 : PANEL_W - INSET - RESULT_BUTTON_W,
	               RESULT_BUTTON_Y);
}

void startScan()
{
	state = State::Scanning;
	network_count = 0;
	scan_started_at = millis();
	scan_seconds_shown = -1;
	rebuildList();
	showPage(pick_page);
	refreshPickStatus();
	WiFi.mode(WIFI_STA);
	WiFi.scanDelete();
	WiFi.scanNetworks(true /* async: this must not block the UI thread */);
	setStatus("wi-fi: scanning");
}

void startTyping(const char *ssid, bool for_ssid, bool open)
{
	typing_ssid = for_ssid;
	pending_open = open;
	snprintf(pending_ssid, sizeof(pending_ssid), "%s", ssid == nullptr ? "" : ssid);

	/*
	 * The field starts empty every time, and that is the other half of the wrong-passphrase fix.
	 * `app/wifi_setup.cpp` left `entry` populated across a cancel, which is how three characters
	 * typed for one network ended up saved against another.
	 */
	lv_textarea_set_text(entry, "");
	lv_textarea_set_password_mode(entry, !for_ssid);
	lv_textarea_set_max_length(entry, for_ssid ? (uint32_t)SSID_MAX : (uint32_t)PASS_MAX);
	lv_label_set_text(reveal_label, LV_SYMBOL_EYE_OPEN);
	lv_keyboard_set_mode(keyboard, LV_KEYBOARD_MODE_TEXT_LOWER);

	lv_obj_set_style_text_color(type_sub, hex(MUTED), LV_PART_MAIN);
	if (for_ssid) {
		lv_label_set_text(type_title, "Hidden network");
		lv_label_set_text(type_sub, "Type the name exactly, then OK");
	} else {
		lv_label_set_text(type_title, pending_ssid);
		lv_label_set_text(type_sub, open ? "This network is open - no passphrase"
		                                 : "Passphrase, at least 8 characters");
	}
	state = for_ssid ? State::TypingSsid : State::TypingPass;
	showPage(type_page);
}

/*
 * Hand the radio a credential, and remember exactly what was handed over.
 *
 * `attempt` is filled here and nowhere else. Everything downstream — the result screen, the retry
 * button, and the NVS write — reads it rather than the textarea, which is why a cancel, a rescan or
 * a second pick cannot change what "the thing that worked" means.
 */
void startJoin(const char *ssid, const char *pass, bool open)
{
	snprintf(attempt.ssid, sizeof(attempt.ssid), "%s", ssid == nullptr ? "" : ssid);
	snprintf(attempt.pass, sizeof(attempt.pass), "%s", pass == nullptr ? "" : pass);
	attempt.open = open;

	state = State::Joining;
	join_started_at = millis();
	no_ssid_since = 0;
	showResult();
	setStatus("wi-fi: joining %s", attempt.ssid);

	WiFi.mode(WIFI_STA);
	WiFi.disconnect();
	if (attempt.pass[0] == '\0') {
		WiFi.begin(attempt.ssid);
	} else {
		WiFi.begin(attempt.ssid, attempt.pass);
	}
}

void fail(const char *reason)
{
	state = State::Failed;
	lv_label_set_text(result_info, reason);
	showResult();
	setStatus("wi-fi: %s did not join - %s", attempt.ssid, reason);
}

/* ---------------------------------------------------------------------------------- events ---- */

void onNetworkPicked(lv_event_t *event)
{
	lv_obj_t *row = (lv_obj_t *)lv_event_get_target(event);
	const int index = (int)(intptr_t)lv_obj_get_user_data(row);
	if (index < 0 || index >= network_count) return;
	const Network &net = networks[index];
	if (net.open) {
		/* An open network needs no passphrase, so it does not get a keyboard. The old module sent one
		 * here anyway on the retry path, offering a password screen for a network that wants none. */
		startJoin(net.ssid, "", true);
	} else {
		startTyping(net.ssid, false, false);
	}
}

void onRescan(lv_event_t *event)
{
	(void)event;
	startScan();
}

void onHidden(lv_event_t *event)
{
	(void)event;
	startTyping("", true, false);
}

void onCloseTapped(lv_event_t *event)
{
	(void)event;
	close();
}

void onReveal(lv_event_t *event)
{
	(void)event;
	/*
	 * Show what was typed.
	 *
	 * A 36 px key on a 322 ppi panel under a fingertip that covers it is a typo waiting to happen,
	 * and a passphrase you cannot check is a passphrase you retype from the beginning. LVGL already
	 * unmasks the last character for `LV_TEXTAREA_DEF_PWD_SHOW_TIME` (1.5 s) as it is typed; this is
	 * for the other question, which is whether the whole thing is right before committing it.
	 */
	const bool hidden = lv_textarea_get_password_mode(entry);
	lv_textarea_set_password_mode(entry, !hidden);
	lv_label_set_text(reveal_label, hidden ? LV_SYMBOL_EYE_CLOSE : LV_SYMBOL_EYE_OPEN);
}

/*
 * The magnifier: the key under the finger, drawn large, above the finger, on the top layer.
 *
 * LVGL's own popover was the first attempt and it is not enough here. It redraws the pressed key
 * extended upward by exactly one key height — about 61 px on this keyboard — which on a 368 px panel
 * held at arm's length is barely a magnification at all, and the part that matters is still directly
 * under the fingertip covering it. Reported plainly from the desk: it needed to be much bigger and
 * clearly above the finger.
 *
 * So this is a label on `lv_layer_top()`, which draws over every screen and is not clipped by the
 * keyboard's bounds — the constraint that makes a bigger popover impossible inside the widget. It
 * follows `LV_EVENT_PRESSING`, so it tracks a finger sliding across the keys rather than appearing
 * once where the press started; the button matrix commits on release, so sliding to the right key
 * and then letting go is a real correction rather than a mistake to undo.
 *
 * It is deliberately *not* shown for the control keys. Magnifying a backspace or a shift tells
 * nobody anything they did not already know from pressing it, and a 64 px glyph of an arrow over the
 * passphrase field is noise where the letters are signal.
 */
constexpr int32_t MAG_W = 112;
constexpr int32_t MAG_H = 124;

lv_obj_t *magnifier = nullptr;

void hideMagnifier()
{
	if (magnifier != nullptr) lv_obj_add_flag(magnifier, LV_OBJ_FLAG_HIDDEN);
}

void onKeyboardPressing(lv_event_t *event)
{
	lv_obj_t *kb = (lv_obj_t *)lv_event_get_target(event);
	if (kb == nullptr || magnifier == nullptr) return;

	const uint32_t id = lv_buttonmatrix_get_selected_button(kb);
	if (id == LV_BUTTONMATRIX_BUTTON_NONE) {
		hideMagnifier();
		return;
	}
	const char *text = lv_buttonmatrix_get_button_text(kb, id);
	/*
	 * One printable character only. Everything else on this keyboard is a control — the mode switch,
	 * backspace, enter, the arrows — and those arrive here as multi byte symbol strings or words
	 * rather than as a letter. Length is the whole test, and it keeps the magnifier to exactly the
	 * keys whose identity is in doubt under a fingertip.
	 */
	if (text == nullptr || text[0] == '\0' || text[1] != '\0') {
		hideMagnifier();
		return;
	}

	/*
	 * Positioned from the finger, not from the key.
	 *
	 * LVGL 9.2 exposes no public way to ask a button matrix where it drew a given button — the rect
	 * is internal — so the first version of this did not compile. The touch point is the better
	 * anchor anyway, and it is what was actually asked for: the magnifier belongs above the *finger*,
	 * which is the thing doing the covering. It also means the magnifier tracks a slide smoothly
	 * rather than jumping key to key.
	 */
	lv_indev_t *indev = lv_indev_active();
	if (indev == nullptr) {
		hideMagnifier();
		return;
	}
	lv_point_t touch;
	lv_indev_get_point(indev, &touch);

	lv_label_set_text(magnifier, text);

	/*
	 * Centred over the key, and far enough above it to clear a fingertip.
	 *
	 * A finger on this glass covers roughly 100 px, so sitting the magnifier one key height up — what
	 * the built-in popover does — leaves it under the hand that is asking the question. It is placed
	 * a full magnifier height above the key's top instead, and clamped into the panel so the top row
	 * does not push it off the screen. The clamp is why this is not simply an offset: the top row is
	 * exactly the row where the answer is least visible and most wanted.
	 */
	int32_t x = touch.x - MAG_W / 2;
	int32_t y = touch.y - MAG_H - 56;
	if (x < INSET) x = INSET;
	if (x > PANEL_W - INSET - MAG_W) x = PANEL_W - INSET - MAG_W;
	if (y < INSET) y = INSET;
	lv_obj_set_pos(magnifier, x, y);
	lv_obj_remove_flag(magnifier, LV_OBJ_FLAG_HIDDEN);
}

void onKeyboardReleased(lv_event_t *event)
{
	(void)event;
	hideMagnifier();
}

/* The keyboard's own OK key. LVGL raises `LV_EVENT_READY` from it and from the newline key, so there
 * is exactly one place a submission arrives from and no geometry deciding what a tap meant. */
void onKeyboardReady(lv_event_t *event)
{
	(void)event;
	const char *typed = lv_textarea_get_text(entry);
	if (typed == nullptr) typed = "";

	/* The subtitle is where a refusal lands, and it changes colour to say so. It said the same thing
	 * in the same grey as the instruction it replaced for one render, and a line that only changes
	 * its words is a line somebody re-reads twice before noticing it moved. */
	if (state == State::TypingSsid) {
		if (typed[0] == '\0') {
			lv_obj_set_style_text_color(type_sub, hex(LOSS), LV_PART_MAIN);
			lv_label_set_text(type_sub, "A network needs a name");
			return;
		}
		startTyping(typed, false, false);
		return;
	}

	if (!pending_open && strlen(typed) < PASS_MIN) {
		/*
		 * Refused here rather than by the access point twenty seconds later.
		 *
		 * WPA2-PSK's own minimum is eight characters, so this is not a house rule — a shorter one
		 * cannot succeed anywhere, and letting it through would spend a join, a timeout and a failure
		 * screen to report something that was knowable at the keystroke.
		 */
		/* Kept under the width of this label, which is 344 px at 16 px Montserrat and fits about 33
		 * characters. The first wording was 42 and ellipsised itself into "...8 charact...", which is
		 * a refusal that does not say what to do about it. */
		lv_obj_set_style_text_color(type_sub, hex(LOSS), LV_PART_MAIN);
		lv_label_set_text(type_sub, "Too short - 8 characters minimum");
		return;
	}
	startJoin(pending_ssid, typed, pending_open);
}

/* The keyboard's close key: back to the list, and the field is cleared on the way in next time. */
void onKeyboardCancel(lv_event_t *event)
{
	(void)event;
	state = State::Picking;
	showPage(pick_page);
	refreshPickStatus();
}

void onRetry(lv_event_t *event)
{
	(void)event;
	if (attempt.open) {
		startJoin(attempt.ssid, "", true);
	} else {
		startTyping(attempt.ssid, false, false);
	}
}

void onDismiss(lv_event_t *event)
{
	(void)event;
	if (state == State::Joined) {
		close();
		return;
	}
	state = State::Picking;
	showPage(pick_page);
	refreshPickStatus();
}

void onHold(lv_event_t *event)
{
	switch (lv_event_get_code(event)) {
		case LV_EVENT_LONG_PRESSED:
			hold_repeats = 0;
			break;
		case LV_EVENT_LONG_PRESSED_REPEAT:
			if (++hold_repeats >= OPEN_HOLD_REPEATS) {
				hold_repeats = 0;
				open();
			}
			break;
		default:
			hold_repeats = 0;
			break;
	}
}

/* ----------------------------------------------------------------------------------- build ---- */

void build()
{
	if (built) return;
	built = true;

	screen = lv_obj_create(nullptr);
	lv_obj_set_style_bg_color(screen, hex(GROUND), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_pad_all(screen, 0, LV_PART_MAIN);
	lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

	/* ---- pick ---- */
	pick_page = makePage(screen);
	pick_title = makeLabel(pick_page, &lv_font_montserrat_28, TEXT, INSET, PICK_TITLE_Y, INNER_W,
	                       LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(pick_title, "Wi-Fi");
	/*
	 * Brighter and a size up, as an experiment against a symptom the simulator cannot reproduce.
	 *
	 * This line was reported twice as looking "italicised" and "super slanted" on the glass, while
	 * rendering perfectly here and surviving a fix for tearing that did help elsewhere. What is
	 * unusual about it is contrast, not layout: at `MUTED` on near black it is the faintest text on
	 * the screen, and fine low contrast antialiased glyphs on an AMOLED's subpixel geometry fringe in
	 * a way that reads as a slant. Larger and brighter is the cheap test of that theory, and is an
	 * improvement to a subtitle nobody could read either way.
	 *
	 * If it still slants after this, the cause is not contrast and this comment should be replaced
	 * with what it actually was.
	 */
	pick_status = makeLabel(pick_page, &lv_font_montserrat_20, TEXT, INSET, PICK_STATUS_Y, INNER_W,
	                        LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(pick_status, "");

	list = lv_list_create(pick_page);
	lv_obj_set_pos(list, INSET, LIST_Y);
	lv_obj_set_size(list, INNER_W, LIST_HEIGHT);
	lv_obj_set_style_bg_color(list, hex(CARD), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(list, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(list, hex(EDGE), LV_PART_MAIN);
	lv_obj_set_style_border_width(list, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(list, 12, LV_PART_MAIN);
	lv_obj_set_style_pad_all(list, 6, LV_PART_MAIN);
	lv_obj_set_style_pad_row(list, 6, LV_PART_MAIN);
	/* The scrollbar is the only thing that tells somebody a seventh network exists. It is the fix for
	 * the list that silently held entries nobody could reach, so it is always on rather than fading. */
	lv_obj_set_scrollbar_mode(list, LV_SCROLLBAR_MODE_ON);
	/*
	 * Vertically only. The first render came back with a horizontal scrollbar across the bottom of the
	 * list, because a row's content is a hair wider than the space left once the vertical bar has
	 * taken its six pixels — so the list was draggable sideways into nothing. Harmless to look at and
	 * not harmless to use: a finger dragging down a list of networks that also slides left is a list
	 * that fights back. Seen in the PNG, not deduced.
	 */
	lv_obj_set_scroll_dir(list, LV_DIR_VER);
	lv_obj_set_style_bg_color(list, hex(MUTED), LV_PART_SCROLLBAR);
	lv_obj_set_style_bg_opa(list, LV_OPA_COVER, LV_PART_SCROLLBAR);
	lv_obj_set_style_width(list, 6, LV_PART_SCROLLBAR);
	lv_obj_set_style_radius(list, 3, LV_PART_SCROLLBAR);

	lv_obj_add_event_cb(makeButton(pick_page, INSET, PICK_BUTTON_Y, PICK_BUTTON_W, PICK_BUTTON_H,
	                               "Rescan", &lv_font_montserrat_18),
	                    onRescan, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(makeButton(pick_page, INSET + PICK_BUTTON_W + PICK_BUTTON_GAP, PICK_BUTTON_Y,
	                               PICK_BUTTON_W, PICK_BUTTON_H, "Hidden", &lv_font_montserrat_18),
	                    onHidden, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(makeButton(pick_page, INSET + 2 * (PICK_BUTTON_W + PICK_BUTTON_GAP),
	                               PICK_BUTTON_Y, PICK_BUTTON_W, PICK_BUTTON_H, "Close",
	                               &lv_font_montserrat_18),
	                    onCloseTapped, LV_EVENT_CLICKED, nullptr);

	/* ---- type ---- */
	type_page = makePage(screen);
	type_title = makeLabel(type_page, &lv_font_montserrat_24, TEXT, INSET, TYPE_TITLE_Y, INNER_W,
	                       LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(type_title, "");
	type_sub = makeLabel(type_page, &lv_font_montserrat_18, MUTED, INSET, TYPE_SUB_Y, INNER_W,
	                     LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(type_sub, "");

	entry = lv_textarea_create(type_page);
	/* `set_one_line` before `set_size`: it sets the height to `LV_SIZE_CONTENT` itself, so called
	 * afterwards it undoes the 54 and leaves a 46 px field beside a 54 px button — eight pixels of
	 * misalignment that is invisible in the source and obvious in a render. */
	lv_textarea_set_one_line(entry, true);
	lv_obj_set_pos(entry, INSET, ENTRY_Y);
	lv_obj_set_size(entry, ENTRY_W, ENTRY_H);
	lv_textarea_set_password_mode(entry, true);
	lv_textarea_set_placeholder_text(entry, "passphrase");
	/*
	 * A middle dot, asked for by name, and LVGL will not choose it on its own.
	 *
	 * `lv_textarea_get_password_bullet` asks the *font* whether it carries U+2022 and quietly returns
	 * "*" when it does not — so the masked field came out as a row of asterisks, which on this glass
	 * read as ragged and hard to count. Setting it explicitly is the whole fix, provided the face
	 * actually has the glyph; if it does not, this renders as a placeholder box rather than falling
	 * back, which is why it was checked in the simulator rather than assumed.
	 */
	lv_textarea_set_password_bullet(entry, "•");
	/*
	 * The character shows for a moment and then becomes a dot, and the moment is short.
	 *
	 * LVGL's default is 1500ms, which on this panel was reported as a glyph that looks wrong for
	 * most of a second before resolving. Some of that was the touch driver below this one: a contact
	 * that flickered press/release several times a second had the field redrawing the same character
	 * over and over, which is exactly what a smeared or slanted glyph looks like. That is fixed in
	 * `pulse_touch.cpp`.
	 *
	 * This is the other half, and it stands on its own: the point of showing the character at all is
	 * to confirm the key that registered, which a glance answers. Anything longer is a passphrase
	 * sitting in the clear on a screen somebody is holding in a room with other people in it, for no
	 * further benefit — and the eye button is the considered way to read the whole thing back.
	 */
	lv_textarea_set_password_show_time(entry, 400);
	lv_obj_set_style_text_font(entry, &lv_font_montserrat_24, LV_PART_MAIN);
	lv_obj_set_style_text_color(entry, hex(TEXT), LV_PART_MAIN);
	lv_obj_set_style_bg_color(entry, hex(KEY), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(entry, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_color(entry, hex(EDGE), LV_PART_MAIN);
	lv_obj_set_style_border_width(entry, 1, LV_PART_MAIN);
	lv_obj_set_style_radius(entry, 10, LV_PART_MAIN);
	lv_obj_set_style_text_color(entry, hex(FAINT), LV_PART_TEXTAREA_PLACEHOLDER);

	lv_obj_t *reveal = makeButton(type_page, INSET + ENTRY_W + 8, ENTRY_Y, REVEAL_W, ENTRY_H,
	                              LV_SYMBOL_EYE_OPEN, &lv_font_montserrat_22, &reveal_label);
	lv_obj_add_event_cb(reveal, onReveal, LV_EVENT_CLICKED, nullptr);

	lv_obj_t *hint = makeLabel(type_page, &lv_font_montserrat_18, FAINT, INSET, HINT_Y, INNER_W,
	                           LV_TEXT_ALIGN_LEFT);
	lv_label_set_text(hint, LV_SYMBOL_OK "  joins      " LV_SYMBOL_KEYBOARD "  goes back");

	keyboard = lv_keyboard_create(type_page);
	/*
	 * `lv_obj_set_align` before `lv_obj_set_pos`, and it is not decoration.
	 *
	 * `lv_keyboard`'s constructor aligns itself `LV_ALIGN_BOTTOM_MID` and defaults to 100% wide by
	 * 50% tall — so a plain `set_pos(4, 196)` is read as an *offset from the bottom centre*, and the
	 * first render put the keyboard at (8, 400) with 196 px of it hanging off the panel. The
	 * simulator's tree dump said `<< PAST ITS PARENT'S BOTTOM EDGE` before any pixel was looked at,
	 * which is the whole reason that check is in it.
	 */
	lv_obj_set_align(keyboard, LV_ALIGN_TOP_LEFT);
	lv_obj_set_pos(keyboard, KB_X, KB_Y);
	lv_obj_set_size(keyboard, KB_W, KB_H);
	lv_keyboard_set_textarea(keyboard, entry);
	/* A pressed key draws itself above the finger covering it. On a panel where a key is 36 px wide
	 * and a fingertip is about 100, this is the difference between seeing what you typed and finding
	 * out later. */
	lv_keyboard_set_popovers(keyboard, true);
	lv_obj_set_style_bg_color(keyboard, hex(GROUND), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(keyboard, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_border_width(keyboard, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(keyboard, 2, LV_PART_MAIN);
	/* 3 px between keys rather than the theme's default. The first render clipped the "ABC" and "1#"
	 * mode keys — they are the narrowest in the map and a 22 px face does not fit three glyphs inside
	 * them once the theme's gap and a 1 px border have taken their share. Widening the keys is the
	 * fix that keeps the face legible; shrinking the face to 16 would have cost every letter. */
	lv_obj_set_style_pad_gap(keyboard, 3, LV_PART_MAIN);
	lv_obj_set_style_bg_color(keyboard, hex(KEY), LV_PART_ITEMS);
	lv_obj_set_style_bg_opa(keyboard, LV_OPA_COVER, LV_PART_ITEMS);
	lv_obj_set_style_text_color(keyboard, hex(TEXT), LV_PART_ITEMS);
	lv_obj_set_style_text_font(keyboard, &lv_font_montserrat_24, LV_PART_ITEMS);
	lv_obj_set_style_border_color(keyboard, hex(EDGE), LV_PART_ITEMS);
	lv_obj_set_style_border_width(keyboard, 1, LV_PART_ITEMS);
	lv_obj_set_style_radius(keyboard, 6, LV_PART_ITEMS);
	/*
	 * The control keys are `LV_STATE_CHECKED`, and styling only the default state leaves them wearing
	 * the *stock theme* — which is `LV_THEME_DEFAULT_DARK 0`, so the first render had nine white keys
	 * with black glyphs scattered through a dark keyboard. It looked like a rendering fault and was a
	 * missing selector. They are darker than the letters here on purpose: shift, backspace and the
	 * mode switch are not things somebody is aiming at while typing a passphrase.
	 */
	lv_obj_set_style_bg_color(keyboard, hex(EDGE), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_text_color(keyboard, hex(TEXT), LV_PART_ITEMS | LV_STATE_CHECKED);
	lv_obj_set_style_border_color(keyboard, hex(MUTED), LV_PART_ITEMS | LV_STATE_CHECKED);
	/* Pressed has to be loud. The popover above shows *what* was pressed; this is what says a press
	 * registered at all, on a controller that has never yet answered with a coordinate. */
	lv_obj_set_style_bg_color(keyboard, hex(ACCENT), LV_PART_ITEMS | LV_STATE_PRESSED);
	lv_obj_set_style_text_color(keyboard, hex(GROUND), LV_PART_ITEMS | LV_STATE_PRESSED);
	/*
	 * The key under the finger is drawn a size and a half up, which is what makes the popover a
	 * magnifier rather than a repeat.
	 *
	 * A press style applies to the popover too — LVGL draws it from the same button's styles — so a
	 * larger face in this one state enlarges precisely the glyph being covered by a fingertip and
	 * nothing else. That is the whole feature: hold to see which key you are actually on, slide until
	 * it is the right one, and let go to commit it, the way a phone keyboard behaves. The button
	 * matrix already selects on release rather than on contact, so the "slide to correct" half comes
	 * for free and needed no code.
	 *
	 * 32 against a 24 px base. Bigger looked like a different widget appearing rather than the same
	 * key growing, and on the top row it started to reach the hint line above the keyboard.
	 */
	lv_obj_set_style_text_font(keyboard, &lv_font_montserrat_32, LV_PART_ITEMS | LV_STATE_PRESSED);
	lv_obj_add_event_cb(keyboard, onKeyboardReady, LV_EVENT_READY, nullptr);
	lv_obj_add_event_cb(keyboard, onKeyboardCancel, LV_EVENT_CANCEL, nullptr);

	/*
	 * The magnifier, built once on the top layer and moved around thereafter.
	 *
	 * On `lv_layer_top()` rather than on this page, because it has to draw outside the keyboard and a
	 * child is clipped to its parent. Created hidden, and every path that ends a press hides it again
	 * — including `LV_EVENT_RELEASED`, which fires for the press that commits a key, so the magnifier
	 * never outlives the finger that summoned it.
	 */
	magnifier = lv_label_create(lv_layer_top());
	lv_obj_set_size(magnifier, MAG_W, MAG_H);
	lv_obj_set_style_bg_color(magnifier, hex(ACCENT), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(magnifier, LV_OPA_COVER, LV_PART_MAIN);
	lv_obj_set_style_text_color(magnifier, hex(GROUND), LV_PART_MAIN);
	lv_obj_set_style_text_font(magnifier, &lv_font_montserrat_48, LV_PART_MAIN);
	lv_obj_set_style_text_align(magnifier, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
	lv_obj_set_style_radius(magnifier, 14, LV_PART_MAIN);
	lv_obj_set_style_border_color(magnifier, hex(TEXT), LV_PART_MAIN);
	lv_obj_set_style_border_width(magnifier, 2, LV_PART_MAIN);
	/* Vertically centred by padding rather than by alignment: the label owns a fixed box here and a
	 * 40 px glyph in a 108 px box otherwise sits against the top edge. */
	lv_obj_set_style_pad_top(magnifier, (MAG_H - 56) / 2, LV_PART_MAIN);
	lv_obj_add_flag(magnifier, LV_OBJ_FLAG_HIDDEN);
	lv_obj_remove_flag(magnifier, LV_OBJ_FLAG_CLICKABLE);

	lv_obj_add_event_cb(keyboard, onKeyboardPressing, LV_EVENT_PRESSING, nullptr);
	lv_obj_add_event_cb(keyboard, onKeyboardReleased, LV_EVENT_RELEASED, nullptr);
	lv_obj_add_event_cb(keyboard, onKeyboardReleased, LV_EVENT_PRESS_LOST, nullptr);

	/* ---- result ---- */
	result_page = makePage(screen);
	result_headline = makeLabel(result_page, &lv_font_montserrat_40, TEXT, INSET, RESULT_HEADLINE_Y,
	                            INNER_W, LV_TEXT_ALIGN_CENTER);
	lv_label_set_text(result_headline, "");
	result_detail = makeLabel(result_page, &lv_font_montserrat_22, TEXT, INSET, RESULT_DETAIL_Y,
	                          INNER_W, LV_TEXT_ALIGN_CENTER);
	lv_label_set_text(result_detail, "");
	result_info = makeLabel(result_page, &lv_font_montserrat_18, MUTED, INSET, RESULT_INFO_Y, INNER_W,
	                        LV_TEXT_ALIGN_CENTER);
	lv_label_set_text(result_info, "");
	result_note = makeLabel(result_page, &lv_font_montserrat_18, FAINT, INSET, RESULT_NOTE_Y, INNER_W,
	                        LV_TEXT_ALIGN_CENTER);
	lv_label_set_text(result_note, "");

	result_retry = makeButton(result_page, INSET, RESULT_BUTTON_Y, RESULT_BUTTON_W, RESULT_BUTTON_H,
	                          "Try again", &lv_font_montserrat_22);
	lv_obj_add_event_cb(result_retry, onRetry, LV_EVENT_CLICKED, nullptr);
	result_dismiss = makeButton(result_page, PANEL_W - INSET - RESULT_BUTTON_W, RESULT_BUTTON_Y,
	                            RESULT_BUTTON_W, RESULT_BUTTON_H, "Back", &lv_font_montserrat_22,
	                            &result_dismiss_label);
	lv_obj_add_event_cb(result_dismiss, onDismiss, LV_EVENT_CLICKED, nullptr);

	showPage(pick_page);
}

/* ------------------------------------------------------------------------------------ tick ---- */

void tickScanning()
{
	const int16_t found = WiFi.scanComplete();
	if (found == WIFI_SCAN_RUNNING) {
		/* The elapsed count is redrawn once a second, not every pass: a label whose text is set to the
		 * same string is free in LVGL, but the seconds arithmetic and the snprintf are not, and this
		 * runs at loop speed. */
		const int seconds = (int)((millis() - scan_started_at) / 1000u);
		if (seconds != scan_seconds_shown) {
			scan_seconds_shown = seconds;
			refreshPickStatus();
		}
		return;
	}
	state = State::Picking;
	if (found > 0) collectScan(found);
	rebuildList();
	refreshPickStatus();
	setStatus("wi-fi: %d network%s found", network_count, network_count == 1 ? "" : "s");
}

void tickJoining()
{
	const wl_status_t now = WiFi.status();
	if (now == WL_CONNECTED) {
		state = State::Joined;
		/* The only call site. See `persist()`. */
		persist(attempt);
		showResult();
		setStatus("wi-fi: on %s at %s", attempt.ssid, WiFi.localIP().toString().c_str());
		return;
	}

	/*
	 * A refusal is an answer, and it arrives seconds before the timeout.
	 *
	 * `WL_CONNECT_FAILED` is what the core reports when the AP rejects the passphrase. Ignoring it —
	 * which is what `app/wifi_setup.cpp` did — means the one mistake this screen exists to let
	 * somebody correct takes twenty seconds to be reported, on a device somebody is standing in front
	 * of holding a phone with the password on it.
	 */
	if (now == WL_CONNECT_FAILED) {
		fail("The network refused that passphrase");
		return;
	}

	/* See `NO_SSID_GRACE_MS`: believed only once it has been the answer for a while. */
	if (now == WL_NO_SSID_AVAIL) {
		if (no_ssid_since == 0) no_ssid_since = millis();
		if (millis() - no_ssid_since > NO_SSID_GRACE_MS) {
			fail("No access point answered to that name");
			return;
		}
	} else {
		no_ssid_since = 0;
	}

	if (millis() - join_started_at > JOIN_TIMEOUT_MS) {
		fail("No answer in 20 seconds");
		return;
	}

	const int seconds = (int)((millis() - join_started_at) / 1000u);
	if (seconds != join_seconds_shown) {
		join_seconds_shown = seconds;
		char line[32];
		snprintf(line, sizeof(line), "%ds of 20", seconds);
		lv_label_set_text(result_info, line);
	}
}

/*
 * A saved network, rejoined quietly.
 *
 * This deliberately does not take the screen. A unit whose AP rebooted, or which walked out of range
 * for a minute, is not a unit that needs provisioning — and a setup screen that appears over a
 * working readout because a beacon was missed is worse than the thing it is reporting. What happens
 * instead is that `status()` stops saying "connected", which is the caller's to render, and a retry
 * goes out every thirty seconds until it comes back.
 */
void tickBackground()
{
	if (!have_saved || active()) return;
	if (WiFi.status() == WL_CONNECTED) {
		if (strncmp(status_text, "wi-fi: on ", 10) != 0) {
			setStatus("wi-fi: on %s at %s", saved_ssid, WiFi.localIP().toString().c_str());
		}
		last_retry_at = millis();
		return;
	}
	if (millis() - last_retry_at < RETRY_EVERY_MS) return;
	last_retry_at = millis();
	setStatus("wi-fi: %s not answering, retrying", saved_ssid);
	WiFi.mode(WIFI_STA);
	WiFi.begin(saved_ssid, saved_pass);
}

}  // namespace

/* ------------------------------------------------------------------------------ the interface -- */

void begin()
{
	booted_at = millis();
	last_retry_at = millis();
	loadCredentials();
	if (have_saved) {
		/*
		 * Start joining before anything asks for a network. It costs nothing to already be on the air
		 * by the time something wants to fetch, and the result is read from the radio rather than
		 * assumed — "present is not works", and a credential NVS returns is not a credential that
		 * associates.
		 */
		WiFi.mode(WIFI_STA);
		WiFi.begin(saved_ssid, saved_pass);
		setStatus("wi-fi: joining %s from memory", saved_ssid);
	} else {
		setStatus("wi-fi: no network saved on this unit");
	}
}

void tick()
{
	/*
	 * A unit with nothing saved opens setup by itself, once.
	 *
	 * This is the only automatic entry, and it is the discoverable one: there is no way for a person
	 * who has just unboxed a device to know about a hold gesture, and a panel showing a readout that
	 * cannot possibly be live is the "says nothing about why it is empty" failure. Once it has
	 * happened, it does not happen again — a person who closed this screen chose to.
	 */
	if (!auto_open_done && !have_saved && state == State::Closed &&
	    millis() - booted_at > AUTO_OPEN_MS) {
		auto_open_done = true;
		open();
	}

	switch (state) {
		case State::Scanning:
			tickScanning();
			break;
		case State::Joining:
			tickJoining();
			break;
		default:
			tickBackground();
			break;
	}
}

bool active()
{
	return state != State::Closed;
}

void open()
{
	build();
	lv_obj_t *current = lv_screen_active();
	/* Remembered only when it is somebody else's, so that a second `open()` while already on screen
	 * cannot set the return screen to this one and strand the caller here. */
	if (current != screen) return_screen = current;
	lv_screen_load(screen);
	startScan();
}

void close()
{
	state = State::Closed;
	/* Nothing typed survives leaving the screen, on principle: a passphrase left in a widget is a
	 * passphrase the next person to open this screen can reveal with one tap. */
	if (entry != nullptr) lv_textarea_set_text(entry, "");
	WiFi.scanDelete();
	if (return_screen != nullptr) lv_screen_load(return_screen);
	if (have_saved && WiFi.status() != WL_CONNECTED) {
		setStatus("wi-fi: %s saved, not connected", saved_ssid);
	} else if (!have_saved) {
		setStatus("wi-fi: no network saved on this unit");
	}
}

bool connected()
{
	return WiFi.status() == WL_CONNECTED;
}

const char *status()
{
	return status_text;
}

void attachOpenGesture(lv_obj_t *target)
{
	if (target == nullptr) return;
	lv_obj_add_event_cb(target, onHold, LV_EVENT_LONG_PRESSED, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_LONG_PRESSED_REPEAT, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_RELEASED, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_PRESS_LOST, nullptr);
}

}  // namespace pulse_wifi
