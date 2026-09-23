#include "pulse_explore.h"

#include <stdio.h>
#include <string.h>

#include "../../common/token_identity.h"
#include "pulse_design.h"

namespace pulse_explore {
namespace {
using namespace pulse_design;
constexpr size_t CAPACITY = 8;
struct Row {
	char symbol[12]{}, name[24]{}, price[16]{}, change[10]{}, volume[16]{};
	char chain[anchor_identity::CHAIN_MAX]{}, address[anchor_identity::ADDRESS_MAX]{};
	bool positive = false;
};
enum class Page { List, Token, Portfolio };
Page page = Page::List;
Row rows[CAPACITY], selected, pressed;
size_t count = 0;
bool pressedValid = false, selectedPresent = false;
uint32_t selectedAge = 0, selectedAt = 0, nowMs = 0;
uint32_t listAge = 0, listAt = 0, pressedAge = 0, pressedAt = 0;
pulse_feed_view::Status listState = pulse_feed_view::Status::Joining;
uint16_t visibleRows = 0;
char listStatus[96]{}, portfolioStatus[96]{};
char portfolioTotal[24]{}, portfolioNfts[24]{}, portfolioChange[16]{}, coverage[40]{};
bool portfolioPositive = false, portfolioPartial = false;
lv_obj_t *screen = nullptr, *previous = nullptr;
ChooserView chooser;
/* Each row is two labels: a large one for the thing being read and a small one that says what it is.
 * One 20 px label per row was reported from the physical unit as far too small to read. */
lv_obj_t *rowButtons[CAPACITY]{}, *rowTop[CAPACITY]{}, *rowBottom[CAPACITY]{};
Action wifi = nullptr;

template <size_t N>
void copy(char (&out)[N], const char *text)
{
	snprintf(out, N, "%s", text == nullptr ? "" : text);
}

bool same(const Row &a, const Row &b)
{
	return anchor_identity::sameTokenIdentity(a.chain, a.address, b.chain, b.address);
}

bool readRow(const pulse_feed_view::Token &in, Row &out)
{
	if (!anchor_identity::sameTokenIdentity(in.chain, in.address, in.chain, in.address)) {
		return false;
	}
	copy(out.symbol, in.symbol);
	copy(out.name, in.name);
	copy(out.price, in.price);
	copy(out.change, in.change);
	copy(out.volume, in.volume);
	copy(out.chain, in.chain);
	copy(out.address, in.address);
	out.positive = in.changePositive;
	return true;
}

void describe(char *out, size_t size, pulse_feed_view::Status status, const char *reason,
              bool haveData, uint32_t age)
{
	char elapsed[24];
	pulse_feed_view::formatAge(age, elapsed, sizeof(elapsed));
	const bool healthy = status == pulse_feed_view::Status::Online;
	const bool fetching = status == pulse_feed_view::Status::Fetching;
	if (haveData) {
		snprintf(out, size, "%s | %s",
		         healthy    ? "OpenSea"
		         : fetching ? "Refreshing"
		                    : "Offline / stale",
		         elapsed);
	} else {
		snprintf(out, size, "%s", reason != nullptr && reason[0] ? reason : "Waiting for OpenSea");
	}
}

struct Row2 {
	const char *big = "";
	const char *small = "";
	Tone bigTone = Tone::Ink;
	Tone smallTone = Tone::Quiet;
	/* A reading puts its label above the value; a list row puts its detail below the name. */
	bool smallFirst = false;
	const lv_font_t *bigFont = nullptr;
};

void setText(lv_obj_t *label, const char *text, const lv_font_t *font, Tone tone)
{
	const bool empty = text == nullptr || text[0] == '\0';
	if (empty) {
		lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
		return;
	}
	lv_obj_remove_flag(label, LV_OBJ_FLAG_HIDDEN);
	lv_label_set_text(label, text);
	lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
	lv_obj_set_style_text_color(label, hex(toneColour(tone)), LV_PART_MAIN);
}

void line(size_t index, const Row2 &row, bool clickable = false)
{
	visibleRows |= (uint16_t)(1u << index);
	lv_obj_remove_flag(rowButtons[index], LV_OBJ_FLAG_HIDDEN);
	if (clickable) {
		lv_obj_add_flag(rowButtons[index], LV_OBJ_FLAG_CLICKABLE);
	} else {
		lv_obj_remove_flag(rowButtons[index], LV_OBJ_FLAG_CLICKABLE);
	}
	const lv_font_t *big = row.bigFont != nullptr ? row.bigFont : type::title();
	lv_obj_t *bigLabel = row.smallFirst ? rowBottom[index] : rowTop[index];
	lv_obj_t *smallLabel = row.smallFirst ? rowTop[index] : rowBottom[index];
	setText(bigLabel, row.big, big, row.bigTone);
	setText(smallLabel, row.small, type::body(), row.smallTone);
}

Tone changeTone(const char *change, bool positive)
{
	return change == nullptr || change[0] == '\0' || strcmp(change, "--") == 0 ? Tone::Quiet
	       : positive                                                          ? Tone::Good
	                                                                           : Tone::Bad;
}

void render()
{
	if (screen == nullptr) {
		return;
	}
	visibleRows = 0;
	char text[112];
	char detail[112];
	if (page == Page::List) {
		lv_label_set_text(chooser.title, "Explore");
		lv_label_set_text(chooser.subtitle, listStatus);
		for (size_t i = 0; i < count; ++i) {
			// Bound every array field explicitly, including under GCC's fortified snprintf checks.
			snprintf(text, sizeof(text), "%.11s  %.15s", rows[i].symbol, rows[i].price);
			snprintf(detail, sizeof(detail), "%.15s | %.9s", rows[i].chain, rows[i].change);
			Row2 row;
			row.big = text;
			row.small = detail;
			row.smallTone = changeTone(rows[i].change, rows[i].positive);
			line(i, row, true);
		}
		if (count == 0) {
			Row2 row;
			row.big = "No tokens yet";
			row.small = "Use Wi-Fi to connect or change networks.";
			row.bigTone = Tone::Quiet;
			row.bigFont = type::heading();
			line(0, row);
		}
	} else if (page == Page::Token) {
		lv_label_set_text(chooser.title, selected.symbol);
		char age[24];
		const uint64_t elapsed = (uint64_t)selectedAge + (uint32_t)(nowMs - selectedAt);
		pulse_feed_view::formatAge(elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed, age,
		                           sizeof(age));
		snprintf(text, sizeof(text), "%s | %s",
		         selectedPresent && listState == pulse_feed_view::Status::Online ? "OpenSea"
		         : selectedPresent && listState == pulse_feed_view::Status::Fetching
		             ? "Refreshing"
		             : "Saved / stale",
		         age);
		lv_label_set_text(chooser.subtitle, text);
		Row2 name;
		name.big = selected.name;
		name.small = selected.chain;
		name.bigFont = type::heading();
		line(0, name);
		Row2 price;
		price.big = selected.price;
		price.small = "Price";
		price.smallFirst = true;
		line(1, price);
		Row2 change;
		change.big = selected.change;
		change.small = "24h change";
		change.bigTone = changeTone(selected.change, selected.positive);
		change.smallFirst = true;
		line(2, change);
		Row2 volume;
		volume.big = selected.volume;
		volume.small = "24h volume";
		volume.smallFirst = true;
		line(3, volume);
		Row2 address;
		address.big = selected.address;
		address.small = "Token address";
		address.bigTone = Tone::Quiet;
		address.bigFont = type::body();
		address.smallFirst = true;
		line(4, address);
		if (!selectedPresent) {
			Row2 gone;
			gone.big = "Not in the latest list";
			gone.small = "Its last reading is kept.";
			gone.bigTone = Tone::Warn;
			gone.smallTone = Tone::Warn;
			gone.bigFont = type::heading();
			line(5, gone);
		}
	} else {
		lv_label_set_text(chooser.title, "Portfolio");
		lv_label_set_text(chooser.subtitle, portfolioStatus);
		snprintf(text, sizeof(text), "Total | %s", coverage);
		Row2 total;
		total.big = portfolioTotal;
		total.small = text;
		total.bigTone = portfolioPartial ? Tone::Warn : Tone::Ink;
		total.smallTone = portfolioPartial ? Tone::Warn : Tone::Quiet;
		total.smallFirst = true;
		line(0, total);
		Row2 change;
		change.big = portfolioChange;
		change.small = "24h change";
		change.bigTone = changeTone(portfolioChange, portfolioPositive);
		change.smallFirst = true;
		line(1, change);
		Row2 nfts;
		nfts.big = portfolioNfts;
		nfts.small = "NFT value";
		nfts.smallFirst = true;
		line(2, nfts);
	}
	for (size_t i = 0; i < CAPACITY; ++i) {
		if ((visibleRows & (1u << i)) == 0) {
			lv_obj_add_flag(rowButtons[i], LV_OBJ_FLAG_HIDDEN);
		}
	}
}

void onRow(lv_event_t *event)
{
	const size_t index = (size_t)(uintptr_t)lv_event_get_user_data(event);
	if (page != Page::List || index >= count) {
		return;
	}
	if (lv_event_get_code(event) == LV_EVENT_PRESSED) {
		pressed = rows[index];
		pressedAge = listAge;
		pressedAt = listAt;
		pressedValid = true;
	} else if (lv_event_get_code(event) == LV_EVENT_CLICKED && pressedValid) {
		selected = pressed;
		selectedAge = pressedAge;
		selectedAt = pressedAt;
		selectedPresent = false;
		for (size_t i = 0; i < count; ++i) {
			if (same(selected, rows[i])) {
				selectedPresent = true;
			}
		}
		pressedValid = false;
		page = Page::Token;
		lv_obj_scroll_to_y(chooser.list, 0, LV_ANIM_OFF);
		render();
	}
}

void onBack(lv_event_t *)
{
	if (page == Page::List) {
		close();
	} else {
		page = Page::List;
		lv_obj_scroll_to_y(chooser.list, 0, LV_ANIM_OFF);
		render();
	}
}
void onWifi(lv_event_t *)
{
	if (wifi != nullptr) {
		wifi();
	}
}
void onPortfolio(lv_event_t *)
{
	page = Page::Portfolio;
	lv_obj_scroll_to_y(chooser.list, 0, LV_ANIM_OFF);
	render();
}
}  // namespace

void begin(Action openWifi)
{
	wifi = openWifi;
	screen = lv_obj_create(nullptr);
	paintGround(screen);
	chooser = buildChooser(screen, "Explore", "Back", "Portfolio", "Wi-Fi");
	// Two lines for connection state or a specific failure, without truncating it.
	lv_label_set_long_mode(chooser.subtitle, LV_LABEL_LONG_WRAP);
	lv_obj_set_y(chooser.list, 112);
	lv_obj_set_height(chooser.list, 248);
	for (size_t i = 0; i < CAPACITY; ++i) {
		rowButtons[i] = lv_button_create(chooser.list);
		styleChooserRow(rowButtons[i]);
		lv_obj_set_width(rowButtons[i], LV_PCT(100));
		lv_obj_set_height(rowButtons[i], LV_SIZE_CONTENT);
		lv_obj_set_flex_flow(rowButtons[i], LV_FLEX_FLOW_COLUMN);
		lv_obj_set_style_pad_row(rowButtons[i], space::xs, LV_PART_MAIN);
		lv_obj_t **labels[2] = {&rowTop[i], &rowBottom[i]};
		for (lv_obj_t **label : labels) {
			*label = lv_label_create(rowButtons[i]);
			lv_obj_set_width(*label, LV_PCT(100));
			lv_label_set_long_mode(*label, LV_LABEL_LONG_WRAP);
		}
		lv_obj_add_event_cb(rowButtons[i], onRow, LV_EVENT_PRESSED, (void *)(uintptr_t)i);
		lv_obj_add_event_cb(rowButtons[i], onRow, LV_EVENT_CLICKED, (void *)(uintptr_t)i);
	}
	lv_obj_add_event_cb(chooser.action[0], onBack, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(chooser.action[1], onPortfolio, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(chooser.action[2], onWifi, LV_EVENT_CLICKED, nullptr);
	render();
}

void open()
{
	if (screen == nullptr || active()) {
		return;
	}
	previous = lv_screen_active();
	page = Page::List;
	render();
	lv_screen_load(screen);
}
void close()
{
	if (active() && previous != nullptr) {
		lv_screen_load(previous);
	}
}
bool active()
{
	return screen != nullptr && lv_screen_active() == screen;
}

void update(const pulse_feed_view::Trending &trending, const pulse_feed_view::Portfolio &portfolio,
            uint32_t now)
{
	nowMs = now;
	listAge = trending.ageMs;
	listAt = now;
	listState = trending.status;
	count = 0;
	if (trending.tokens != nullptr) {
		for (size_t i = 0; i < trending.count && i < CAPACITY; ++i) {
			Row row;
			if (readRow(trending.tokens[i], row)) {
				rows[count++] = row;
			}
		}
	}
	selectedPresent = false;
	for (size_t i = 0; i < count; ++i) {
		if (same(selected, rows[i])) {
			selected = rows[i];
			selectedPresent = true;
			selectedAge = trending.ageMs;
			selectedAt = now;
			break;
		}
	}
	describe(listStatus, sizeof(listStatus), trending.status, trending.reason,
	         trending.everSucceeded, trending.ageMs);
	describe(portfolioStatus, sizeof(portfolioStatus), portfolio.status, portfolio.reason,
	         portfolio.everSucceeded, portfolio.ageMs);
	copy(portfolioTotal, portfolio.total);
	copy(portfolioNfts, portfolio.nftValue);
	copy(portfolioChange, portfolio.change);
	portfolioPositive = portfolio.changePositive;
	portfolioPartial = portfolio.covered < portfolio.configured;
	snprintf(coverage, sizeof(coverage), "%u of %u wallets", (unsigned)portfolio.covered,
	         (unsigned)portfolio.configured);
	const lv_indev_t *input = lv_indev_active();
	if (active() && (input == nullptr || lv_indev_get_state(input) != LV_INDEV_STATE_PRESSED)) {
		render();
	}
}
}  // namespace pulse_explore
