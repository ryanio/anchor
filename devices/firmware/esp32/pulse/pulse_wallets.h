#ifndef ANCHOR_PULSE_WALLETS_H
#define ANCHOR_PULSE_WALLETS_H

#include <stddef.h>

/*
 * The Wallets screen: the addresses the portfolio adds up, edited on the glass.
 *
 * A list of what is configured, "Add" to type an OpenSea username, an ENS name or an address on the
 * keypad, and a tap on a wallet to remove it. A name is looked up through `feed::lookupStart`; an
 * address is taken as typed. Writes `anchor-wallets` (see `pulse_wallets_model.h`) and asks the feed
 * to reread it at once.
 *
 * Built when opened and deleted when left, like Settings: the keypad alone is a good share of the
 * LVGL pool, and nothing on this screen needs to exist while nobody is looking at it.
 */
namespace pulse_wallets {

void open();

/* How many wallets the portfolio is adding up, for the Settings row. */
size_t count();

}  // namespace pulse_wallets

#endif /* ANCHOR_PULSE_WALLETS_H */
