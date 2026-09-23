#ifndef ANCHOR_PULSE_KEYPAD_H
#define ANCHOR_PULSE_KEYPAD_H

#include <lvgl.h>

/*
 * The passphrase keypad, drawn: `pulse_keypad_model.h` turned into an LVGL button matrix.
 *
 * It types into one textarea, and it raises the two events `lv_keyboard` raised so the input's owner
 * did not have to change: `LV_EVENT_READY` from the submit key and `LV_EVENT_CANCEL` from whoever
 * calls `cancel()`. There is one keypad on this firmware, so the model behind it is a single static
 * instance and `create` may be called once.
 */
namespace pulse_keypad {

lv_obj_t *create(lv_obj_t *parent, lv_obj_t *textarea);

/* Letters, no chooser open, and the submit key relabelled for what it will do ("Join", "Next"). The
 * label is held by pointer, so pass a string literal. */
void reset(lv_obj_t *keypad, const char *submitLabel);

/* Raise `LV_EVENT_CANCEL` on the keypad, for a cancel button that lives outside it. */
void cancel(lv_obj_t *keypad);

}  // namespace pulse_keypad

#endif /* ANCHOR_PULSE_KEYPAD_H */
