#ifndef ANCHOR_PULSE_FEED_H
#define ANCHOR_PULSE_FEED_H

#include <Arduino.h>

#include <stddef.h>
#include <stdint.h>

/*
 * Trending tokens, fetched by this unit over WiFi, with no host on the cable.
 *
 * `docs/devices-esp32.md` argues — correctly, and the argument stands — that the host renders and
 * the device blits. A unit with no USB cable attached therefore shows nothing at all, which is fine
 * on a desk and is not fine at the end of the month: these units go to an OpenSea offsite and have
 * to work untethered. So this module is the second half of the exception `app/wifi_setup.{h,cpp}`
 * already took (see that file's header, and the "One exception was taken anyway" section in
 * `docs/devices-esp32.md`): typing a passphrase on the glass is only useful if something then uses
 * the network it joined.
 *
 * The sibling device solved exactly this first, in
 * `devices/firmware/cardputer/app/src/standalone.{h,cpp}`, and where the two agree it is on purpose
 * rather than by coincidence: the same endpoint, the same four fields, the same ArduinoJson filter
 * so a payload never lands whole in RAM, the same formatted-on-the-device strings, the same
 * `OPENSEA_API_KEY` gate. Two devices in one repository speaking two dialects of the same fetch is
 * how one of them quietly rots.
 *
 * Three things are different here, each because this board is different:
 *
 *   1. **The fetch runs on its own FreeRTOS task**, not inline in `tick()`. Both handhelds now keep
 *      network work off their UI loops. On this board the loop drives a 368x448 AMOLED and feeds
 *      `anchor_pulse_feed()`, so a blocking fetch would freeze the panel and drop frames. See
 *      `feed.cpp` for the guarantee and what bounds it.
 *   2. **The Wi-Fi module owns the radio.** This module receives whether a saved network exists,
 *      whether it is connected, whether setup is using the radio, and which network generation
 *      those facts describe. It never reads a passphrase and never calls `WiFi.begin()`.
 *   3. **There is a status, and a reason.** AGENTS.md is not negotiable about this — an empty list
 *      must say *why* it is empty — and a panel that can draw a token list can draw a sentence.
 *
 * This module owns fetching, parsing and saying what state it is in; it owns no pixels, and deciding
 * *when* a screen shows this belongs to whoever draws it.
 *
 * ## It reads a portfolio too, and that is a correction
 *
 * This header used to end the paragraph above with "never a wallet, never a portfolio, never
 * anything needing more than a key scoped to public reads" — and the last clause is the only one
 * that was ever load-bearing. AGENTS.md now says so under "The Cardputer and the pulse display are
 * wholly independent devices":
 *
 *     A portfolio is public data about an address, so an independent device can show one. ... An
 *     address is configuration, not a secret: what it holds is on a public chain and a read-only
 *     API key is enough to read it. ... What genuinely cannot go on these units is a credential
 *     that can *act*.
 *
 * `service/src/config.ts` is the evidence: Anchor "holds no wallet credential by design (the PAT
 * step was removed once it was measured to be unnecessary)", and `wallets` is a list of addresses
 * somebody typed. Measured again from this checkout on 2026-09-17 with the key in `app/secrets.h`
 * and a cache-busting query parameter: `/api/v2/account/{address}/portfolio` answers **200** with
 * the key (`cf-cache-status: MISS`, so the origin judged it) and **401** without one — the control
 * failing, which is what AGENTS.md asks for before a credential claim is believed.
 *
 * So the line this module holds is not "no portfolio". It is **no authority**: one read-only key,
 * GETs only, and a list of addresses that is configuration in the same way the network is.
 *
 * `wallets` is a list host-side for a reason recorded in AGENTS.md — a wallet-scoped read means
 * *every* wallet, and a total that silently covered one of nine is this project's worst shipped
 * bug — so the device takes a list, reads all of it, and labels what it could not reach.
 *
 * Everything that comes back over the wire is marketplace content, which AGENTS.md treats as a
 * prompt-injection surface and this file treats as hostile bytes: see `copyBounded` in `feed.cpp`.
 *
 * **Build prerequisite: ArduinoJson 7** — `arduino-cli lib install "ArduinoJson@7.2.0"`, the same
 * pin `devices/firmware/cardputer/flint/flint.ini` already carries for the sibling device. See the
 * comment above the includes in `feed.cpp` for why it cannot be an optional `__has_include`.
 *
 * `pulse/pulse.ino` wires this to `pulse_wifi`, which is the one owner of connection, retry and
 * saved-network switching. With no `app/secrets.h` present the live worker compiles out and the
 * snapshot explains that no OpenSea key is present.
 */
namespace feed {

constexpr size_t TOKEN_CHAIN_MAX = 16;
constexpr size_t TOKEN_ADDRESS_MAX = 48;

/*
 * One row, formatted.
 *
 * Same shape and same reasoning as `standalone::Token`: the strings are formatted once, here, at
 * fetch time, rather than shipped to a renderer as floats. This device has no more business
 * deciding how a dollar figure rounds than the Stream Deck does — `state/anchor.ts`'s `usd()` lives
 * on the host for exactly that reason — and a renderer handed a `double` is a renderer that has to
 * grow an opinion about it.
 *
 * Every array is fixed-size and every write into one is bounded. A 200-character collection name
 * truncates; it does not overrun. The sizes are the Cardputer's, which were picked for a 240x123
 * screen — this panel is 368x448 and could hold more, but a wider `name` would be a second dialect
 * for no measured gain, and nothing here has yet been drawn on this glass to say what fits.
 */
struct Token {
	char symbol[12];
	char name[24];
	char price[16];
	char change[10];
	char volume[16];
	/* Chain plus address is the identity. These bounds match the Cardputer so both handhelds
	 * accept and reject the same rows, and an overlong value is dropped rather than truncated into
	 * an identity that never existed. */
	char chain[TOKEN_CHAIN_MAX];
	char address[TOKEN_ADDRESS_MAX];
	bool changePositive;
};

constexpr size_t MAX_TOKENS = 8;

/*
 * Why a screen is empty, in the vocabulary a screen needs.
 *
 * These are not log levels. Each one is a different sentence for a person holding the unit, and
 * they are ordered by how early in the chain the answer stops: no key compiled in, no network
 * saved, joining one, joined, asking OpenSea, and "the last ask did not work". A UI that renders
 * all six never has to draw a blank panel and hope.
 */
enum class Status : uint8_t {
	/* No `OPENSEA_API_KEY` (or no ArduinoJson) compiled in. Nothing here will ever touch the
	   network, which is the whole point of the gate — see `app/secrets.h.example`. */
	Disabled,
	/* Nothing saved under the `anchor-wifi` NVS namespace. `wifi_setup.cpp` is how that gets
	   filled in, on the glass, by whoever is holding the unit. */
	NoCredentials,
	/* Credentials exist and the station has not associated yet. */
	Joining,
	/* Associated, idle, waiting for the poll interval. `everSucceeded`/`ageMs` say whether there
	   is anything to show while it waits. */
	Online,
	/* A request is in flight on the worker task right now. */
	Fetching,
	/* The last attempt failed. `reason` says how far it got. Any data in the snapshot is the last
	   good data and `ageMs` says how old — stale and labelled beats absent and unexplained. */
	Failed,
	/*
	 * Portfolio only: a key, a network, and no addresses to read.
	 *
	 * Appended rather than slotted into the chain order above, and deliberately: `pulse.ino` mirrors
	 * this enum by value in `pulse_feed_view::Status` because the desktop simulator cannot include
	 * this header, and inserting a member would renumber every state after it — a unit that failed to
	 * join would announce that it was fetching. The static asserts in `pulse.ino` are what hold the
	 * two spellings together; adding a member at the end costs one more of them.
	 */
	NoWallets,
};

/*
 * A portfolio, formatted, with how much of it is actually in the total.
 *
 * `covered` and `configured` are the whole reason this is a struct rather than one string. AGENTS.md:
 * "A partial answer is labelled, never trimmed. One wallet failing leaves a total over the rest and
 * an `incomplete` list naming the missing one, and the panel says '8 of 9 wallets'." A device that
 * summed the survivors and drew the result the same way it draws a complete answer would be
 * reproducing this project's worst shipped bug on a smaller screen.
 *
 * `configured` counts every address this unit was *told about*, including any past `MAX_WALLETS`
 * that were never asked for. Truncating the list would otherwise be a silent trim wearing a
 * different hat.
 *
 * The strings are formatted once, here, for the reason `Token` gives: a renderer handed a number is
 * a renderer that has to grow an opinion about how a dollar rounds. A figure that did not arrive is
 * "--" and never "$0.00" — a missing price has no reading, and `$0.00` is a reading.
 */
struct Portfolio {
	/* Summed across every wallet that answered, as decimal arithmetic — never through a float. See
	 * `addMicros` in `feed.cpp`, and `service/src/aggregate.ts`, which does the same job with BigInt
	 * at a common scale for the same reason. */
	char total[24];
	/* The NFT half of that total. The API gives a *value*, not a count: there is no cheap count in
	 * this response, and `docs/upstream.md` entry 15 is about exactly what is and is not breakable
	 * out of these figures. A count would be a paginated list per address per chain. */
	char nftValue[24];
	/* The 24h move, as a percentage. Derived from the summed absolute move over what it moved from,
	 * never averaged across wallets — see `percentageOf` in `service/src/aggregate.ts`. */
	char change[16];
	bool changePositive;
	bool haveChange;
	/* Wallets in the total, and wallets asked for. `covered < configured` is a partial answer and
	 * whoever draws it must say so. */
	size_t covered;
	size_t configured;
};

/*
 * How many addresses one unit will read.
 *
 * Twelve because the linked-wallet list that produced this project's worst bug had nine in it, and a
 * ceiling under the real number would be the same bug with a new cause. Each one costs a request per
 * poll through one rate limiter, so this is a budget as much as an array bound — and `configured`
 * above is what keeps a longer list honest rather than quietly short.
 */
constexpr size_t MAX_WALLETS = 12;

/*
 * A consistent view of everything a UI needs, copied out in one go.
 *
 * By value, and copied under the publish lock, because the alternative is a renderer reading
 * `tokens[3]` while the worker task is halfway through replacing it — a row with one token's symbol
 * and another's price, which is a plausible number that is not the number it claims to be, this
 * project's named worst failure mode. 512-odd bytes off a loop task with an 8 KB stack is a cheap
 * way to make that impossible rather than unlikely.
 */
struct Snapshot {
	Status status;
	/*
	 * A short, fixed, compiled-in sentence — never a string that came off the network. Safe to
	 * draw and safe to print. See `feed.cpp` for why nothing from the response is ever allowed
	 * near `Serial` on this board.
	 */
	const char *reason;
	Token tokens[MAX_TOKENS];
	size_t count;
	/* Milliseconds since the last *successful* fetch, or `UINT32_MAX` if there has never been
	   one. A UI that shows data without showing this is showing an unlabelled claim. */
	uint32_t ageMs;
	bool everSucceeded;
	/* HTTP status of the last completed request, or 0 if none has completed. Negative values are
	   `HTTPClient`'s own transport errors (`HTTPC_ERROR_*`), which is why this is signed. */
	int lastHttpCode;
	/*
	 * Smallest free stack the worker task has ever had, in bytes.
	 *
	 * Here because the stack size below is the one number in this module that is an estimate
	 * rather than a measurement, and "present" is not "works": a TLS handshake and an ArduinoJson
	 * parse on one stack is exactly the shape of thing that overflows in the field and not on a
	 * desk. Reading it back is how that estimate becomes a measurement. 0 before the task has
	 * run.
	 */
	uint32_t workerStackFreeBytes;

	/*
	 * The portfolio, with its own status, its own reason and its own clock.
	 *
	 * Separate from the fields above rather than folded into them, because the two reads fail
	 * independently: a unit with no addresses configured still shows trending, and a unit whose
	 * portfolio is an hour old can have a fresh trending list beside it. One status covering both
	 * would have to pick which failure to describe, and the answer a person needs is "which of the
	 * two is unhappy" — the `eyebrow` slot in `pulse_ui::Status` exists for exactly that question.
	 */
	Portfolio portfolio;
	Status portfolioStatus;
	const char *portfolioReason;
	/* Since the last *complete or partial* portfolio pass, or `UINT32_MAX` if there has never been
	 * one. A pass that reached no wallet at all is a failure, not a reading, and does not set it. */
	uint32_t portfolioAgeMs;
	bool portfolioEverSucceeded;
};

/*
 * Call once during setup.
 *
 * Reads the public wallet configuration and starts one persistent worker task. It does not connect
 * or fetch. A worker-allocation failure becomes a visible failed snapshot rather than a feed that
 * waits forever.
 *
 * Safe to call on a unit with no key compiled in: it short-circuits to `Status::Disabled` and
 * creates no task, so a checkout with no `secrets.h` costs a branch and one byte of RAM.
 */
void begin();

/*
 * Call every `loop()` pass. Never blocks.
 *
 * The fast path compares context and time, consumes a fixed-size staged result, and at most posts a
 * task notification. DNS, TCP, TLS, body reads and parsing live on the worker. Once per minute it
 * re-reads the small public wallet list from local NVS so a changed configuration invalidates an
 * old total instead of leaking it under the new configuration.
 *
 * `networkRevision` changes when the intended network changes. Setup, disconnection, a revision
 * change, or a wallet change cancels interest in the current ticket. The worker is never deleted
 * while HTTP is active; its obsolete completion is rejected after its bounded unwind.
 */
void tick(bool networkConfigured, bool connected, bool radioBusy, uint32_t networkRevision);

/* The whole state, atomically. Cheap: a bounded `memcpy` inside a spinlock, no waiting. */
Snapshot snapshot();

/*
 * The parser, as a pure function over a stream — the part with the judgement in it.
 *
 * Exposed for the same reason every `readX` in `devices/src/state/discovery.ts` is exported: a
 * parser that has only ever been run against the live API is a parser nobody has tested against the
 * payloads that break it. This one can be handed a fixture — a real captured response, a row with a
 * 200-character name, a `usdPrice` that is a number where the API sends a string, an array of
 * nothing — with no radio, no key and no board.
 *
 * Writes at most `max` rows, returns how many it wrote, and never writes an unterminated string.
 * `err` is filled with a compiled-in reason on failure and left alone on success.
 */
size_t parseTrending(Stream &in, Token *out, size_t max, const char **err);

/*
 * One address's portfolio figures, in fixed-point micro-dollars.
 *
 * **Integers, not doubles, and that is the non-negotiable part.** These are summed across wallets,
 * and AGENTS.md rule 3 of "A wallet-scoped read means every wallet" is that money sums as decimal
 * strings and never through a float: "a total that disagrees with the pages it was summed from is
 * indistinguishable from a broken widget". `service/src/aggregate.ts` does it with BigInt at a
 * common scale; this device has no BigInt, so it does the same thing with a fixed scale of 1e6 and
 * an overflow check. Six decimal places is three more than any figure the API has been seen to send
 * and leaves room for about nine trillion dollars in an `int64_t`.
 *
 * `have*` rather than a sentinel, because a field that did not arrive and a field that is genuinely
 * zero are different facts — the first renders "--" and the second renders "$0.00". `formatUsd` in
 * `feed.cpp` already makes this argument about a token price; a portfolio total is where it bites.
 */
struct Figures {
	bool haveTotal;
	int64_t totalMicros;
	bool haveNft;
	int64_t nftMicros;
	/* The absolute 24h move in dollars, which *adds* across wallets. The percentage does not — see
	 * `combinePortfolio` in `service/src/aggregate.ts`, where averaging nine wallets' percentages
	 * would weight a $12 wallet the same as a $2,000 one. */
	bool havePnl;
	int64_t pnlMicros;
};

/*
 * The portfolio parser, as a pure function over a stream. Exposed for the same reason
 * `parseTrending` is: a parser only ever run against the live API is a parser nobody has tested
 * against the payloads that break it.
 *
 * Returns false and fills `err` with a compiled-in reason when the response is not a portfolio.
 * A response that parses but carries no total is a failure too — there is nothing to add.
 */
bool parsePortfolio(Stream &in, Figures &out, const char **err);

/*
 * A decimal string as micro-dollars. True only if the whole string was a decimal number that fits.
 *
 * Exposed because it is where a wrong total would come from: "2191.42" must become 2191420000 and
 * "9e99", "", "12.3.4" and a 30-digit number must all be refused rather than clamped. A clamped
 * total is a plausible number that is not the number it claims to be.
 */
bool parseDecimalMicros(const char *text, int64_t *out);

/*
 * The other half, and the reason it is here rather than private: this is the device's entire opinion
 * about how a dollar is written, and an opinion nobody can run is an opinion nobody has checked.
 *
 * Same rounding as `usd()` in `devices/src/panel.ts` — cents below a thousand dollars, none above —
 * with thousands separators, which the host also uses and the Cardputer's trending formatter does
 * not. `feed.cpp` says why the two differ rather than one being wrong.
 */
void formatUsdMicros(int64_t micros, char *out, size_t n);

}  // namespace feed

#endif /* ANCHOR_PULSE_FEED_H */
