#include "pulse_wifi.h"

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "pulse_design.h"
#include "pulse_keypad.h"

namespace pulse_wifi {

namespace {

using namespace pulse_design;

/* ------------------------------------------------------------------------------- the screens --- */

/*
 * Three of the four archetypes, and this file draws none of them itself.
 *
 * Eleven colour constants and every metric on these pages used to live here, duplicated from
 * `pulse_ui.cpp` under a comment explaining that two files agreeing on eight constants was cheaper
 * than a header to hold them. It was not: the duplication is what let the pick page's button row go
 * on being 109 px wide after `INSET` moved from 12 to 20, which put the "Close" button's right edge
 * five pixels from the panel edge — inside the rounded corner, on the first screen a stranger sees.
 * The row is derived from `SAFE_W` in `pulse_design.cpp` now and that class of drift has one place
 * to be fixed.
 *
 * What stays here is everything this module is actually about: the radio, the credential, the state
 * machine, and what a tap on any of these objects means.
 */
ChooserView pick;
InputView typing;
StatusView result;

/* Which of the result screen's two buttons is which. They live in the status archetype's action row,
 * which is a flex container — so they are positioned by it rather than by a coordinate, which is
 * what fixes the thing the old layout had to special-case: a lone button sat where the right-hand
 * one of a pair goes, leaving a 166 px hole beside it that read as a second button that failed to
 * draw. Hiding one now simply re-centres the other. */
lv_obj_t *result_retry = nullptr;
lv_obj_t *result_retry_label = nullptr;
lv_obj_t *result_dismiss = nullptr;
lv_obj_t *result_dismiss_label = nullptr;

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
constexpr size_t WIFI_PASS_MAX = 63;   /* WPA2-PSK passphrase maximum */
constexpr size_t PASS_MIN = 8;    /* and its minimum, which is worth saying before a join, not after */
constexpr int MAX_NETWORKS = 32;  /* what the list keeps; it scrolls, so this is memory, not a view */
constexpr size_t MAX_PROFILES = 4;
constexpr size_t PROFILE_BLOB_MAX =
    4 + MAX_PROFILES * (SSID_MAX * 2 + 1 + WIFI_PASS_MAX * 2 + 1);

enum class State : uint8_t {
	Closed,     /* not on screen */
	Scanning,   /* on screen, waiting for the radio */
	Picking,    /* on screen, a list to choose from */
	TypingSsid, /* on screen, a hidden network's name */
	TypingPass, /* on screen, a passphrase */
	Joining,    /* on screen, waiting for the radio */
	Joined,     /* on screen, it worked */
	Failed,     /* on screen, it did not, and why */
	ConfirmForget,
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
	char pass[WIFI_PASS_MAX + 1];
	bool open;
};

struct Profile {
	char ssid[SSID_MAX + 1];
	char pass[WIFI_PASS_MAX + 1];
};

State state = State::Closed;
bool built = false;
bool auto_open_done = false;
uint32_t booted_at = 0;

Preferences prefs;
bool have_saved = false;
char saved_ssid[SSID_MAX + 1] = {0};
char saved_pass[WIFI_PASS_MAX + 1] = {0};
uint32_t last_retry_at = 0;
uint32_t network_revision = 1;
Profile profiles[MAX_PROFILES];
size_t profile_count = 0;
bool joined_saved = true;

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

void setStatus(const char *format, ...)
{
	va_list args;
	va_start(args, format);
	vsnprintf(status_text, sizeof(status_text), format, args);
	va_end(args);
}

void showPage(lv_obj_t *page)
{
	if (pick.page == nullptr) return;
	lv_obj_t *const pages[3] = {pick.page, typing.page, result.page};
	for (lv_obj_t *one : pages) {
		if (one == page) {
			lv_obj_remove_flag(one, LV_OBJ_FLAG_HIDDEN);
		} else {
			lv_obj_add_flag(one, LV_OBJ_FLAG_HIDDEN);
		}
	}
}

/* ------------------------------------------------------------------------------- credentials --- */

int profileIndex(const char *ssid)
{
	if (ssid == nullptr || ssid[0] == '\0') return -1;
	for (size_t i = 0; i < profile_count; i++) {
		if (strcmp(profiles[i].ssid, ssid) == 0) return (int)i;
	}
	return -1;
}

char hexDigit(uint8_t value)
{
	return value < 10 ? (char)('0' + value) : (char)('a' + value - 10);
}

int hexValue(char value)
{
	if (value >= '0' && value <= '9') return value - '0';
	if (value >= 'a' && value <= 'f') return value - 'a' + 10;
	if (value >= 'A' && value <= 'F') return value - 'A' + 10;
	return -1;
}

bool appendHex(char *blob, size_t capacity, size_t &used, const char *value)
{
	for (const uint8_t *at = (const uint8_t *)value; *at != 0; at++) {
		if (used + 2 >= capacity) return false;
		blob[used++] = hexDigit(*at >> 4);
		blob[used++] = hexDigit(*at & 0x0f);
	}
	return true;
}

bool encodeProfiles(const Profile *source, size_t count, char *blob, size_t capacity)
{
	if (blob == nullptr || capacity < 4 || count > MAX_PROFILES) return false;
	size_t used = 0;
	blob[used++] = 'v';
	blob[used++] = '1';
	blob[used++] = ';';
	for (size_t i = 0; i < count; i++) {
		if (source[i].ssid[0] == '\0' || !appendHex(blob, capacity, used, source[i].ssid)) return false;
		if (used + 1 >= capacity) return false;
		blob[used++] = ',';
		if (!appendHex(blob, capacity, used, source[i].pass)) return false;
		if (used + 1 >= capacity) return false;
		blob[used++] = ';';
	}
	blob[used] = '\0';
	return true;
}

bool decodeHex(const char *begin, const char *end, char *out, size_t capacity)
{
	const size_t encoded = (size_t)(end - begin);
	if ((encoded & 1u) != 0 || encoded / 2 >= capacity) return false;
	size_t used = 0;
	for (const char *at = begin; at < end; at += 2) {
		const int high = hexValue(at[0]);
		const int low = hexValue(at[1]);
		if (high < 0 || low < 0) return false;
		const char value = (char)((high << 4) | low);
		if (value == '\0') return false;
		out[used++] = value;
	}
	out[used] = '\0';
	return true;
}

bool decodeProfiles(const char *blob, Profile *target, size_t &count)
{
	count = 0;
	if (blob == nullptr || strncmp(blob, "v1;", 3) != 0) return false;
	const char *at = blob + 3;
	while (*at != '\0') {
		if (count == MAX_PROFILES) return false;
		const char *comma = strchr(at, ',');
		if (comma == nullptr) return false;
		const char *end = strchr(comma + 1, ';');
		if (end == nullptr || comma == at) return false;
		if (!decodeHex(at, comma, target[count].ssid, sizeof(target[count].ssid)) ||
		    !decodeHex(comma + 1, end, target[count].pass, sizeof(target[count].pass))) {
			return false;
		}
		count++;
		at = end + 1;
	}
	return true;
}

void activateProfiles(const Profile *source, size_t count)
{
	memset(profiles, 0, sizeof(profiles));
	if (count > 0) memcpy(profiles, source, count * sizeof(Profile));
	profile_count = count;
	have_saved = count > 0;
	if (have_saved) {
		snprintf(saved_ssid, sizeof(saved_ssid), "%s", profiles[0].ssid);
		snprintf(saved_pass, sizeof(saved_pass), "%s", profiles[0].pass);
	} else {
		saved_ssid[0] = '\0';
		saved_pass[0] = '\0';
	}
}

bool writeCanonicalProfiles(const Profile *source, size_t count)
{
	char blob[PROFILE_BLOB_MAX];
	if (!encodeProfiles(source, count, blob, sizeof(blob))) return false;
	prefs.begin("anchor-wifi", false);
	const size_t written = prefs.putString("profiles", blob);
	prefs.end();
	return written == strlen(blob);
}

void writeLegacyActive()
{
	prefs.begin("anchor-wifi", false);
	if (have_saved) {
		prefs.putString("ssid", saved_ssid);
		if (saved_pass[0] == '\0') {
			prefs.remove("pass");
		} else {
			prefs.putString("pass", saved_pass);
		}
	} else {
		prefs.remove("ssid");
		prefs.remove("pass");
	}
	prefs.end();
}

void loadCredentials()
{
	prefs.begin("anchor-wifi", true);
	const String blob = prefs.getString("profiles", "");
	const String legacy_ssid = prefs.getString("ssid", "");
	const String legacy_pass = prefs.getString("pass", "");
	prefs.end();

	Profile loaded[MAX_PROFILES] = {};
	size_t loaded_count = 0;
	if (blob.length() < PROFILE_BLOB_MAX && decodeProfiles(blob.c_str(), loaded, loaded_count)) {
		activateProfiles(loaded, loaded_count);
		return;
	}

	if (legacy_ssid.length() == 0 || legacy_ssid.length() > SSID_MAX ||
	    legacy_pass.length() > WIFI_PASS_MAX) {
		activateProfiles(loaded, 0);
		return;
	}
	snprintf(loaded[0].ssid, sizeof(loaded[0].ssid), "%s", legacy_ssid.c_str());
	snprintf(loaded[0].pass, sizeof(loaded[0].pass), "%s", legacy_pass.c_str());
	activateProfiles(loaded, 1);
	/* A failed migration leaves the legacy credential intact and usable. */
	writeCanonicalProfiles(loaded, 1);
}

void makeCandidate(const char *ssid, const char *pass, Profile *candidate, size_t &count)
{
	memset(candidate, 0, MAX_PROFILES * sizeof(Profile));
	const int existing = profileIndex(ssid);
	snprintf(candidate[0].ssid, sizeof(candidate[0].ssid), "%s", ssid);
	snprintf(candidate[0].pass, sizeof(candidate[0].pass), "%s", pass == nullptr ? "" : pass);
	count = 1;
	for (size_t i = 0; i < profile_count && count < MAX_PROFILES; i++) {
		if ((int)i == existing) continue;
		candidate[count++] = profiles[i];
	}
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
bool persist(const Attempt &joined)
{
	const int existing = profileIndex(joined.ssid);
	const bool already_active =
	    strcmp(saved_ssid, joined.ssid) == 0 && strcmp(saved_pass, joined.pass) == 0;
	const bool already_profile = existing >= 0 && strcmp(profiles[existing].pass, joined.pass) == 0;
	if (already_active && already_profile && existing == 0) return true;
	Profile candidate[MAX_PROFILES];
	size_t candidate_count = 0;
	makeCandidate(joined.ssid, joined.pass, candidate, candidate_count);
	if (!writeCanonicalProfiles(candidate, candidate_count)) return false;
	activateProfiles(candidate, candidate_count);
	writeLegacyActive();
	return true;
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
void onForgetPicked(lv_event_t *event);

/* How far the signal line is indented: the Wi-Fi glyph plus the gap after it, measured below. */
constexpr int32_t NETWORK_META_INDENT = 40;

/*
 * A network row is a tap target, so it is taller and larger than a chooser's default.
 *
 * At the chooser's 20 px face and 12 px padding a row was 46 px, about 3.6 mm on this glass, which the
 * first physical session reported as too small to read or hit. The name is 24 px now. Signal and
 * security sit on a second line under it (see `rebuildList`), because on one line at this size they
 * left the name five characters and "HomeNet" read as "Home...".
 */
void styleNetworkRow(lv_obj_t *row)
{
	styleChooserRow(row);
	lv_obj_set_style_text_font(row, type::heading(), LV_PART_MAIN);
	lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW_WRAP);
	lv_obj_set_style_pad_row(row, space::xs, LV_PART_MAIN);
}

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
	if (pick.list == nullptr) return;
	lv_obj_clean(pick.list);
	for (int i = 0; i < network_count; i++) {
		lv_obj_t *row = lv_list_add_button(pick.list, LV_SYMBOL_WIFI, networks[i].ssid);
		styleNetworkRow(row);

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
		lv_obj_set_style_text_font(meta, type::label(), LV_PART_MAIN);
		/* A full-width item in a wrapping row starts a line of its own, indented to line up under the
		 * name rather than under the icon. */
		lv_obj_set_width(meta, LV_PCT(100));
		lv_obj_set_style_pad_left(meta, NETWORK_META_INDENT, LV_PART_MAIN);
		/*
		 * `Warn` for an open network, not `Bad`.
		 *
		 * It was the red the P&L uses for one render, and on the glass that reads as an error rather
		 * than as a caution: an open network is a perfectly joinable network that happens to carry no
		 * encryption, and the row is not a failure. `Warn` is the one role in this palette that says
		 * "notice this" without saying "this went wrong", which is exactly the distinction wanted —
		 * and naming roles by meaning is what makes picking the wrong one harder next time.
		 */
		lv_obj_set_style_text_color(
		    meta, hex(toneColour(networks[i].open ? Tone::Warn : Tone::Quiet)), LV_PART_MAIN);

		lv_obj_set_user_data(row, (void *)(intptr_t)i);
		lv_obj_add_event_cb(row, onNetworkPicked, LV_EVENT_CLICKED, nullptr);
	}
	if (profile_count > 0) {
		lv_obj_t *forget = lv_list_add_button(pick.list, nullptr, "Forget saved networks...");
		/* A secondary action keeps the chooser's 20 px face, which fits its sentence, and takes the
		 * network rows' height so it is as easy to hit. At 24 px the sentence overran the row and the
		 * list button's default circular scroll slid it sideways. */
		styleChooserRow(forget);
		lv_obj_set_style_pad_ver(forget, space::lg, LV_PART_MAIN);
		lv_obj_t *forget_label = lv_obj_get_child(forget, -1);
		if (forget_label != nullptr && lv_obj_check_type(forget_label, &lv_label_class)) {
			lv_label_set_long_mode(forget_label, LV_LABEL_LONG_DOT);
			lv_obj_set_flex_grow(forget_label, 1);
		}
		lv_obj_add_event_cb(forget, onForgetPicked, LV_EVENT_CLICKED, nullptr);
	}
}

/* --------------------------------------------------------------------------------- the pages --- */

void refreshPickStatus()
{
	if (pick.subtitle == nullptr) return;
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
	lv_label_set_text(pick.subtitle, line);
}

/*
 * The join result, on the same status archetype the ambient screen uses for "Not set up".
 *
 * That is the point of having archetypes at all: a unit saying "Joining" during setup and a unit
 * saying "Joining" at rest are the same fact at two moments, and before this they were two different
 * screens built by two different files that happened to agree about a font. Now the only difference
 * is that this one has buttons.
 *
 * `result_info_text` is a buffer rather than a label pointer because the failure reason arrives from
 * `fail()` and the elapsed count from `tickJoining()`, both of which used to write straight into the
 * label. The archetype is repainted wholesale from a `StatusCopy`, so the text has to survive
 * between repaints somewhere this function can read it.
 */
char result_info_text[96] = "";

void showResult()
{
	showPage(result.page);
	StatusCopy copy;
	copy.eyebrow = "WI-FI";
	copy.detail = attempt.ssid;
	copy.support = result_info_text;
	switch (state) {
		case State::Joining:
			copy.headline = "Joining";
			copy.tone = Tone::Accent;
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
			snprintf(result_info_text, sizeof(result_info_text), "0s of 20");
			copy.support = result_info_text;
			lv_obj_add_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_add_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			break;
		case State::Joined:
			copy.headline = "Connected";
			copy.tone = Tone::Good;
			snprintf(result_info_text, sizeof(result_info_text), "%s",
			         WiFi.localIP().toString().c_str());
			copy.support = result_info_text;
			copy.note = joined_saved ? "Saved on this unit." : "Connected, but could not save.";
			lv_obj_add_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_remove_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			lv_label_set_text(result_dismiss_label, "Done");
			break;
		case State::Failed:
			copy.headline = "Did not join";
			copy.tone = Tone::Bad;
			/* `result_info_text` is written by whoever decided it failed, so the reason survives to
			 * here. */
			copy.note = "Nothing was saved.";
			lv_obj_remove_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_remove_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			lv_label_set_text(result_retry_label, "Try again");
			lv_label_set_text(result_dismiss_label, "Back");
			break;
		case State::ConfirmForget:
			copy.headline = "Forget networks?";
			copy.detail = "All saved Wi-Fi profiles";
			copy.tone = Tone::Warn;
			copy.support = result_info_text;
			lv_obj_remove_flag(result_retry, LV_OBJ_FLAG_HIDDEN);
			lv_obj_remove_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
			lv_label_set_text(result_retry_label, "Forget");
			lv_label_set_text(result_dismiss_label, "Cancel");
			break;
		default:
			break;
	}
	/*
	 * The action row itself goes when both buttons do.
	 *
	 * A flex container with nothing visible in it is still 56 px of reserved height, and on the
	 * joining screen — the one with no buttons at all — that is a rectangle of nothing between the
	 * elapsed count and the bottom of the panel. Hiding the row is what lets the composition recentre
	 * on what is actually being said, which is the whole reason this archetype is a flex column.
	 */
	const bool any_action = !lv_obj_has_flag(result_retry, LV_OBJ_FLAG_HIDDEN) ||
	                        !lv_obj_has_flag(result_dismiss, LV_OBJ_FLAG_HIDDEN);
	if (any_action) {
		lv_obj_remove_flag(result.actions, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_add_flag(result.actions, LV_OBJ_FLAG_HIDDEN);
	}
	applyStatus(result, copy);
}

void startScan()
{
	state = State::Scanning;
	network_count = 0;
	scan_started_at = millis();
	scan_seconds_shown = -1;
	rebuildList();
	showPage(pick.page);
	refreshPickStatus();
	WiFi.mode(WIFI_STA);
	WiFi.scanDelete();
	WiFi.scanNetworks(true /* async: this must not block the UI thread */);
	setStatus("wi-fi: scanning");
}

void startTyping(const char *ssid, bool for_ssid, bool open)
{
	/* Remember the archetype's width rather than copying its reveal-button arithmetic here. */
	static int32_t password_field_width = 0;
	if (password_field_width == 0) password_field_width = lv_obj_get_width(typing.field);
	typing_ssid = for_ssid;
	pending_open = open;
	snprintf(pending_ssid, sizeof(pending_ssid), "%s", ssid == nullptr ? "" : ssid);

	/*
	 * The field starts empty every time, and that is the other half of the wrong-passphrase fix.
	 * `app/wifi_setup.cpp` left `entry` populated across a cancel, which is how three characters
	 * typed for one network ended up saved against another.
	 */
	lv_textarea_set_text(typing.field, "");
	lv_textarea_set_password_mode(typing.field, !for_ssid);
	lv_textarea_set_max_length(typing.field, for_ssid ? (uint32_t)SSID_MAX : (uint32_t)WIFI_PASS_MAX);
	lv_label_set_text(typing.reveal_label, LV_SYMBOL_EYE_OPEN);
	pulse_keypad::reset(typing.keyboard, for_ssid ? "Next" : "Join");
	lv_textarea_set_placeholder_text(typing.field, for_ssid ? "Network name" : "passphrase");
	lv_obj_set_width(typing.field, for_ssid ? SAFE_W : password_field_width);
	if (for_ssid) {
		lv_obj_add_flag(typing.reveal, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_remove_flag(typing.reveal, LV_OBJ_FLAG_HIDDEN);
	}

	lv_obj_set_style_text_color(typing.subtitle, hex(colour::ink_dim), LV_PART_MAIN);
	if (for_ssid) {
		lv_label_set_text(typing.title, "Hidden network");
		lv_label_set_text(typing.subtitle, "Type the name, then Next");
	} else {
		lv_label_set_text(typing.title, pending_ssid);
		lv_label_set_text(typing.subtitle, open ? "Open network, no passphrase"
		                                          : "Passphrase, at least 8");
	}
	state = for_ssid ? State::TypingSsid : State::TypingPass;
	showPage(typing.page);
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
	if (++network_revision == 0) network_revision = 1;

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
	snprintf(result_info_text, sizeof(result_info_text), "%s", reason == nullptr ? "" : reason);
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
		const int saved = profileIndex(net.ssid);
		if (saved >= 0) {
			/* A profile exists only after a successful join. Reuse it for switching without asking the
			 * person holding the unit to type the same passphrase again. A refusal still leaves the
			 * profile intact and Try again opens the keyboard for a changed passphrase. */
			startJoin(net.ssid, profiles[saved].pass, false);
		} else {
			startTyping(net.ssid, false, false);
		}
	}
}

void onForgetPicked(lv_event_t *event)
{
	(void)event;
	state = State::ConfirmForget;
	snprintf(result_info_text, sizeof(result_info_text), "This unit will go offline.");
	showResult();
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
	const bool hidden = lv_textarea_get_password_mode(typing.field);
	lv_textarea_set_password_mode(typing.field, !hidden);
	lv_label_set_text(typing.reveal_label, hidden ? LV_SYMBOL_EYE_CLOSE : LV_SYMBOL_EYE_OPEN);
}

/* The keypad's submit key. `pulse_keypad` raises `LV_EVENT_READY` from it and from nothing else, so
 * there is exactly one place a submission arrives from and no geometry deciding what a tap meant. */
void onKeyboardReady(lv_event_t *event)
{
	(void)event;
	const char *typed = lv_textarea_get_text(typing.field);
	if (typed == nullptr) typed = "";

	/* The subtitle is where a refusal lands, and it changes colour to say so. It said the same thing
	 * in the same grey as the instruction it replaced for one render, and a line that only changes
	 * its words is a line somebody re-reads twice before noticing it moved. */
	if (state == State::TypingSsid) {
		if (typed[0] == '\0') {
			lv_obj_set_style_text_color(typing.subtitle, hex(colour::bad), LV_PART_MAIN);
			lv_label_set_text(typing.subtitle, "A network needs a name");
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
		lv_obj_set_style_text_color(typing.subtitle, hex(colour::bad), LV_PART_MAIN);
		lv_label_set_text(typing.subtitle, "Too short: at least 8");
		return;
	}
	startJoin(pending_ssid, typed, pending_open);
}

/* The input's cancel button: back to the list, and the field is cleared on the way in next time. */
void onKeyboardCancel(lv_event_t *event)
{
	(void)event;
	state = State::Picking;
	showPage(pick.page);
	refreshPickStatus();
}

void onCancelTapped(lv_event_t *event)
{
	(void)event;
	pulse_keypad::cancel(typing.keyboard);
}

void onRetry(lv_event_t *event)
{
	(void)event;
	if (state == State::ConfirmForget) {
		if (clearSaved()) {
			startScan();
		} else {
			snprintf(result_info_text, sizeof(result_info_text), "Could not update saved networks.");
			showResult();
		}
		return;
	}
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
	showPage(pick.page);
	rebuildList();
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

	/*
	 * Its own LVGL screen, not a region of somebody else's.
	 *
	 * `open()` remembers whatever screen was active and `close()` puts it back, so the ambient readout
	 * in `pulse_ui.cpp` is never rebuilt, never partly overdrawn, and does not have to know this module
	 * exists. That is also why the whole thing is four calls from `pulse.ino`.
	 */
	screen = lv_obj_create(nullptr);
	paintGround(screen);

	/* ---- the chooser ---- */
	pick = buildChooser(screen, "Wi-Fi", "Rescan", "Hidden", "Close");
	lv_obj_add_event_cb(pick.action[0], onRescan, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(pick.action[1], onHidden, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(pick.action[2], onCloseTapped, LV_EVENT_CLICKED, nullptr);

	/* ---- the input ---- */
	typing = buildInput(screen, "passphrase");
	lv_textarea_set_password_mode(typing.field, true);
	lv_obj_add_event_cb(typing.reveal, onReveal, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(typing.keyboard, onKeyboardReady, LV_EVENT_READY, nullptr);
	lv_obj_add_event_cb(typing.keyboard, onKeyboardCancel, LV_EVENT_CANCEL, nullptr);
	lv_obj_add_event_cb(typing.cancel, onCancelTapped, LV_EVENT_CLICKED, nullptr);

	/* ---- the result, which is the status archetype with two buttons in it ---- */
	result = buildStatus(screen, true /* with actions */);
	result_retry = makeButton(result.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H, "Try again",
	                          type::subhead(), &result_retry_label);
	lv_obj_add_event_cb(result_retry, onRetry, LV_EVENT_CLICKED, nullptr);
	result_dismiss = makeButton(result.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H, "Back",
	                            type::subhead(), &result_dismiss_label);
	lv_obj_add_event_cb(result_dismiss, onDismiss, LV_EVENT_CLICKED, nullptr);

	showPage(pick.page);
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
		joined_saved = persist(attempt);
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
		/* Straight into the archetype's support slot rather than through `showResult()`, which would
		 * re-apply the whole status once a second — including the headline font lookup — for a label
		 * that gained one character. */
		snprintf(result_info_text, sizeof(result_info_text), "%ds of 20", seconds);
		lv_label_set_text(result.support, result_info_text);
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
	if (typing.field != nullptr) lv_textarea_set_text(typing.field, "");
	WiFi.scanDelete();
	if (return_screen != nullptr) lv_screen_load(return_screen);
	if (have_saved && WiFi.status() != WL_CONNECTED) {
		/* A failed replacement never overwrites the last good profile. Restore it immediately rather
		 * than waiting thirty seconds with the radio still aimed at the rejected credential. */
		if (strcmp(attempt.ssid, saved_ssid) != 0 || strcmp(attempt.pass, saved_pass) != 0) {
			if (++network_revision == 0) network_revision = 1;
			WiFi.mode(WIFI_STA);
			WiFi.begin(saved_ssid, saved_pass);
			last_retry_at = millis();
			setStatus("wi-fi: restoring %s", saved_ssid);
		} else {
			setStatus("wi-fi: %s saved, not connected", saved_ssid);
		}
	} else if (!have_saved) {
		setStatus("wi-fi: no network saved on this unit");
	}
}

bool connected()
{
	return WiFi.status() == WL_CONNECTED;
}

bool configured()
{
	return have_saved;
}

uint32_t revision()
{
	return network_revision;
}

bool clearSaved()
{
	Profile empty[MAX_PROFILES] = {};
	if (!writeCanonicalProfiles(empty, 0)) return false;
	activateProfiles(empty, 0);
	writeLegacyActive();
	if (++network_revision == 0) network_revision = 1;
	WiFi.disconnect();
	setStatus("wi-fi: no network saved on this unit");
	return true;
}

const char *status()
{
	return status_text;
}

/*
 * A plain tap reopens setup while no network is saved.
 *
 * The hold below is the right gesture for a *provisioned* unit: it takes deliberate contact, so an
 * ambient display nobody is using cannot be knocked into a settings screen by a sleeve. It is the
 * wrong and only gesture for an unprovisioned one. Somebody closed the picker, read "wi-fi / not set
 * up", and had no way back in — the way back was 1.4 seconds of continuous contact that nothing on
 * the screen mentions, on a controller that until recently dropped contact mid-press anyway.
 *
 * With nothing saved there is nothing else this screen can usefully do, so the whole of it is the
 * button. The ambient screen says so in as many words; see `pulse_feed_view.cpp`.
 */
void onTapWhenUnset(lv_event_t *event)
{
	(void)event;
	if (have_saved) return;
	open();
}

void attachOpenGesture(lv_obj_t *target)
{
	if (target == nullptr) return;
	lv_obj_add_event_cb(target, onTapWhenUnset, LV_EVENT_SHORT_CLICKED, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_LONG_PRESSED, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_LONG_PRESSED_REPEAT, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_RELEASED, nullptr);
	lv_obj_add_event_cb(target, onHold, LV_EVENT_PRESS_LOST, nullptr);
}

}  // namespace pulse_wifi
