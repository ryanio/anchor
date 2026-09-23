#pragma once

// Requires ArduinoJson 7, included by the caller before this header. Both firmwares already depend on
// it, and a host test includes it from the bootstrapped library directory.

#include <math.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "display_format.h"

// Reading `/api/v2/tokens/trending` into display rows, the same way on both handhelds.
//
// Each firmware had its own copy of this loop, with the same field names, the same identity rule and
// the same formatters, and the ESP32's also accepted anchor-service's `{ "data": { "tokens" } }`
// envelope while the Cardputer's did not. The acceptance list asks for both devices to show the same
// values from the same response, which one reader guarantees and two only promise.
// `trending_rows_test.cpp` runs it over a captured live response.
//
// Transport stays with each firmware: they fetch on different workers with different cancellation,
// and only hand this the parsed document.
namespace anchor_trending {

// The fields a row is read from, in both dialects: the live API speaks snake_case and anchor-service,
// whose model is devices/src/state/discovery.ts, speaks camelCase. A filter means every other field
// is walked and discarded as it streams past, so a payload never lands whole in RAM.
inline void fillRowFilter(JsonObject row)
{
	row["symbol"] = true;
	row["name"] = true;
	row["chain"] = true;
	row["address"] = true;
	row["usd_price"] = true;
	row["usdPrice"] = true;
	row["price_change_24h"] = true;
	row["priceChange24h"] = true;
	row["volume_24h"] = true;
	row["volume24h"] = true;
}

// A filter for both envelopes: the public API's `{ "tokens": [...] }` and anchor-service's
// `{ "data": { "tokens": [...] } }`.
inline void fillFilter(JsonDocument &filter)
{
	fillRowFilter(filter["tokens"][0].to<JsonObject>());
	fillRowFilter(filter["data"]["tokens"][0].to<JsonObject>());
}

// The row list from either envelope, or a null array when there is none.
inline JsonArrayConst tokenList(const JsonDocument &doc)
{
	JsonArrayConst list = doc["tokens"].as<JsonArrayConst>();
	if (list.isNull()) {
		list = doc["data"]["tokens"].as<JsonArrayConst>();
	}
	return list;
}

// A number that may have arrived as a string. `usd_price` is a string and `price_change_24h` a
// number in the live response, and OpenSea is moving money fields to strings over time. Anything
// that is neither is NaN rather than zero, so it formats as "--".
inline double numberOf(JsonVariantConst value)
{
	if (value.is<double>()) {
		return value.as<double>();
	}
	if (value.is<const char *>()) {
		const char *text = value.as<const char *>();
		if (text == nullptr || *text == '\0') {
			return NAN;
		}
		char *end = nullptr;
		const double parsed = strtod(text, &end);
		return end == text ? NAN : parsed;
	}
	return NAN;
}

// Whichever dialect answered.
inline JsonVariantConst either(JsonObjectConst entry, const char *snake, const char *camel)
{
	JsonVariantConst value = entry[snake];
	return value.isNull() ? entry[camel] : value;
}

// Token identity is request input, so truncating or cleaning it would change which token a detail
// request names. Accept a nonempty printable string only when it fits whole.
inline bool copyIdentity(char *out, size_t n, const char *in)
{
	if (out == nullptr || n < 2) {
		return false;
	}
	out[0] = '\0';
	if (in == nullptr || in[0] == '\0') {
		return false;
	}
	size_t length = 0;
	for (; in[length] != '\0'; length++) {
		const unsigned char value = (unsigned char)in[length];
		if (length + 1 >= n || value < 0x20 || value > 0x7E) {
			return false;
		}
	}
	memcpy(out, in, length + 1);
	return true;
}

// Rows from a parsed list, formatted once. `Token` is either firmware's row type; both carry the
// same fixed-size fields, and the sizes come from the type rather than from constants here. A row
// whose chain or address is missing or would not fit whole is dropped, and so is one with neither
// symbol nor name, because a row that cannot be identified or named is not a row. Writes at most
// `max` rows and returns how many.
template <typename Token>
size_t readRows(JsonArrayConst list, Token *out, size_t max)
{
	if (list.isNull() || out == nullptr) {
		return 0;
	}
	size_t count = 0;
	for (JsonObjectConst entry : list) {
		if (count >= max) {
			break;
		}
		Token &token = out[count];
		memset(&token, 0, sizeof(token));
		anchor_format::copyBounded(token.symbol, sizeof(token.symbol), entry["symbol"] | "");
		anchor_format::copyBounded(token.name, sizeof(token.name), entry["name"] | "");
		if (!copyIdentity(token.chain, sizeof(token.chain), entry["chain"] | "") ||
		    !copyIdentity(token.address, sizeof(token.address), entry["address"] | "")) {
			continue;
		}
		if (token.symbol[0] == '\0' && token.name[0] == '\0') {
			continue;
		}
		anchor_format::formatUsd(numberOf(either(entry, "usd_price", "usdPrice")), token.price,
		                         sizeof(token.price));
		anchor_format::formatBigUsd(numberOf(either(entry, "volume_24h", "volume24h")), token.volume,
		                            sizeof(token.volume));
		const double change = numberOf(either(entry, "price_change_24h", "priceChange24h"));
		anchor_format::formatPercent(change, token.change, sizeof(token.change));
		token.changePositive = isfinite(change) && change >= 0.0;
		count++;
	}
	return count;
}

}  // namespace anchor_trending
