#include "standalone.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include <stdlib.h>

#include "net.h"

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// See standalone.h for why this exists at all. Everything below is gated on OPENSEA_API_KEY being
// compiled in, at both the definition and the call site — a checkout with no app/src/secrets.h
// builds and runs exactly as before this file existed, radio included: `profile::network()` still
// brings WiFi up (flint's spine, not this file), but nothing here ever makes a request without a
// key to send.
namespace standalone {

namespace {

// Trending tokens do not need to refresh faster than gwei does on a device with a radio budget to
// respect — see flint's own CLAUDE.md poll-window rule.
constexpr uint32_t POLL_MS = 60000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 8000;
constexpr uint32_t READ_TIMEOUT_MS = 8000;
constexpr uint8_t HANDSHAKE_TIMEOUT_S = 15;

uint32_t lastAttempt = 0;
bool everSucceeded = false;

// Money as a string, parsed for display only — the same convention `state/discovery.ts` measured
// against the live service (usdPrice arrives as a string) and the same reason `state/anchor.ts`'s
// usd() lives on the host: this device has no more business deciding how a dollar figure rounds
// than the Stream Deck does.
void formatUsd(double value, char *out, size_t n)
{
	if (value >= 1000.0) {
		snprintf(out, n, "$%.0f", value);
	} else if (value >= 1.0) {
		snprintf(out, n, "$%.2f", value);
	} else {
		snprintf(out, n, "$%.4f", value);
	}
}

void formatPercent(double value, char *out, size_t n)
{
	snprintf(out, n, "%s%.2f%%", value >= 0.0 ? "+" : "", value);
}

#ifdef OPENSEA_API_KEY
bool fetchOnce()
{
	if (!net::online()) {
		return false;
	}

	WiFiClientSecure client;
	client.setCACert(net::caBundle());
	client.setHandshakeTimeout(HANDSHAKE_TIMEOUT_S);
	client.setTimeout(READ_TIMEOUT_MS / 1000);

	HTTPClient http;
	if (!http.begin(client, "https://api.opensea.io/api/v2/tokens/trending?limit=8")) {
		return false;
	}
	http.setConnectTimeout(CONNECT_TIMEOUT_MS);
	http.setTimeout(READ_TIMEOUT_MS);
	http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
	http.setRedirectLimit(3);
	// HTTP/1.0, matching net.cpp's own reasoning: over 1.1 the server may chunk, and
	// deserializeJson reading straight off the stream chokes on the chunk framing.
	http.useHTTP10(true);
	http.addHeader("Accept", "application/json");
	http.addHeader("X-API-KEY", OPENSEA_API_KEY);

	const int code = http.GET();
	if (code != HTTP_CODE_OK) {
		Serial.printf("standalone: fetch failed, HTTP %d\n", code);
		http.end();
		return false;
	}

	// Keep only the four fields this screen draws. A trending-token row carries dozens more
	// (openseaUrl, marketCapUsd, volume24h, decimals, isVerified, createdAt...) that a 240x123
	// screen has no room for and this device has no use reading.
	JsonDocument filter;
	JsonObject tokenFilter = filter["tokens"][0].to<JsonObject>();
	tokenFilter["symbol"] = true;
	tokenFilter["name"] = true;
	tokenFilter["usdPrice"] = true;
	tokenFilter["priceChange24h"] = true;

	JsonDocument doc;
	const DeserializationError err =
	    deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filter));
	http.end();
	if (err) {
		Serial.printf("standalone: parse failed, %s\n", err.c_str());
		return false;
	}

	JsonArrayConst list = doc["tokens"].as<JsonArrayConst>();
	if (list.isNull()) {
		return false;
	}

	size_t count = 0;
	for (JsonObjectConst entry : list) {
		if (count >= MAX_TOKENS) {
			break;
		}
		Token &t = tokens[count];
		snprintf(t.symbol, sizeof(t.symbol), "%s", entry["symbol"] | "");
		snprintf(t.name, sizeof(t.name), "%s", entry["name"] | "");
		formatUsd(atof(entry["usdPrice"] | "0"), t.price, sizeof(t.price));
		const double change = entry["priceChange24h"] | 0.0;
		formatPercent(change, t.change, sizeof(t.change));
		t.changePositive = change >= 0.0;
		count++;
	}
	if (count == 0) {
		return false;
	}
	tokenCount = count;
	everSucceeded = true;
	return true;
}
#endif

}  // namespace

Token tokens[MAX_TOKENS];
size_t tokenCount = 0;

void tick()
{
#ifdef OPENSEA_API_KEY
	const uint32_t now = millis();
	if (lastAttempt != 0 && now - lastAttempt < POLL_MS) {
		return;
	}
	lastAttempt = now;
	fetchOnce();
#endif
}

bool hasData()
{
	return everSucceeded && tokenCount > 0;
}

}  // namespace standalone
