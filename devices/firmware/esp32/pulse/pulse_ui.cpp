#include "pulse_ui.h"

#include <stdio.h>

namespace pulse_ui {

namespace {

using namespace pulse_design;

/*
 * The archetypes, all built once and one shown at a time.
 *
 * Built once rather than torn down and rebuilt on every kind change, because a device that spends a
 * minute joining a network crosses this boundary several times — no credentials, joining, fetching,
 * a reading, stale — and rebuilding an LVGL tree per transition is allocation churn on a 128 kB pool
 * for a screen that is going to change back. `lv_mem_monitor` in the boot banner is the check on
 * that claim; the whole of this screen was 8,816 bytes with one archetype in it.
 */
lv_obj_t *frame = nullptr;
ReadingView reading_view;
StatusView status_view;
Screen::Kind showing = Screen::Kind::Status;
void (*explore_action)() = nullptr;

void openExplore(lv_event_t *)
{
	if (explore_action != nullptr) explore_action();
}

/* --------------------------------------------------------------------------------- the power --- */

BatteryView battery_view;
pulse_power::Battery battery_state;

/* The confirmation, which is the status archetype with two buttons on it. Created after the battery
 * chip so that it covers the chip while it is up — a hold cannot be started again on a target that
 * is behind the screen asking about the last one. */
StatusView confirm_view;
BatteryView extra_battery;
bool have_extra_battery = false;
lv_obj_t *confirm_cancel = nullptr;
lv_obj_t *confirm_accept = nullptr;
lv_timer_t *confirm_timeout = nullptr;
PowerOffFn confirmed_fn = nullptr;
bool confirm_up = false;

/*
 * About 1.4 s of deliberate contact, counted exactly the way `pulse_wifi.cpp` counts its own hold:
 * `LV_EVENT_LONG_PRESSED` at 400 ms and then ten `LV_EVENT_LONG_PRESSED_REPEAT`s at 100 ms. Copied
 * in shape rather than shared, because the two gestures are on two objects and a helper between them
 * would be a header for eleven lines — but the *duration* is deliberately the same number. A device
 * with two hold gestures that want different amounts of patience is a device nobody can learn.
 */
constexpr int POWER_HOLD_REPEATS = 10;
int power_hold_repeats = 0;

/*
 * How long the prompt waits before cancelling itself.
 *
 * A confirmation that stays up forever is a panel that has stopped being a display: a unit knocked
 * in a bag, holding "Power off?" against a lit accept button for the rest of the afternoon, is worse
 * than the accident it was guarding against. Ten seconds is long enough to read two lines and decide
 * and short enough that nobody comes back to find the device waiting.
 */
constexpr uint32_t CONFIRM_TIMEOUT_MS = 10000;

void show(Screen::Kind kind)
{
	if (reading_view.page == nullptr) return;
	showing = kind;
	const bool is_reading = kind == Screen::Kind::Reading;
	if (is_reading) {
		lv_obj_remove_flag(reading_view.page, LV_OBJ_FLAG_HIDDEN);
		lv_obj_add_flag(status_view.page, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_add_flag(reading_view.page, LV_OBJ_FLAG_HIDDEN);
		lv_obj_remove_flag(status_view.page, LV_OBJ_FLAG_HIDDEN);
	}
}

/*
 * The four rows, in the order the screen should say them.
 *
 * `lead` and `second` are the composer's, so they are two integers from outside this file and are
 * treated as such: clamped into range, and separated if they collide. A composer that sets both to 2
 * gets a reading whose lead is row 2 and whose second voice is the first row that is not — not an
 * empty 48px slot where the subject of the screen should be, which is what trusting them would give.
 * The remaining rows follow in their own order, so the supporting facts stay in the order somebody
 * wrote them.
 */
void slotOrder(const Reading &reading, int into[4])
{
	const int lead = reading.lead < 4 ? (int)reading.lead : 0;
	int second = reading.second < 4 ? (int)reading.second : 1;
	if (second == lead) second = (lead + 1) % 4;

	into[0] = lead;
	into[1] = second;
	int at = 2;
	for (int row = 0; row < 4; row++) {
		if (row == lead || row == second) continue;
		into[at++] = row;
	}
}

void applyReading(const Reading &reading)
{
	lv_label_set_text(reading_view.title, reading.title);

	const char *const values[4] = {reading.total, reading.pnl, reading.nfts, reading.window};
	int order[4];
	slotOrder(reading, order);

	for (int slot = 0; slot < 4; slot++) {
		const int row = order[slot];
		/*
		 * The tone follows the *row*, never the slot.
		 *
		 * Row 1 is the signed one in both of this screen's modes — a portfolio's P&L and a token's 24h
		 * move — and `pnl_tone` is the producer's judgement about it. Attaching the colour to the slot
		 * instead would mean a reading that leads with its move gets a green *price*, which is a number
		 * wearing another number's meaning. That is the same class of mistake as a price under a label
		 * reading "Total", and this file has already been fixed for that one.
		 */
		const Tone tone = row == 1 ? toneForSign(reading.pnl_tone) : Tone::Ink;
		/* The labels are re-applied on every pass on purpose — a screen showing a token must never end
		 * up wearing a portfolio's, which is a number claiming to be a different number. */
		setReadingSlot(reading_view, slot, reading.labels[row], values[row], tone);
	}
	lv_label_set_text(reading_view.footer, reading.age == nullptr ? "" : reading.age);
}

StatusCopy copyOf(const Status &status)
{
	StatusCopy copy;
	copy.eyebrow = status.eyebrow;
	copy.headline = status.headline;
	copy.tone = status.tone;
	copy.detail = status.detail;
	copy.support = status.support;
	copy.note = status.note;
	return copy;
}

/* --------------------------------------------------------------------- the confirmation ------- */

/*
 * What the prompt says about the unit it is about to switch off.
 *
 * The charge goes in the support line rather than being left to the chip, because the chip is behind
 * this screen while it is up — and "am I about to switch off something that is nearly flat" is
 * exactly the question somebody asks at this moment.
 */
const char *confirmSupport()
{
	static char text[64];
	const pulse_power::Battery &battery = battery_state;
	if (!battery.pmu) return "";
	if (!battery.battery) {
		snprintf(text, sizeof(text), "No battery fitted%s.", battery.usb ? ", running on USB" : "");
	} else if (battery.percent >= 0) {
		snprintf(text, sizeof(text), "Battery %s%d%%%s.", battery.percent_estimated ? "about " : "",
		         (int)battery.percent, battery.charging ? ", charging" : "");
	} else {
		snprintf(text, sizeof(text), "Battery level unknown.");
	}
	return text;
}

void hideConfirm()
{
	if (!confirm_up) return;
	confirm_up = false;
	power_hold_repeats = 0;
	if (confirm_timeout != nullptr) {
		lv_timer_delete(confirm_timeout);
		confirm_timeout = nullptr;
	}
	if (confirm_view.page != nullptr) lv_obj_add_flag(confirm_view.page, LV_OBJ_FLAG_HIDDEN);
}

void onConfirmTimeout(lv_timer_t *timer)
{
	(void)timer;
	/* The timer deletes itself inside `hideConfirm`, which is legal in LVGL 9 from a timer callback —
	 * the timer list is walked with the deletion in mind — but the pointer must be cleared first so
	 * nothing tries to delete it twice. `hideConfirm` does exactly that. */
	hideConfirm();
}

void onConfirmCancel(lv_event_t *event)
{
	(void)event;
	hideConfirm();
}

void onConfirmAccept(lv_event_t *event)
{
	(void)event;
	PowerOffFn fn = confirmed_fn;
	/*
	 * The prompt comes down *before* the action runs, and that ordering is the honest one.
	 *
	 * If `powerOff()` works, nothing after it executes and it does not matter what is on screen. If it
	 * does not — the PMU stopped answering, the write was NACKed — the panel must not be left holding
	 * a prompt that has already been answered, because a device showing "Power off?" that is plainly
	 * still on is a device somebody presses again and again.
	 */
	hideConfirm();
	if (fn != nullptr) (void)fn();
}

void showConfirm()
{
	if (confirm_view.page == nullptr || confirmed_fn == nullptr) return;
	if (confirm_up) return;

	StatusCopy copy;
	copy.eyebrow = "POWER";
	copy.headline = "Power off?";
	/*
	 * `Warn` and not `Bad`. Switching a device off on purpose is not a failure, and the palette's own
	 * note says a role named for its meaning is harder to misuse than one named for its hue — the
	 * last time this was got wrong, an open Wi-Fi network wore red for being open.
	 */
	copy.tone = Tone::Warn;
	/*
	 * What it costs, in the one sentence somebody reads with a finger already on the glass.
	 *
	 * Deliberately says nothing about *how* the unit comes back on. The AXP2101 is brought out of
	 * shutdown by its PWRON key and by a VBUS insert, and which buttons on this board are wired to
	 * that is not established anywhere in this tree — Ryan's own question ("maybe holding both buttons
	 * for 5s?") is the evidence that nobody here knows. A confirmation screen that guesses would be
	 * this project's worst failure mode in miniature: a plausible instruction that is not the
	 * instruction. It says what is certain and stops.
	 */
	copy.detail = "The screen and the radio stop until the unit is switched back on.";
	copy.support = confirmSupport();
	copy.note = "Cancels itself in 10 seconds.";
	applyStatus(confirm_view, copy);

	lv_obj_remove_flag(confirm_view.page, LV_OBJ_FLAG_HIDDEN);
	lv_obj_move_foreground(confirm_view.page);
	confirm_up = true;

	if (confirm_timeout != nullptr) lv_timer_delete(confirm_timeout);
	confirm_timeout = lv_timer_create(onConfirmTimeout, CONFIRM_TIMEOUT_MS, nullptr);
	lv_timer_set_repeat_count(confirm_timeout, 1);
}

/*
 * A short tap on the chip is a tap on the glass, forwarded by hand.
 *
 * The chip has to swallow touches or its hold would also be `pulse_wifi`'s hold — but swallowing
 * them puts a 132x36 dead patch in the corner of the one screen whose entire instruction is "Tap
 * anywhere on the glass to pick a network". That is the same defect the reading's card had before
 * the frame became the target: a ring of panel that silently does nothing on the screen that most
 * depends on being pressed.
 *
 * So the short click is re-sent to the frame, which is where whoever owns input attached their
 * handler. Only the short one: a *hold* on the chip is this gesture and must not also be the other.
 * LVGL's `EVENT_BUBBLE` flag would forward both and is therefore the wrong tool.
 */
void onBatteryTap(lv_event_t *event)
{
	(void)event;
	if (confirm_up || frame == nullptr) return;
	lv_obj_send_event(frame, LV_EVENT_SHORT_CLICKED, nullptr);
}

/* The hold, counted exactly as `pulse_wifi::onHold` counts its own. Any event that is not a repeat
 * resets the count, so a finger that lifts, slides off the chip or loses the press has to start
 * again — which is what stops a series of brushes from adding up to a shutdown. */
void onBatteryHold(lv_event_t *event)
{
	switch (lv_event_get_code(event)) {
		case LV_EVENT_LONG_PRESSED:
			power_hold_repeats = 0;
			break;
		case LV_EVENT_LONG_PRESSED_REPEAT:
			if (++power_hold_repeats >= POWER_HOLD_REPEATS) {
				power_hold_repeats = 0;
				showConfirm();
			}
			break;
		default:
			power_hold_repeats = 0;
			break;
	}
}

}  // namespace

void build(const Screen &screen)
{
	lv_obj_t *active = lv_screen_active();
	paintGround(active);

	/*
	 * One frame under both archetypes, and it is the touch target.
	 *
	 * The pages themselves are transparent and not clickable (see `makePage`), so a touch anywhere on
	 * the glass lands here whichever kind of screen is up. That is what makes "tap anywhere to set up
	 * wi-fi" true rather than aspirational — it used to be the reading's card, which is inset from the
	 * panel, so the outer ring of glass was dead on the one screen whose entire job is to be pressed.
	 */
	frame = lv_obj_create(active);
	lv_obj_set_pos(frame, 0, 0);
	lv_obj_set_size(frame, PANEL_W, PANEL_H);
	lv_obj_set_style_bg_opa(frame, LV_OPA_TRANSP, LV_PART_MAIN);
	lv_obj_set_style_border_width(frame, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(frame, 0, LV_PART_MAIN);
	lv_obj_set_style_pad_all(frame, 0, LV_PART_MAIN);
	lv_obj_remove_flag(frame, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode(frame, LV_SCROLLBAR_MODE_OFF);

	reading_view = buildReading(frame);
	status_view = buildStatus(frame, false);
	lv_obj_set_width(reading_view.title, 190);
	lv_obj_t *explore = makeButton(frame, PANEL_W - INSET - 108, 24, 108, 44,
	                               "Explore", type::label());
	lv_obj_add_event_cb(explore, openExplore, LV_EVENT_CLICKED, nullptr);

	/*
	 * The battery chip, on the frame rather than on either page.
	 *
	 * There is one charge readout on this device and it does not move or disappear when the screen
	 * changes kind — a panel that shows the charge while it has data and hides it while it is failing
	 * to fetch would hide it in precisely the state where somebody walks over to check whether the
	 * thing is flat.
	 *
	 * The position is the bottom right of the safe rectangle: the reading's footer rule is at 390 on
	 * the panel and the safe bottom is 428, so the chip occupies 392-428 and clears both. It shares
	 * that line with the reading's age, which is why the footer became left-aligned.
	 */
	constexpr int32_t BATTERY_X = PANEL_W - space::md - space::lg - BATTERY_W; /* 204 */
	constexpr int32_t BATTERY_Y = PANEL_H - INSET - BATTERY_H;                 /* 392 */
	battery_view = buildBattery(frame, BATTERY_X, BATTERY_Y);
	lv_obj_add_event_cb(battery_view.chip, onBatteryTap, LV_EVENT_SHORT_CLICKED, nullptr);

	/*
	 * The confirmation, built last so it is in front of everything including the chip that summons
	 * it, and opaque so nothing behind it is readable through it — a "Power off?" that could be read
	 * as part of a portfolio would be the worst possible version of this screen.
	 */
	/* On the top layer, so the question can be asked over whichever screen is home. It lived inside
	 * this screen's frame while this was the only screen with a battery chip. */
	confirm_view = buildStatus(lv_layer_top(), true);
	lv_obj_set_style_bg_color(confirm_view.page, hex(colour::ground), LV_PART_MAIN);
	lv_obj_set_style_bg_opa(confirm_view.page, LV_OPA_COVER, LV_PART_MAIN);
	/* Clickable, so a touch meant for a button that misses it lands here and not on the frame
	 * underneath — where `pulse_wifi`'s tap gesture would open network setup out of a power prompt. */
	lv_obj_add_flag(confirm_view.page, LV_OBJ_FLAG_CLICKABLE);
	lv_obj_add_flag(confirm_view.page, LV_OBJ_FLAG_HIDDEN);

	/*
	 * Cancel on the left and the destructive one on the right, which is the order every desktop this
	 * device sits next to uses — and the accept button is the *narrower* commitment of the two to
	 * read: it wears `Bad`, so the thing that stops the unit is the only red on the panel.
	 */
	confirm_cancel = makeButton(confirm_view.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H,
	                            "Cancel", type::label());
	lv_obj_t *accept_label = nullptr;
	confirm_accept = makeButton(confirm_view.actions, 0, 0, STATUS_ACTION_PAIR_W, STATUS_ACTION_H,
	                            "Power off", type::label(), &accept_label);
	lv_obj_set_style_border_color(confirm_accept, hex(colour::bad), LV_PART_MAIN);
	lv_obj_set_style_text_color(accept_label, hex(colour::bad), LV_PART_MAIN);
	lv_obj_add_event_cb(confirm_cancel, onConfirmCancel, LV_EVENT_CLICKED, nullptr);
	lv_obj_add_event_cb(confirm_accept, onConfirmAccept, LV_EVENT_CLICKED, nullptr);

	update(screen);
	setBattery(battery_state);
}

void update(const Screen &screen)
{
	if (frame == nullptr) return;
	if (screen.kind == Screen::Kind::Reading) {
		applyReading(screen.reading);
	} else {
		applyStatus(status_view, copyOf(screen.status));
	}
	show(screen.kind);
}

void setFooter(const char *text)
{
	if (frame == nullptr || text == nullptr) return;
	if (showing == Screen::Kind::Reading) {
		lv_label_set_text(reading_view.footer, text);
		return;
	}
	/*
	 * On a status the bottom line is the note, and it is hidden when empty so the composition stays
	 * centred. Writing to it has to unhide it, or the calibration readout — a touch coordinate, for
	 * four seconds, which is the only way anybody can find out whether the CST820 ever answers — would
	 * land in an object nobody can see.
	 */
	lv_label_set_text(status_view.note, text);
	if (text[0] == '\0') {
		lv_obj_add_flag(status_view.note, LV_OBJ_FLAG_HIDDEN);
	} else {
		lv_obj_remove_flag(status_view.note, LV_OBJ_FLAG_HIDDEN);
	}
}

lv_obj_t *surface()
{
	return frame;
}

void setBattery(const pulse_power::Battery &battery)
{
	battery_state = battery;

	BatteryCopy copy;
	/*
	 * The chip is shown when the PMU answered, and not when there is a battery.
	 *
	 * A unit running on USB with no cell fitted still has a power-off worth reaching, and it still has
	 * a true thing to say about where its power is coming from. What it must never do is show a
	 * percentage it does not have — `applyBattery` falls back to the voltage and then to "USB", in
	 * that order, rather than printing a zero.
	 */
	copy.show = battery.pmu;
	copy.percent = battery.percent;
	copy.charging = battery.charging;
	copy.usb = battery.usb;
	copy.millivolts = battery.millivolts;
	copy.estimated = battery.percent_estimated;
	if (frame != nullptr) applyBattery(battery_view, copy);
	if (have_extra_battery) applyBattery(extra_battery, copy);
}

void addBatteryChip(lv_obj_t *parent, int32_t x, int32_t y)
{
	if (parent == nullptr || have_extra_battery) return;
	extra_battery = buildBattery(parent, x, y);
	have_extra_battery = true;
	lv_obj_add_event_cb(extra_battery.chip, onBatteryHold, LV_EVENT_LONG_PRESSED, nullptr);
	lv_obj_add_event_cb(extra_battery.chip, onBatteryHold, LV_EVENT_LONG_PRESSED_REPEAT, nullptr);
	lv_obj_add_event_cb(extra_battery.chip, onBatteryHold, LV_EVENT_RELEASED, nullptr);
	lv_obj_add_event_cb(extra_battery.chip, onBatteryHold, LV_EVENT_PRESS_LOST, nullptr);
	setBattery(battery_state);
}

void attachPowerGesture(PowerOffFn on_confirm)
{
	confirmed_fn = on_confirm;
	if (battery_view.chip == nullptr || on_confirm == nullptr) return;
	lv_obj_add_event_cb(battery_view.chip, onBatteryHold, LV_EVENT_LONG_PRESSED, nullptr);
	lv_obj_add_event_cb(battery_view.chip, onBatteryHold, LV_EVENT_LONG_PRESSED_REPEAT, nullptr);
	lv_obj_add_event_cb(battery_view.chip, onBatteryHold, LV_EVENT_RELEASED, nullptr);
	lv_obj_add_event_cb(battery_view.chip, onBatteryHold, LV_EVENT_PRESS_LOST, nullptr);
}

bool powerConfirmShowing()
{
	return confirm_up;
}

void dismissPowerConfirm()
{
	hideConfirm();
}

void onExplore(void (*action)())
{
	explore_action = action;
}

}  // namespace pulse_ui
