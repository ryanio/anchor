#include "pulse_wallets.h"

#include <Preferences.h>
#include <stdio.h>
#include <string.h>

#include "../app/feed.h"
#include "pulse_design.h"
#include "pulse_keypad.h"
#include "pulse_wallets_model.h"

namespace pulse_wallets {
namespace {

using namespace pulse_design;

constexpr const char *STORE = "anchor-wallets";
constexpr const char *UNSET = "\x01unset";
constexpr uint32_t POLL_MS = 200;

List list{};

struct View {
	lv_obj_t *screen = nullptr;
	lv_obj_t *returnTo = nullptr;
	ChooserView pick;
	InputView input;
	StatusView confirm;
	lv_timer_t *poll = nullptr;
	size_t removing = 0;
	char query[QUERY_MAX + 1] = "";
} view;

/* --------------------------------------------------------------------------------------- store -- */

/* What is stored, or, on a unit nobody has edited, what the feed is adding up from its build. */
void load()
{
	Preferences prefs;
	String addresses = UNSET;
	String names = "";
	if (prefs.begin(STORE, true)) {
		addresses = prefs.getString("list", UNSET);
		names = prefs.getString("names", "");
		prefs.end();
	}
	if (addresses == UNSET) {
		char rows[CAPACITY][65];
		const size_t found = feed::walletList(rows, CAPACITY);
		memset(&list, 0, sizeof(list));
		for (size_t i = 0; i < found; i++) add(list, rows[i], "");
		return;
	}
	parse(list, addresses.c_str(), names.c_str());
}

void save()
{
	char addresses[CAPACITY * (ADDRESS_MAX + 1) + 1];
	char names[CAPACITY * (LABEL_MAX + 1) + 1];
	serialize(list, addresses, sizeof(addresses), names, sizeof(names));
	Preferences prefs;
	if (prefs.begin(STORE, false)) {
		prefs.putString("list", addresses);
		prefs.putString("names", names);
		prefs.end();
	}
	feed::reloadWallets();
}

/* ---------------------------------------------------------------------------------------- pages -- */

void showPage(lv_obj_t *page)
{
	lv_obj_t *const pages[3] = {view.pick.page, view.input.page, view.confirm.page};
	for (lv_obj_t *one : pages) {
		if (one == nullptr) continue;
		if (one == page) {
			lv_obj_remove_flag(one, LV_OBJ_FLAG_HIDDEN);
		} else {
			lv_obj_add_flag(one, LV_OBJ_FLAG_HIDDEN);
		}
	}
}

void setSubtitle(lv_obj_t *label, const char *text, uint32_t colour)
{
	lv_label_set_text(label, text);
	lv_obj_set_style_text_color(label, hex(colour), LV_PART_MAIN);
}

void stopPolling()
{
	if (view.poll != nullptr) {
		lv_timer_delete(view.poll);
		view.poll = nullptr;
	}
	feed::lookupCancel();
}

void onRow(lv_event_t *event);

void showList()
{
	stopPolling();
	lv_obj_clean(view.pick.list);
	char text[48];
	for (size_t i = 0; i < list.count; i++) {
		shortAddress(list.entries[i].address, text, sizeof(text));
		lv_obj_t *row = lv_list_add_button(view.pick.list, LV_SYMBOL_FILE, text);
		styleChooserRow(row);
		lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW_WRAP);
		lv_obj_set_style_pad_row(row, space::xs, LV_PART_MAIN);
		lv_obj_t *name = lv_obj_get_child(row, -1);
		if (name != nullptr && lv_obj_check_type(name, &lv_label_class)) {
			lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
			lv_obj_set_flex_grow(name, 1);
		}
		lv_obj_t *meta = lv_label_create(row);
		lv_label_set_text(meta, list.entries[i].name[0] != '\0' ? list.entries[i].name : "added by address");
		lv_label_set_long_mode(meta, LV_LABEL_LONG_DOT);
		lv_obj_set_style_text_font(meta, type::label(), LV_PART_MAIN);
		lv_obj_set_style_text_color(meta, hex(colour::ink_dim), LV_PART_MAIN);
		lv_obj_set_width(meta, LV_PCT(100));
		lv_obj_set_style_pad_left(meta, 40, LV_PART_MAIN);
		lv_obj_set_user_data(row, (void *)(intptr_t)i);
		lv_obj_add_event_cb(row, onRow, LV_EVENT_CLICKED, nullptr);
	}
	if (list.count == 0) {
		lv_obj_t *row = lv_list_add_button(view.pick.list, nullptr, "No wallets yet");
		styleChooserRow(row);
		lv_obj_remove_flag(row, LV_OBJ_FLAG_CLICKABLE);
	}
	snprintf(text, sizeof(text), list.count == 1 ? "1 wallet, added up on home" : "%u wallets, added up on home",
	         (unsigned)list.count);
	setSubtitle(view.pick.subtitle, list.count == 0 ? "Add one to see a portfolio." : text, colour::ink_dim);
	showPage(view.pick.page);
}

void showAdd()
{
	lv_label_set_text(view.input.title, "Add a wallet");
	setSubtitle(view.input.subtitle, "OpenSea username, name.eth or 0x address", colour::ink_dim);
	lv_textarea_set_text(view.input.field, "");
	pulse_keypad::reset(view.input.keyboard, "Add");
	showPage(view.input.page);
}

void showConfirm(size_t index)
{
	view.removing = index;
	char shortened[48];
	shortAddress(list.entries[index].address, shortened, sizeof(shortened));
	StatusCopy copy;
	copy.eyebrow = "WALLETS";
	copy.headline = "Remove it?";
	copy.tone = Tone::Warn;
	copy.detail = shortened;
	copy.support = list.entries[index].name;
	copy.note = "The portfolio stops adding it up.";
	applyStatus(view.confirm, copy);
	showPage(view.confirm.page);
}

/* ------------------------------------------------------------------------------------- actions -- */

void close()
{
	if (view.screen == nullptr) return;
	stopPolling();
	lv_obj_t *back = view.returnTo;
	view = View{};
	if (back != nullptr) lv_screen_load_anim(back, LV_SCR_LOAD_ANIM_NONE, 0, 0, true);
}

/* Keeps an address, or says in the input's subtitle why it did not. */
void keep(const char *address, const char *name)
{
	switch (add(list, address, name)) {
		case AddResult::Added:
			save();
			showList();
			return;
		case AddResult::Duplicate:
			setSubtitle(view.input.subtitle, "That wallet is already here.", colour::warn);
			return;
		case AddResult::Full:
			setSubtitle(view.input.subtitle, "Twelve is the most this unit adds up.", colour::warn);
			return;
		case AddResult::Invalid:
		default:
			setSubtitle(view.input.subtitle, "That address will not fit.", colour::bad);
			return;
	}
}

void onPoll(lv_timer_t *)
{
	char address[ADDRESS_MAX + 1] = "";
	const char *reason = nullptr;
	char text[96];
	switch (feed::lookupState(address, sizeof(address), &reason)) {
		case feed::Lookup::Busy:
			return;
		case feed::Lookup::Found:
			stopPolling();
			keep(address, view.query);
			return;
		case feed::Lookup::NotFound:
			stopPolling();
			setSubtitle(view.input.subtitle, "Not found on OpenSea.", colour::bad);
			return;
		case feed::Lookup::Failed:
			stopPolling();
			snprintf(text, sizeof(text), "Failed: %s.", reason != nullptr ? reason : "no answer");
			setSubtitle(view.input.subtitle, text, colour::warn);
			return;
		case feed::Lookup::Idle:
		default:
			stopPolling();
			return;
	}
}

void onSubmit(lv_event_t *)
{
	if (view.poll != nullptr) return;
	char typed[QUERY_MAX + 1];
	trim(lv_textarea_get_text(view.input.field), typed, sizeof(typed));
	if (typed[0] == '\0') {
		setSubtitle(view.input.subtitle, "Type a name or an address first.", colour::warn);
		return;
	}
	if (isEvmAddress(typed)) {
		keep(typed, "");
		return;
	}
	if (!querySane(typed)) {
		setSubtitle(view.input.subtitle, "Letters, digits, dots, dashes and _ only.", colour::bad);
		return;
	}
	snprintf(view.query, sizeof(view.query), "%s", typed);
	if (!feed::lookupStart(typed)) {
		setSubtitle(view.input.subtitle, "Names need this unit's OpenSea key.", colour::warn);
		return;
	}
	char text[96];
	snprintf(text, sizeof(text), "Looking up %s...", typed);
	setSubtitle(view.input.subtitle, text, colour::accent);
	view.poll = lv_timer_create(onPoll, POLL_MS, nullptr);
}

void onInputCancel(lv_event_t *)
{
	showList();
}

void onRow(lv_event_t *event)
{
	if (!listTapAllowed()) return;
	lv_obj_t *row = (lv_obj_t *)lv_event_get_target(event);
	const size_t index = (size_t)(intptr_t)lv_obj_get_user_data(row);
	if (index < list.count) showConfirm(index);
}

void onRemove(lv_event_t *)
{
	if (removeAt(list, view.removing)) save();
	showList();
}

void onKeep(lv_event_t *)
{
	showList();
}

void onAdd(lv_event_t *)
{
	showAdd();
}

void onBack(lv_event_t *)
{
	close();
}

lv_obj_t *pairButton(lv_obj_t *parent, bool right, const char *text, bool primary, lv_event_cb_t onTap)
{
	lv_obj_t *label = nullptr;
	lv_obj_t *button =
	    makeButton(parent, right ? PANEL_W - INSET - STATUS_ACTION_PAIR_W : INSET,
	               PANEL_H - INSET - STATUS_ACTION_H, STATUS_ACTION_PAIR_W, STATUS_ACTION_H, text, type::body(),
	               &label);
	if (primary) {
		lv_obj_set_style_bg_color(button, hex(colour::accent), LV_PART_MAIN);
		lv_obj_set_style_border_width(button, 0, LV_PART_MAIN);
		lv_obj_set_style_text_color(label, hex(colour::ground), LV_PART_MAIN);
	}
	lv_obj_add_event_cb(button, onTap, LV_EVENT_CLICKED, nullptr);
	return button;
}

}  // namespace

size_t count()
{
	load();
	return list.count;
}

void open()
{
	if (view.screen != nullptr) return;
	load();
	view.returnTo = lv_screen_active();
	view.screen = lv_obj_create(nullptr);
	paintGround(view.screen);
	lv_obj_remove_flag(view.screen, LV_OBJ_FLAG_SCROLLABLE);

	view.pick = buildChooser(view.screen, "Wallets", nullptr, nullptr, nullptr);
	pairButton(view.pick.page, false, "Back", false, onBack);
	pairButton(view.pick.page, true, "Add", true, onAdd);

	view.input = buildInput(view.screen, "name or 0x...");
	lv_obj_add_flag(view.input.reveal, LV_OBJ_FLAG_HIDDEN);
	lv_obj_set_width(view.input.field, SAFE_W);
	lv_textarea_set_max_length(view.input.field, QUERY_MAX);
	lv_obj_add_event_cb(view.input.keyboard, onSubmit, LV_EVENT_READY, nullptr);
	lv_obj_add_event_cb(view.input.keyboard, onInputCancel, LV_EVENT_CANCEL, nullptr);
	lv_obj_add_event_cb(view.input.cancel, onInputCancel, LV_EVENT_CLICKED, nullptr);

	view.confirm = buildStatus(view.screen, true);
	lv_obj_t *keepButton = makeButton(view.confirm.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H,
	                                  "Keep", type::subhead());
	lv_obj_add_event_cb(keepButton, onKeep, LV_EVENT_CLICKED, nullptr);
	lv_obj_t *removeLabel = nullptr;
	lv_obj_t *removeButton = makeButton(view.confirm.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H,
	                                    "Remove", type::subhead(), &removeLabel);
	lv_obj_set_style_text_color(removeLabel, hex(colour::bad), LV_PART_MAIN);
	lv_obj_add_event_cb(removeButton, onRemove, LV_EVENT_CLICKED, nullptr);

	showList();
	lv_screen_load(view.screen);
}

}  // namespace pulse_wallets
