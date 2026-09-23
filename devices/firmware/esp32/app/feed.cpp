#include "feed.h"

#include "feed_request.h"

#include "../../common/display_format.h"

/*
 * Every include here is unconditional, and that is a correction rather than a style choice.
 *
 * The first version of this file wrapped them in `#if __has_include(<ArduinoJson.h>)` so a checkout
 * without the library would still build. It did build — and it built the wrong program. `arduino-cli`
 * discovers which libraries a sketch needs by preprocessing it and reading the *failures*: a
 * `fatal error: ArduinoJson.h: No such file` is what makes it go and find the library and put it on
 * the include path. `__has_include` never fails, so it answered "no" against a path the library had
 * not been added to yet, the guard compiled the whole fetch away, and the build reported success at
 * a byte-identical size — 963,539 bytes with and without this module, which looked like a tidy
 * zero-cost abstraction and was really a feature that was not there. Exactly the shape AGENTS.md
 * describes under "Make the control fail before you trust it": a control that passed for the wrong
 * reason. What caught it was `arduino-cli compile -v | grep "Using library"`, which listed neither
 * ArduinoJson nor NetworkClientSecure.
 *
 * So the dependency is declared the only way this toolchain understands: plainly. **Building
 * `app/` now needs ArduinoJson 7** — `arduino-cli lib install "ArduinoJson@7.2.0"`, the same major
 * and the same minimum `devices/firmware/cardputer/flint/flint.ini` already pins for the sibling
 * device, so this is the repository's existing dependency on a second board rather than a new one.
 * A checkout without it fails with a message naming the header, which is a better outcome than a
 * unit that silently never fetches.
 */
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "../../common/trending_rows.h"

#if __has_include("secrets.h")
#include "secrets.h"
#endif

/*
 * The one gate, and it is the same one `cardputer/app/src/standalone.cpp` puts on its own fetch,
 * for the same reason: a unit built from a clone with no `app/secrets.h` must never make a request,
 * not merely make one that fails. It stays exactly as silent about the network as the original
 * cable-only design, and `snapshot()` says `Status::Disabled` rather than leaving a screen blank
 * with no explanation.
 *
 * `__has_include("secrets.h")` is safe here where it was not above: a sketch directory is already
 * on its own include path, so there is no library for `arduino-cli` to discover and nothing for the
 * answer to be wrong about.
 *
 * The parser is deliberately *outside* this gate. `parseTrending()` is the part with the judgement
 * in it, and it compiles — and can be driven by a host harness against a captured payload, with no
 * radio and no key — on every checkout.
 */
#if defined(OPENSEA_API_KEY)
#define ANCHOR_FEED_LIVE 1
#else
#define ANCHOR_FEED_LIVE 0
#endif

namespace feed {

namespace {

/* ---------------------------------------------------------------- untrusted bytes ------------- */

/* Untrusted bytes, copied for drawing: common/display_format.h. This file still prints nothing,
 * because `app/` firmware uses Serial for the host protocol. */
using anchor_format::copyBounded;

/* ---------------------------------------------------------------- formatting ------------------ */

/* Money, formatted once at fetch time with the Cardputer's exact rules: common/display_format.h. */
using anchor_format::addMicros;
using anchor_format::formatBigUsd;
using anchor_format::formatPercent;
using anchor_format::formatUsd;

}  // namespace

/* The portfolio's money arithmetic lives in common/display_format.h, where the Cardputer can reuse it.
 * These keep the `feed::` names the header documents. */
void formatUsdMicros(int64_t micros, char *out, size_t n) {
	anchor_format::formatUsdMicros(micros, out, n);
}

bool parseDecimalMicros(const char *text, int64_t *out) {
	return anchor_format::parseDecimalMicros(text, out);
}

/* ---------------------------------------------------------------- the parser ------------------ */

/* The row reader, its filter and its identity rule are `common/trending_rows.h`, shared with the
 * Cardputer so both devices read one response into the same rows. The field names in both dialects
 * are there too: the live API answers in snake_case, and a parser written from the host's camelCase
 * model once read every price and change from it as missing. */

size_t parseTrending(Stream &in, Token *out, size_t max, const char **err) {
	if (out == nullptr || max == 0) {
		if (err != nullptr) *err = "nowhere to put the result";
		return 0;
	}

	/*
	 * Both shapes of the same list.
	 *
	 * `api.opensea.io/api/v2/tokens/trending` answers with a bare `{ "tokens": [...] }`, which is
	 * what `standalone.cpp` reads. `anchor-service` re-serves the identical list inside its own
	 * envelope as `{ "data": { "tokens": [...] } }`, which is what `state/discovery.ts` reads.
	 * Accepting either costs two lines of filter and one fallback lookup, and buys the difference
	 * between a populated screen and an empty one if this unit is ever pointed at a service on the
	 * LAN instead of at the public API — which is the better deployment for an offsite, because it
	 * puts the key back on the desktop where `docs/security.md` wants it.
	 */
	JsonDocument filter;
	anchor_trending::fillFilter(filter);

	/*
	 * A nesting limit, because the input is hostile until proven otherwise.
	 *
	 * ArduinoJson's deserializer recurses, and its default limit of 10 is a general-purpose number.
	 * The deepest thing this filter can reach is `data` → `tokens` → row → value, so 6 is generous
	 * and a payload built to blow the stack — on a worker task that is also carrying an mbedTLS
	 * session — is rejected as `TooDeep` rather than parsed.
	 */
	JsonDocument doc;
	const DeserializationError error = deserializeJson(doc, in, DeserializationOption::Filter(filter),
	                                                   DeserializationOption::NestingLimit(6));
	if (error) {
		/* `DeserializationError::c_str()` is a compiled-in string table, never response bytes. */
		if (err != nullptr) *err = error.c_str();
		return 0;
	}

	JsonArrayConst list = anchor_trending::tokenList(doc);
	if (list.isNull()) {
		if (err != nullptr) *err = "no token list in the response";
		return 0;
	}

	const size_t count = anchor_trending::readRows(list, out, max);
	if (count == 0 && err != nullptr) {
		*err = "the trending list came back empty";
	}
	return count;
}

/* ---------------------------------------------------------------- the portfolio parser --------- */

namespace {

/*
 * The field names, measured rather than remembered — and measured against the API this device is
 * actually pointed at, which is the mistake the trending parser had to be corrected for once
 * already.
 *
 * `curl` against `https://api.opensea.io/api/v2/account/{address}/portfolio`, 2026-09-17, with the
 * key from `app/secrets.h` and a unique query parameter so Cloudflare could not answer for the
 * origin (`cf-cache-status: MISS`):
 *
 *     { "total_value_usd": "2191.42", "nft_value_usd": "71.48", "token_value_usd": "2119.94",
 *       "pnl_absolute": "+57.79", "pnl_percentage": "+2.71", "timeframe": "DAY" }
 *
 * Every money field is a **string**, and `pnl_absolute` carries an explicit leading `+`. Snake case,
 * like the trending rows — the camelCase spellings below are the host's: `service/src/aggregate.ts`
 * reads `totalValueUsd`/`netWorthUsd`, because the SDK camelises and because the shape has changed
 * more than once. Both dialects cost two filter lines each and mean a unit pointed at an
 * `anchor-service` on the LAN reads the same figures.
 *
 * `token_value_usd` is deliberately not read: the panel shows a total, its NFT half and the move,
 * and a fourth figure that is just `total - nft` would be a row spent on arithmetic the reader can
 * do. `pnl_percentage` is not read either, and that one matters — see `combinePortfolio`.
 */
void fillPortfolioFilter(JsonObject figures) {
	figures["total_value_usd"] = true;
	figures["totalValueUsd"] = true;
	figures["net_worth_usd"] = true;
	figures["netWorthUsd"] = true;
	figures["nft_value_usd"] = true;
	figures["nftValueUsd"] = true;
	figures["pnl_absolute"] = true;
	figures["pnlAbsolute"] = true;
}

/* The first spelling that is present, as micro-dollars. Mirrors `pickDecimal` in
 * `service/src/aggregate.ts`, including its rule that a number on the wire is as acceptable as a
 * string — 51 of OpenSea's money fields are strings and 24 are not yet (`docs/upstream.md`), and the
 * day one of those 24 flips is a day nothing here breaks. */
bool pickMicros(JsonObjectConst source, const char *snake, const char *camel, int64_t *out) {
	const char *keys[2] = {snake, camel};
	for (size_t k = 0; k < 2; k++) {
		JsonVariantConst value = source[keys[k]];
		if (value.isNull()) continue;
		if (value.is<const char *>()) {
			if (parseDecimalMicros(value.as<const char *>(), out)) return true;
			continue;
		}
		/*
		 * A JSON number, printed back to a decimal string and parsed by the same code as a string
		 * field. Round-tripping through `%.6f` rather than scaling the double directly is what keeps
		 * one parser — and therefore one set of refusals — in front of every figure that is summed.
		 */
		if (value.is<double>()) {
			const double raw = value.as<double>();
			if (!isfinite(raw) || raw > 9.0e12 || raw < -9.0e12) continue;
			char text[32];
			snprintf(text, sizeof(text), "%.6f", raw);
			if (parseDecimalMicros(text, out)) return true;
		}
	}
	return false;
}

}  // namespace

bool parsePortfolio(Stream &in, Figures &out, const char **err) {
	memset(&out, 0, sizeof(out));

	/*
	 * Three shapes of the same figures, for the same reason the trending filter has two.
	 *
	 * The live API answers flat. `anchor-service` wraps its own envelope around a `stats` object
	 * (`combinePortfolio`), and older responses put them under `portfolio` — `stats()` in
	 * `aggregate.ts` tries exactly this sequence, so this is that function's shape in a filter.
	 */
	JsonDocument filter;
	fillPortfolioFilter(filter.to<JsonObject>());
	fillPortfolioFilter(filter["stats"].to<JsonObject>());
	fillPortfolioFilter(filter["portfolio"].to<JsonObject>());
	fillPortfolioFilter(filter["data"]["stats"].to<JsonObject>());

	JsonDocument doc;
	const DeserializationError error = deserializeJson(doc, in, DeserializationOption::Filter(filter),
	                                                   DeserializationOption::NestingLimit(6));
	if (error) {
		/* A compiled-in string table, never response bytes. */
		if (err != nullptr) *err = error.c_str();
		return false;
	}

	JsonObjectConst figures = doc["data"]["stats"].as<JsonObjectConst>();
	if (figures.isNull()) figures = doc["stats"].as<JsonObjectConst>();
	if (figures.isNull()) figures = doc["portfolio"].as<JsonObjectConst>();
	if (figures.isNull()) figures = doc.as<JsonObjectConst>();
	if (figures.isNull()) {
		if (err != nullptr) *err = "the portfolio response had no figures in it";
		return false;
	}

	out.haveTotal = pickMicros(figures, "total_value_usd", "totalValueUsd", &out.totalMicros) ||
	                pickMicros(figures, "net_worth_usd", "netWorthUsd", &out.totalMicros);
	out.haveNft = pickMicros(figures, "nft_value_usd", "nftValueUsd", &out.nftMicros);
	out.havePnl = pickMicros(figures, "pnl_absolute", "pnlAbsolute", &out.pnlMicros);

	/*
	 * No total is a failed read, not a wallet worth nothing.
	 *
	 * The difference is the whole of rule 2: a wallet whose figure never arrived belongs in the
	 * *uncovered* count, where the panel says "2 of 3". Counting it as zero would fold a failure into
	 * the total silently, which is the shape of this project's worst bug.
	 */
	if (!out.haveTotal) {
		if (err != nullptr) *err = "the portfolio response had no total in it";
		return false;
	}
	return true;
}

/* ---------------------------------------------------------------- the live path --------------- */

namespace {

#if ANCHOR_FEED_LIVE

/*
 * The endpoint, not written from memory.
 *
 * `/api/v2/tokens/trending` is the Discovery row in `docs/tokens.md`, which exists precisely
 * because every path in that table was wrong the first time somebody wrote one by hand
 * (`token_balances_by_account` and friends). It is also the path `standalone.cpp` already calls and
 * the one `service/src/server.ts` re-serves. AGENTS.md's rule is to prefer OpenSea's own packages
 * over a hand-written client; there is no `@opensea/sdk` for an ESP32, so the mitigation is that
 * this file contains exactly one URL, spelled the same as the sibling device's, and no URL
 * building.
 *
 * `limit=8` is `MAX_TOKENS`: asking for rows this device will throw away is somebody else's
 * bandwidth and this unit's heap.
 */
constexpr const char *TRENDING_URL = "https://api.opensea.io/api/v2/tokens/trending?limit=8";

/*
 * The portfolio endpoint, also not written from memory.
 *
 * `/api/v2/account/{address}/portfolio` is the "Net worth and P&L" row in `docs/tokens.md`, the path
 * `service/src/server.ts` calls through `@opensea/sdk`'s `portfolioStats`, and the one
 * `service/src/auth.ts` records re-measuring. It was called from this checkout on 2026-09-17 with
 * the key in `app/secrets.h`: 200 with the key, 401 without it, `cf-cache-status: MISS` on both so
 * neither answer came out of Cloudflare instead of the origin. There is no `@opensea/sdk` for an
 * ESP32; the mitigation is that this file now contains exactly two URLs and no URL building beyond
 * substituting an address that has already been checked character by character.
 *
 * **`timeframe=DAY` is not decoration.** Two reasons, and the second is the one worth writing down:
 *
 *   1. It pins what the 24h row means. `DAY` is the server's default — measured, the response echoes
 *      `"timeframe": "DAY"` when nothing is asked for — but a default is a thing that can change
 *      under a panel whose label says "24h".
 *   2. `docs/upstream.md` entry 7: the bare route returns `500 Internal Server Error` for a large
 *      account and `200` for that same account "the moment any query parameter is supplied". The
 *      recorded workaround is to always send a parameter. This one is sent for its own sake anyway,
 *      which makes it the cheapest possible form of that workaround. Note what is deliberately *not*
 *      sent: a `chains` filter would also dodge the 500, and would also make the total cover some
 *      chains rather than all of them — a plausible number that is not the number it claims to be,
 *      under a label reading "Total".
 */
constexpr const char *PORTFOLIO_URL_FORMAT =
    "https://api.opensea.io/api/v2/account/%s/portfolio?timeframe=DAY";

/*
 * Timing. Every one of these is "how long before the *worker* gives up", never a wait imposed on
 * `loop()`.
 *
 * `POLL_MS` is the Cardputer's number, for the Cardputer's reason: trending tokens do not move
 * faster than a radio budget is worth spending, and a display that is calm is the point (see the
 * "Default to quiet" line in `docs/tokens.md`).
 */
constexpr uint32_t POLL_MS = 60000;
constexpr uint32_t RETRY_MS = 15000;
/*
 * The portfolio's own clock, because it is a different kind of number.
 *
 * 120 seconds is `ttl.portfolio` from `service/src/config.ts` — the desktop already decided how
 * stale a portfolio figure is allowed to be, and a second opinion about that on a device sitting
 * next to the desktop is a second number. It is also a request *per address*: six wallets at this
 * interval is three requests a minute, against the `requestsPerSecond: 2` the service holds itself
 * to. `WALLET_GAP_MS` keeps the fan-out inside that budget rather than firing them back to back.
 */
constexpr uint32_t PORTFOLIO_POLL_MS = 120000;
constexpr uint32_t PORTFOLIO_RETRY_MS = 30000;
constexpr uint32_t WALLET_GAP_MS = 500;
/* Slower than the credential re-check, because the two are looking for different things. That one is
 * waiting for somebody standing at the unit to finish typing a network; nothing types an address on
 * the glass yet, so this is only ever a unit that was re-pointed between polls. A minute is faster
 * than the portfolio refreshes anyway. */
constexpr uint32_t WALLET_RECHECK_MS = 60000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 8000;
constexpr uint32_t READ_TIMEOUT_MS = 8000;
constexpr uint32_t HANDSHAKE_TIMEOUT_S = 15;
/* A per-read timeout still permits a peer to send one byte before every expiry forever. Body parsing
 * gets an absolute deadline as well, checked alongside cancellation on every stream operation. */
constexpr uint32_t BODY_BUDGET_MS = 10000;

/*
 * A ceiling on what this unit will read.
 *
 * The filter above means a huge payload is mostly discarded as it streams, but the strings the
 * filter *keeps* are allocated, and a hostile response with an 8 MB `name` would be kept. 128 KB is
 * about forty times the largest real `/tokens/trending?limit=8` body and small enough that reading
 * one cannot exhaust internal heap with a TLS session up. `useHTTP10(true)` below guarantees a
 * `Content-Length` to check it against; a response that declines to say how big it is is refused.
 */
constexpr int MAX_RESPONSE_BYTES = 128 * 1024;

/*
 * The worker task.
 *
 * **Stack**: this is the one number in the module that is an estimate rather than a measurement. It
 * carries an mbedTLS handshake (the certificate bundle verification is the deep part) and an
 * ArduinoJson parse, which is why it is larger than the 8 KB the Arduino loop task itself gets.
 * `Snapshot::workerStackFreeBytes` reports the high-water mark back so the estimate can become a
 * measurement on the bench: if it reads near zero the number is wrong, and if it reads about
 * three-quarters of this the number is generous. **What would falsify the units**: ESP-IDF reports
 * this figure in bytes where vanilla FreeRTOS reports words, so a value four times smaller than the
 * arithmetic below suggests means the units are words and this comment is wrong.
 *
 * **Core**: 0. The Arduino core builds with `ARDUINO_RUNNING_CORE=1`, so `loop()` — and therefore
 * `anchor_pulse_feed()`, the panel push and the touch poll — runs on core 1. Pinning the worker to
 * core 0 means the scheduler on core 1 never has to choose between them: a task on another core
 * cannot preempt the loop at all, whatever it is doing. Priority 1 matches the loop task so that
 * *within* core 0 the WiFi and TCP/IP tasks (priorities 18 through 23) still outrank it, which is
 * what keeps the radio itself responsive while this thing sits inside a blocking read.
 */
constexpr uint32_t WORKER_STACK_BYTES = 12288;
constexpr UBaseType_t WORKER_PRIORITY = 1;
constexpr BaseType_t WORKER_CORE = 0;

/*
 * Published state, and the lock that makes reading it atomic.
 *
 * A spinlock rather than a mutex, on purpose. Everything inside the critical section is a
 * fixed-size `memcpy` and a handful of word stores — no allocation, no I/O, nothing that can wait —
 * so the section is bounded by arithmetic rather than by the network: 512 bytes of `Token` plus a
 * few words, which at 240 MHz is single-digit microseconds. A mutex would give the reader a
 * *blocking* take, and "bounded by microseconds" is the property `tick()` and `snapshot()` need;
 * "usually fast" is not. What would falsify it: any code added inside `portENTER_CRITICAL` that can
 * block, allocate, or touch the radio.
 */
portMUX_TYPE publishLock = portMUX_INITIALIZER_UNLOCKED;
Token published[MAX_TOKENS];
size_t publishedCount = 0;
uint32_t lastSuccessMs = 0;
bool everSucceeded = false;
bool fetching = false;
int lastHttpCode = 0;
const char *failReason = nullptr;
uint32_t workerStackFree = 0;

/* The same discipline for the portfolio: published under the same lock, in one `memcpy`, so a
 * renderer can never catch a total that has been replaced while its coverage label has not. */
Portfolio publishedPortfolio;
uint32_t portfolioSuccessMs = 0;
bool portfolioEver = false;
bool portfolioFetching = false;
const char *portfolioFailReason = nullptr;

/* One persistent worker and one fixed job slot. A running request keeps the slot even after the loop
 * cancels interest, so its HTTP and TLS objects always unwind on their owning task. */
constexpr size_t WALLET_ADDRESS_MAX = 64;
struct RequestJob {
	Request request;
	char wallets[MAX_WALLETS][WALLET_ADDRESS_MAX + 1];
	size_t walletsAsked;
	size_t walletsConfigured;
};

struct RequestResult {
	Request request;
	bool ok;
	const char *reason;
	int httpCode;
	uint32_t finishedAt;
	uint32_t stackFree;
	Token tokens[MAX_TOKENS];
	size_t count;
	Portfolio portfolio;
};

RequestCoordinator requests;
RequestJob pendingJob{};
RequestResult readyResult{};
TaskHandle_t worker = nullptr;
bool workerUnavailable = false;
bool networkConfigured = false;
bool networkConnected = false;
bool networkRadioBusy = false;
uint32_t networkRevision = 0;
uint32_t lastAttemptMs = 0;
uint32_t lastPortfolioAttemptMs = 0;
uint32_t lastWalletCheck = 0;

/*
 * The addresses this unit reads, and where they come from.
 *
 * **An address is configuration, not a secret** — AGENTS.md says so in as many words, and it is the
 * difference between this and `OPENSEA_API_KEY`: what an address holds is on a public chain, and the
 * read-only key this unit already carries is enough to read it. So addresses are treated exactly the
 * way the network is: a compiled-in default so a unit ships knowing whose portfolio it shows, and an
 * NVS override so it can be re-pointed without a cable.
 *
 * NVS wins when it is present. The namespace is `anchor-wallets`, a sibling of `wifi_setup.cpp`'s
 * `anchor-wifi` rather than a key inside it, for the reason that file's own comment gives: one
 * writer per namespace, because two credential stores on one device is how a unit ends up replaying
 * something that never worked. This module only ever *reads* both.
 *
 * **Nothing on the device writes `anchor-wallets` yet**, and that is worth stating rather than
 * implying. The Wi-Fi flow types a passphrase on the glass through `pulse_wifi.cpp`, and the same
 * input archetype could take an address list — that is a screen somebody should design on purpose,
 * not a thing to smuggle in here. Until then the override is reachable by writing the namespace
 * (the simulator's NVS is a text file, and `nvs_partition_gen` writes a real one), and the
 * compiled-in list is what a flashed unit runs on.
 */
struct WalletConfig {
	char values[MAX_WALLETS][WALLET_ADDRESS_MAX + 1];
	size_t asked;
	size_t configured;
	uint32_t revision;
};
WalletConfig walletConfig{};

/*
 * What may be put into a URL path, checked character by character.
 *
 * This string is interpolated into `PORTFOLIO_URL_FORMAT`, which makes it the one piece of
 * configuration on this device that can change *which endpoint is called*. A `/` or a `..` would
 * reach another route; a `?` or a `#` would append a parameter this file did not write. So the
 * accepted set is letters and digits and nothing else, which covers a 42-character `0x…` EVM
 * address and a base58 Solana one and excludes every character that means something to a URL.
 *
 * That also removes the percent-encoding question entirely, which `docs/upstream.md` records as a
 * live hazard in the other direction — encoding a path segment twice. There is nothing here to
 * encode: an address that would need it is refused instead.
 */
bool addressLooksSane(const char *text, size_t length) {
	if (length < 26 || length > WALLET_ADDRESS_MAX) return false;
	for (size_t i = 0; i < length; i++) {
		const char c = text[i];
		const bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
		if (!alnum) return false;
	}
	return true;
}

/*
 * Split a configured list into addresses.
 *
 * Commas, spaces and newlines all separate, because a list somebody typed or pasted is a list with
 * whatever whitespace came with it. `configured` counts every *plausible* address in the string,
 * including any past `MAX_WALLETS` that this unit will not ask about — so a list of fourteen on a
 * unit that reads twelve renders "12 of 14" rather than a total that quietly covers twelve.
 * Something that is not an address at all is not counted as a wallet the answer is missing: it is
 * not a wallet.
 */
void splitWallets(WalletConfig &config, const char *list) {
	memset(config.values, 0, sizeof(config.values));
	config.asked = 0;
	config.configured = 0;
	if (list == nullptr) return;
	size_t i = 0;
	while (list[i] != '\0') {
		while (list[i] == ',' || list[i] == ' ' || list[i] == '\n' || list[i] == '\r' ||
		       list[i] == '\t') {
			i++;
		}
		const size_t start = i;
		while (list[i] != '\0' && list[i] != ',' && list[i] != ' ' && list[i] != '\n' &&
		       list[i] != '\r' && list[i] != '\t') {
			i++;
		}
		const size_t length = i - start;
		if (length == 0) continue;
		if (!addressLooksSane(list + start, length)) continue;
		config.configured++;
		if (config.asked < MAX_WALLETS) {
			memcpy(config.values[config.asked], list + start, length);
			config.values[config.asked][length] = '\0';
			config.asked++;
		}
	}
}

void readWallets(WalletConfig &config) {
	Preferences prefs;
	String stored;
	if (prefs.begin("anchor-wallets", true /* read-only */)) {
		stored = prefs.getString("list", "");
		prefs.end();
	}
	if (stored.length() > 0) {
		splitWallets(config, stored.c_str());
		if (config.configured > 0) return;
		/* Written but unusable — fall through to the compiled-in list rather than showing nothing.
		 * A unit that was handed a malformed list is better off saying what it knows than saying
		 * nothing, and the coverage label is what keeps that honest. */
	}
#if defined(ANCHOR_WALLETS)
	splitWallets(config, ANCHOR_WALLETS);
#else
	splitWallets(config, "");
#endif
}

bool sameWalletConfig(const WalletConfig &left, const WalletConfig &right) {
	return left.asked == right.asked && left.configured == right.configured &&
	       memcmp(left.values, right.values, sizeof(left.values)) == 0;
}

bool refreshWallets() {
	WalletConfig next{};
	readWallets(next);
	if (sameWalletConfig(walletConfig, next)) return false;
	next.revision = walletConfig.revision + 1u;
	if (next.revision == 0) next.revision = 1;
	walletConfig = next;
	return true;
}

/*
 * The root store, from the certificate bundle ESP-IDF already compiles into this image.
 *
 * `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL=y` in the core's own sdkconfig, so the roots are
 * there whether this file references them or not; naming the symbols is what makes the linker keep
 * them. The alternative most firmware reaches for is `client.setInsecure()`, which this file will
 * not do: a device that accepts any certificate on a strange conference WiFi is a device whose API
 * key is readable by whoever runs the access point, and `docs/security.md` is not ambiguous about
 * that. The other alternative, pinning one root the way the Cardputer's `net::caBundle()` does, is
 * a root that expires while a box of units sits in a drawer.
 */
extern "C" const uint8_t x509CrtBundleStart[] asm("_binary_x509_crt_bundle_start");
extern "C" const uint8_t x509CrtBundleEnd[] asm("_binary_x509_crt_bundle_end");

/* Compiled-in sentences only — never an HTTP body, never a header, never a token name. */
const char *reasonForHttp(int code) {
	if (code == 401 || code == 403) return "OpenSea refused this unit's API key";
	if (code == 404) return "OpenSea does not know that endpoint";
	if (code == 429) return "rate limited by OpenSea";
	if (code >= 500) return "OpenSea returned a server error";
	if (code < 0) return "could not reach api.opensea.io";
	return "OpenSea returned an unexpected status";
}

bool requestWanted(const Request &request) {
	bool wanted = false;
	portENTER_CRITICAL(&publishLock);
	wanted = requests.current(request);
	portEXIT_CRITICAL(&publishLock);
	return wanted;
}

class BoundedBodyStream : public Stream {
public:
	BoundedBodyStream(Stream &source, const Request &request)
	    : source_(source), request_(request), started_(millis()) {
		setTimeout(READ_TIMEOUT_MS);
	}

	int available() override { return allowed() ? source_.available() : 0; }
	int read() override { return allowed() ? source_.read() : -1; }
	int peek() override { return allowed() ? source_.peek() : -1; }
	void flush() override { source_.flush(); }
	size_t write(uint8_t byte) override {
		(void)byte;
		return 0;
	}
	bool expired() const { return millis() - started_ >= BODY_BUDGET_MS; }
	bool cancelled() const { return !requestWanted(request_); }

private:
	Stream &source_;
	Request request_;
	uint32_t started_;

	bool allowed() const { return !expired() && !cancelled(); }
};

/*
 * One fetch, start to finish, on the worker task. Every blocking call in this module is inside it.
 */
bool fetchOnce(const Request &request, Token *out, size_t &count, const char *&err, int &code) {
	count = 0;
	if (!requestWanted(request) || WiFi.status() != WL_CONNECTED) {
		err = "the network dropped mid-fetch";
		return false;
	}

	WiFiClientSecure client;
	client.setCACertBundle(x509CrtBundleStart, (size_t)(x509CrtBundleEnd - x509CrtBundleStart));
	client.setHandshakeTimeout(HANDSHAKE_TIMEOUT_S);
	client.setTimeout(READ_TIMEOUT_MS / 1000);

	HTTPClient http;
	if (!http.begin(client, TRENDING_URL)) {
		err = "could not open the request";
		return false;
	}
	http.setConnectTimeout(CONNECT_TIMEOUT_MS);
	http.setTimeout(READ_TIMEOUT_MS);
	http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
	http.setRedirectLimit(3);
	/*
	 * HTTP/1.0, the same choice and the same reason as `standalone.cpp` and flint's `net.cpp`:
	 * over 1.1 the server may chunk the body, and `deserializeJson` reading straight off the
	 * stream chokes on the chunk framing. It also guarantees the `Content-Length` the size check
	 * below depends on.
	 */
	http.useHTTP10(true);
	http.addHeader("Accept", "application/json");
	http.addHeader("X-API-KEY", OPENSEA_API_KEY);

	code = http.GET();
	if (!requestWanted(request)) {
		err = "the request was cancelled";
		http.end();
		return false;
	}
	if (code != HTTP_CODE_OK) {
		err = reasonForHttp(code);
		http.end();
		return false;
	}

	const int size = http.getSize();
	if (size < 0 || size > MAX_RESPONSE_BYTES) {
		err = size < 0 ? "the response would not say how big it is"
		               : "the response is larger than this unit will read";
		http.end();
		return false;
	}

	err = nullptr;
	BoundedBodyStream body(http.getStream(), request);
	count = parseTrending(body, out, MAX_TOKENS, &err);
	http.end();
	if (body.cancelled()) {
		err = "the request was cancelled";
		return false;
	}
	if (body.expired()) {
		err = "the response took too long to read";
		return false;
	}
	if (count == 0) {
		if (err == nullptr) err = "the trending list came back empty";
		return false;
	}
	err = nullptr;
	return true;
}

/*
 * One address's portfolio. Same discipline as `fetchOnce`: every blocking call is on the worker.
 *
 * Factored so the request setup is written once — the CA bundle, the timeouts, HTTP/1.0, the size
 * ceiling and the header are properties of *this unit talking to OpenSea*, not of one endpoint, and
 * a second copy of them is a second place for `setInsecure()` to appear during a debugging session.
 */
bool fetchPortfolioOnce(const Request &request, const char *address, Figures &out, const char *&err,
                        int &code) {
	if (!requestWanted(request) || WiFi.status() != WL_CONNECTED) {
		err = "the network dropped mid-fetch";
		return false;
	}

	char url[160];
	const int written = snprintf(url, sizeof(url), PORTFOLIO_URL_FORMAT, address);
	if (written < 0 || (size_t)written >= sizeof(url)) {
		err = "that address does not fit in a request";
		return false;
	}

	WiFiClientSecure client;
	client.setCACertBundle(x509CrtBundleStart, (size_t)(x509CrtBundleEnd - x509CrtBundleStart));
	client.setHandshakeTimeout(HANDSHAKE_TIMEOUT_S);
	client.setTimeout(READ_TIMEOUT_MS / 1000);

	HTTPClient http;
	if (!http.begin(client, url)) {
		err = "could not open the request";
		return false;
	}
	http.setConnectTimeout(CONNECT_TIMEOUT_MS);
	http.setTimeout(READ_TIMEOUT_MS);
	http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
	http.setRedirectLimit(3);
	http.useHTTP10(true);
	http.addHeader("Accept", "application/json");
	http.addHeader("X-API-KEY", OPENSEA_API_KEY);

	code = http.GET();
	if (!requestWanted(request)) {
		err = "the request was cancelled";
		http.end();
		return false;
	}
	if (code != HTTP_CODE_OK) {
		err = reasonForHttp(code);
		http.end();
		return false;
	}

	const int size = http.getSize();
	if (size < 0 || size > MAX_RESPONSE_BYTES) {
		err = size < 0 ? "the response would not say how big it is"
		               : "the response is larger than this unit will read";
		http.end();
		return false;
	}

	err = nullptr;
	BoundedBodyStream body(http.getStream(), request);
	const bool ok = parsePortfolio(body, out, &err);
	http.end();
	if (body.cancelled()) {
		err = "the request was cancelled";
		return false;
	}
	if (body.expired()) {
		err = "the response took too long to read";
		return false;
	}
	if (!ok && err == nullptr) err = "the portfolio did not parse";
	return ok;
}

/*
 * Every configured wallet, summed, with what it could not reach counted rather than dropped.
 *
 * Sequential, which is `fanOut`'s choice in `service/src/aggregate.ts` and for the same reason: one
 * radio, one TLS session's worth of heap, and a fan-out that cannot starve anything behind it. The
 * gap between requests is this unit's share of the same politeness the service's rate limiter
 * enforces.
 *
 * The three rules from AGENTS.md are all visible in this function, which is the point of it being
 * one function: **every** wallet is read, the money is summed as integers, and a wallet that did not
 * answer raises `configured` above `covered` instead of vanishing.
 */
bool fetchPortfolio(const RequestJob &job, Portfolio &out, const char *&err, int &code) {
	memset(&out, 0, sizeof(out));
	out.configured = job.walletsConfigured;
	snprintf(out.total, sizeof(out.total), "--");
	snprintf(out.nftValue, sizeof(out.nftValue), "--");
	snprintf(out.change, sizeof(out.change), "--");

	int64_t total = 0;
	int64_t nft = 0;
	int64_t pnl = 0;
	bool haveTotal = false;
	bool haveNft = false;
	bool havePnl = false;
	const char *lastErr = nullptr;

	for (size_t i = 0; i < job.walletsAsked; i++) {
		if (!requestWanted(job.request)) {
			err = "the request was cancelled";
			return false;
		}
		if (i > 0) {
			delay(WALLET_GAP_MS);
			if (!requestWanted(job.request)) {
				err = "the request was cancelled";
				return false;
			}
		}
		Figures figures;
		const char *walletErr = nullptr;
		int walletCode = 0;
		if (!fetchPortfolioOnce(job.request, job.wallets[i], figures, walletErr, walletCode)) {
			lastErr = walletErr;
			code = walletCode;
			continue;
		}
		code = walletCode;
		/*
		 * Overflow is a failed pass, not a clamped total. Nothing renders a number this arithmetic
		 * could not hold — see `addMicros`.
		 */
		if (figures.haveTotal && !addMicros(total, figures.totalMicros, &total)) {
			err = "the total does not fit in this unit's arithmetic";
			return false;
		}
		if (figures.haveNft && !addMicros(nft, figures.nftMicros, &nft)) {
			err = "the total does not fit in this unit's arithmetic";
			return false;
		}
		if (figures.havePnl && !addMicros(pnl, figures.pnlMicros, &pnl)) {
			err = "the total does not fit in this unit's arithmetic";
			return false;
		}
		haveTotal = haveTotal || figures.haveTotal;
		haveNft = haveNft || figures.haveNft;
		havePnl = havePnl || figures.havePnl;
		out.covered++;
	}

	if (out.covered == 0) {
		err = lastErr != nullptr ? lastErr : "no wallet answered";
		return false;
	}

	if (haveTotal) formatUsdMicros(total, out.total, sizeof(out.total));
	if (haveNft) formatUsdMicros(nft, out.nftValue, sizeof(out.nftValue));

	/*
	 * The percentage, derived rather than collected.
	 *
	 * `pnl_percentage` arrives per address and **must not be averaged**: `combinePortfolio` in
	 * `service/src/aggregate.ts` refuses to, because averaging nine wallets' percentages weights a
	 * $12 wallet the same as a $2,000 one. So the move is summed in dollars — which does add — and
	 * the percentage comes from the move over what it moved from, exactly as `percentageOf` does it
	 * there: `start = end - change`, `pct = change / start`.
	 *
	 * This is the one figure allowed through a double, and that is `percentageOf`'s own choice for
	 * the same reason: it is a ratio for display, not a sum. The dollars it is computed from were
	 * never floats. A portfolio that started at nothing has no percentage and renders "--" rather
	 * than a fabricated zero.
	 */
	if (haveTotal && havePnl) {
		const double moved = (double)pnl / 1000000.0;
		const double finished = (double)total / 1000000.0;
		const double started = finished - moved;
		if (started != 0.0 && isfinite(started)) {
			const double pct = (moved / started) * 100.0;
			formatPercent(pct, out.change, sizeof(out.change));
			out.haveChange = isfinite(pct);
			out.changePositive = pct >= 0.0;
		}
	}

	err = nullptr;
	return true;
}

/*
 * The worker, asleep until `tick()` says so.
 *
 * `ulTaskNotifyTake(pdTRUE, portMAX_DELAY)` means this task consumes no CPU between fetches —
 * it is not polling a flag, it is blocked in the scheduler — so the cost of having it on core 0 at
 * rest is its stack and nothing else. All the *policy* (how often, whether the radio is free,
 * whether the credentials exist) lives in `tick()` on the loop task; this task only does the part
 * that blocks.
 */
void workerTask(void *) {
	for (;;) {
		ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

		RequestJob job{};
		bool wanted = false;
		portENTER_CRITICAL(&publishLock);
		job = pendingJob;
		wanted = requests.current(job.request);
		portEXIT_CRITICAL(&publishLock);

		RequestResult result{};
		result.request = job.request;
		if (wanted) {
			const char *err = nullptr;
			if (job.request.kind == RequestKind::Trending) {
				result.ok = fetchOnce(job.request, result.tokens, result.count, err, result.httpCode);
			} else if (job.request.kind == RequestKind::Portfolio) {
				result.ok = fetchPortfolio(job, result.portfolio, err, result.httpCode);
			}
			result.reason = err;
		}
		result.finishedAt = millis();
		result.stackFree = (uint32_t)uxTaskGetStackHighWaterMark(nullptr);

		portENTER_CRITICAL(&publishLock);
		if (requests.complete(job.request)) readyResult = result;
		portEXIT_CRITICAL(&publishLock);
	}
}

void applyResult(const RequestResult &result) {
	portENTER_CRITICAL(&publishLock);
	lastHttpCode = result.httpCode;
	workerStackFree = result.stackFree;
	if (result.request.kind == RequestKind::Trending) {
		fetching = false;
		if (result.ok) {
			memcpy(published, result.tokens, sizeof(published));
			publishedCount = result.count;
			lastSuccessMs = result.finishedAt;
			everSucceeded = true;
			failReason = nullptr;
		} else {
			failReason = result.reason != nullptr ? result.reason : "the fetch failed";
		}
	} else if (result.request.kind == RequestKind::Portfolio) {
		portfolioFetching = false;
		if (result.ok) {
			memcpy(&publishedPortfolio, &result.portfolio, sizeof(publishedPortfolio));
			portfolioSuccessMs = result.finishedAt;
			portfolioEver = true;
			portfolioFailReason = nullptr;
		} else {
			portfolioFailReason =
			    result.reason != nullptr ? result.reason : "the portfolio fetch failed";
		}
	}
	portEXIT_CRITICAL(&publishLock);
}

void consumeResult() {
	RequestResult result{};
	bool ready = false;
	portENTER_CRITICAL(&publishLock);
	if (requests.consume() != 0) {
		result = readyResult;
		ready = true;
	}
	portEXIT_CRITICAL(&publishLock);
	if (ready) applyResult(result);
}

bool startRequest(RequestKind kind) {
	RequestJob job{};
	portENTER_CRITICAL(&publishLock);
	job.request = requests.start(kind);
	if (job.request.ticket != 0) {
		job.walletsAsked = walletConfig.asked;
		job.walletsConfigured = walletConfig.configured;
		memcpy(job.wallets, walletConfig.values, sizeof(job.wallets));
		pendingJob = job;
		if (kind == RequestKind::Trending) {
			fetching = true;
		} else {
			portfolioFetching = true;
		}
	}
	portEXIT_CRITICAL(&publishLock);
	if (job.request.ticket == 0) return false;
	xTaskNotifyGive(worker);
	return true;
}

#endif /* ANCHOR_FEED_LIVE */

}  // namespace

/* ---------------------------------------------------------------- the public surface ---------- */

void begin() {
#if ANCHOR_FEED_LIVE
	memset(published, 0, sizeof(published));
	memset(&publishedPortfolio, 0, sizeof(publishedPortfolio));
	readWallets(walletConfig);
	walletConfig.revision = 1;
	lastWalletCheck = millis();
	const BaseType_t created = xTaskCreatePinnedToCore(
	    workerTask, "anchor-feed", WORKER_STACK_BYTES, nullptr, WORKER_PRIORITY, &worker, WORKER_CORE);
	portENTER_CRITICAL(&publishLock);
	requests.setWorkerAvailable(created == pdPASS);
	if (created != pdPASS) {
		worker = nullptr;
		workerUnavailable = true;
		failReason = "could not start background requests";
		portfolioFailReason = "could not start background requests";
	}
	portEXIT_CRITICAL(&publishLock);
#endif
}

void tick(bool configured, bool connected, bool radioBusy, uint32_t revision) {
#if !ANCHOR_FEED_LIVE
	(void)configured;
	(void)connected;
	(void)radioBusy;
	(void)revision;
#else
	/*
	 * Network I/O and response parsing stay on the worker. This loop coordinates requests and
	 * periodically reads the wallet configuration from NVS; that local read can allocate Strings.
	 * It does not perform DNS, open sockets, or wait for TLS. Adding those operations here would
	 * break the separation that keeps network timeouts off the input/rendering task.
	 */
	const uint32_t now = millis();

	bool walletsChanged = false;
	if (now - lastWalletCheck >= WALLET_RECHECK_MS) {
		lastWalletCheck = now;
		walletsChanged = refreshWallets();
		if (walletsChanged) {
			memset(&publishedPortfolio, 0, sizeof(publishedPortfolio));
			portfolioEver = false;
			portfolioSuccessMs = 0;
			portfolioFailReason = nullptr;
			lastPortfolioAttemptMs = 0;
		}
	}

	networkConfigured = configured;
	networkConnected = connected;
	networkRadioBusy = radioBusy;
	networkRevision = revision;
	const RequestContext context = {configured, connected, radioBusy, revision,
	                                walletConfig.revision};
	portENTER_CRITICAL(&publishLock);
	const Observation observation = requests.observe(context);
	if (observation.networkChanged && !workerUnavailable) {
		failReason = nullptr;
		portfolioFailReason = nullptr;
	}
	if (observation.discarded || walletsChanged) {
		fetching = false;
		portfolioFetching = false;
	}
	portEXIT_CRITICAL(&publishLock);
	if (observation.networkChanged) {
		lastAttemptMs = 0;
		lastPortfolioAttemptMs = 0;
	}

	consumeResult();
	if (worker == nullptr || workerUnavailable || !configured || !connected || radioBusy) return;

	bool busy = false;
	bool failing = false;
	bool portfolioBusy = false;
	bool portfolioFailing = false;
	portENTER_CRITICAL(&publishLock);
	busy = requests.busy();
	failing = failReason != nullptr;
	portfolioFailing = portfolioFailReason != nullptr;
	portEXIT_CRITICAL(&publishLock);
	portfolioBusy = busy;

	/* Back off less after a failure than after a success: a unit that just joined a network wants
	 * its first screen, and a unit that is up to date does not want the radio. */
	if (!busy && !portfolioBusy) {
		const uint32_t interval = failing ? RETRY_MS : POLL_MS;
		if (lastAttemptMs == 0 || now - lastAttemptMs >= interval) {
			lastAttemptMs = now == 0 ? 1 : now;
			startRequest(RequestKind::Trending);
			return;
		}
	}

	/*
	 * One job at a time on one worker, and the trending fetch goes first when both are due.
	 *
	 * Not a priority call about which number matters more — the portfolio is the one this device is
	 * for. It is that the two fetches share a task, and starting the slower one (a request per
	 * address) first would make the faster one wait behind a fan-out. Both are on their own clocks
	 * and neither is dropped: a job that is due while the other is running simply fires on the next
	 * pass through `loop()`, which is milliseconds away.
	 */
	if (busy || portfolioBusy || walletConfig.asked == 0) {
		return;
	}
	const uint32_t portfolioInterval = portfolioFailing ? PORTFOLIO_RETRY_MS : PORTFOLIO_POLL_MS;
	if (lastPortfolioAttemptMs != 0 && now - lastPortfolioAttemptMs < portfolioInterval) {
		return;
	}
	lastPortfolioAttemptMs = now == 0 ? 1 : now;
	startRequest(RequestKind::Portfolio);
#endif
}

Snapshot snapshot() {
	Snapshot out;
	memset(&out, 0, sizeof(out));
	out.ageMs = UINT32_MAX;
	out.portfolioAgeMs = UINT32_MAX;
	/* A portfolio nobody has fetched still has to render as something, and "--" is the only honest
	 * something. `$0.00` would be a reading. */
	snprintf(out.portfolio.total, sizeof(out.portfolio.total), "--");
	snprintf(out.portfolio.nftValue, sizeof(out.portfolio.nftValue), "--");
	snprintf(out.portfolio.change, sizeof(out.portfolio.change), "--");

#if !ANCHOR_FEED_LIVE
	out.status = Status::Disabled;
	out.reason = "no OpenSea key on this unit";
	out.portfolioStatus = Status::Disabled;
	out.portfolioReason = "no OpenSea key on this unit";
	return out;
#else
	const uint32_t now = millis();

	bool busy = false;
	const char *err = nullptr;
	uint32_t success = 0;
	bool portfolioBusy = false;
	const char *portfolioErr = nullptr;
	uint32_t portfolioSuccess = 0;
	portENTER_CRITICAL(&publishLock);
	memcpy(out.tokens, published, sizeof(out.tokens));
	out.count = publishedCount;
	out.everSucceeded = everSucceeded;
	out.lastHttpCode = lastHttpCode;
	out.workerStackFreeBytes = workerStackFree;
	busy = fetching;
	err = failReason;
	success = lastSuccessMs;
	if (portfolioEver) {
		memcpy(&out.portfolio, &publishedPortfolio, sizeof(out.portfolio));
	}
	out.portfolioEverSucceeded = portfolioEver;
	portfolioBusy = portfolioFetching;
	portfolioErr = portfolioFailReason;
	portfolioSuccess = portfolioSuccessMs;
	portEXIT_CRITICAL(&publishLock);

	if (out.everSucceeded) {
		out.ageMs = now - success;
	}
	if (out.portfolioEverSucceeded) {
		out.portfolioAgeMs = now - portfolioSuccess;
	}

	/*
	 * How far the portfolio got, in the same order the chain stops — and `configured` is filled in
	 * whatever the answer is, because "no addresses" and "three addresses and no answer" are two
	 * different screens.
	 *
	 * `walletConfig` is read here from the loop task, which is also the only writer: `snapshot()` is
	 * called from `loop()` on this device, next to `tick()`.
	 */
	if (!out.portfolioEverSucceeded) {
		out.portfolio.configured = walletConfig.configured;
	}
	if (workerUnavailable) {
		out.portfolioStatus = Status::Failed;
		out.portfolioReason = "could not start background requests";
	} else if (!networkConfigured) {
		out.portfolioStatus = Status::NoCredentials;
		out.portfolioReason = "tap anywhere to set up wi-fi";
	} else if (walletConfig.asked == 0) {
		out.portfolioStatus = Status::NoWallets;
		out.portfolioReason = "no addresses configured on this unit";
	} else if (networkRadioBusy) {
		out.portfolioStatus = Status::Joining;
		out.portfolioReason = "wi-fi setup is open";
	} else if (!networkConnected) {
		out.portfolioStatus = Status::Joining;
		out.portfolioReason = "joining the saved network";
	} else if (portfolioBusy) {
		out.portfolioStatus = Status::Fetching;
		out.portfolioReason = "reading every configured address";
	} else if (portfolioErr != nullptr) {
		out.portfolioStatus = Status::Failed;
		out.portfolioReason = portfolioErr;
	} else {
		out.portfolioStatus = Status::Online;
		out.portfolioReason =
		    out.portfolioEverSucceeded ? "up to date" : "waiting for the first fetch";
	}

	/*
	 * Why it is empty, in the order the chain actually stops. AGENTS.md's rule — "An empty list
	 * must say why it is empty" — is the reason this is a status and a sentence rather than a
	 * count of zero.
	 *
	 * The SSID is deliberately *not* in any of these sentences. It is not this unit's string: it
	 * arrived in an access point's beacon frame, was picked off a scan list, and is exactly as
	 * untrusted as a token name. A network called `\e[2J` has no business on the panel.
	 */
	if (workerUnavailable) {
		out.status = Status::Failed;
		out.reason = "could not start background requests";
	} else if (!networkConfigured) {
		out.status = Status::NoCredentials;
		out.reason = "tap anywhere to set up wi-fi";
	} else if (networkRadioBusy) {
		out.status = Status::Joining;
		out.reason = "wi-fi setup is open";
	} else if (!networkConnected) {
		out.status = Status::Joining;
		out.reason = "joining the saved network";
	} else if (busy) {
		out.status = Status::Fetching;
		out.reason = "asking OpenSea what is trending";
	} else if (err != nullptr) {
		out.status = Status::Failed;
		out.reason = err;
	} else {
		out.status = Status::Online;
		out.reason = out.everSucceeded ? "up to date" : "waiting for the first fetch";
	}
	return out;
#endif
}

}  // namespace feed
