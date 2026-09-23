/* Checks happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include <ArduinoJson.h>

#include "trending_rows.h"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

namespace {

/* The same fixed fields as `feed::Token` and `standalone::Token`. */
struct Row {
	char symbol[12];
	char name[24];
	char price[16];
	char change[10];
	char volume[16];
	char chain[16];
	char address[48];
	bool changePositive;
};

size_t read(const char *json, Row *rows, size_t max)
{
	JsonDocument filter;
	anchor_trending::fillFilter(filter);
	JsonDocument doc;
	const DeserializationError error =
	    deserializeJson(doc, json, DeserializationOption::Filter(filter),
	                    DeserializationOption::NestingLimit(6));
	assert(!error);
	return anchor_trending::readRows(anchor_trending::tokenList(doc), rows, max);
}

std::string slurp(const char *path)
{
	std::ifstream in(path);
	assert(in.good());
	std::stringstream buffer;
	buffer << in.rdbuf();
	return buffer.str();
}

}  // namespace

int main(int argc, char **argv)
{
	assert(argc == 2);
	Row rows[8];

	/* A live response from 2026-09-23, trimmed to the fields the devices read. */
	const std::string captured = slurp(argv[1]);
	assert(read(captured.c_str(), rows, 8) == 8);
	assert(std::strcmp(rows[0].symbol, "STONK") == 0);
	assert(std::strcmp(rows[0].chain, "solana") == 0);
	assert(std::strcmp(rows[0].address, "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx") == 0);
	assert(std::strcmp(rows[0].price, "$0.3510") == 0);
	assert(std::strcmp(rows[0].change, "+0.07%") == 0 && rows[0].changePositive);
	assert(std::strcmp(rows[0].volume, "$15.6M") == 0);
	/* A sub-cent price from the same response, which read "$0.0066" before the formatter changed. */
	assert(std::strcmp(rows[1].symbol, "MONITOR") == 0);
	assert(std::strcmp(rows[1].price, "$0.00661") == 0);
	assert(std::strcmp(rows[1].name, "The Situation") == 0);

	/* The anchor-service envelope and its camelCase fields read the same row. */
	const char *service =
	    R"({"data":{"tokens":[{"symbol":"PONS","name":"Pons","chain":"robinhood",)"
	    R"("address":"0x39dbed3a2bd333467115de45665cc57f813c4571","usdPrice":0.6602,)"
	    R"("priceChange24h":-1.5,"volume24h":997000}]}})";
	assert(read(service, rows, 8) == 1);
	assert(std::strcmp(rows[0].price, "$0.6602") == 0);
	assert(std::strcmp(rows[0].change, "-1.50%") == 0 && !rows[0].changePositive);
	assert(std::strcmp(rows[0].volume, "$997K") == 0);

	/* Rows that cannot be identified or named are dropped, and the rest keep their order. A missing
	 * price is "--", never "$0.0000". Control characters are removed from what gets drawn. */
	const char *hostile =
	    R"({"tokens":[)"
	    R"({"symbol":"NOCHAIN","address":"0xabc","usd_price":"1"},)"
	    R"({"symbol":"LONG","chain":"solana","address":"0123456789012345678901234567890123456789012345678901","usd_price":"1"},)"
	    R"({"chain":"solana","address":"Nameless111","usd_price":"1"},)"
	    R"({"symbol":"OK\u001b[31m","name":"Fine","chain":"solana","address":"Good111"},)"
	    R"({"symbol":"NUM","chain":"base","address":"0xdef","usd_price":"not a number","price_change_24h":"3.5"},)"
	    R"({"symbol":"AVERYLONGSYMBOL","name":"A collection name far longer than any field","chain":"base","address":"0x123"})"
	    R"(]})";
	assert(read(hostile, rows, 8) == 3);
	assert(std::strcmp(rows[0].symbol, "OK[31m") == 0);
	assert(std::strcmp(rows[0].price, "--") == 0 && std::strcmp(rows[0].volume, "--") == 0);
	assert(std::strcmp(rows[0].change, "--") == 0 && !rows[0].changePositive);
	assert(std::strcmp(rows[1].symbol, "NUM") == 0);
	assert(std::strcmp(rows[1].price, "--") == 0);
	assert(std::strcmp(rows[1].change, "+3.50%") == 0);
	/* Display text longer than its field is truncated, not overrun. */
	assert(std::strcmp(rows[2].symbol, "AVERYLONGSY") == 0);
	assert(std::strcmp(rows[2].name, "A collection name far l") == 0);

	/* No list at all, an empty list, and more rows than there is room for. */
	assert(read(R"({"next":null})", rows, 8) == 0);
	assert(read(R"({"tokens":[]})", rows, 8) == 0);
	assert(read(captured.c_str(), rows, 3) == 3);
	return 0;
}
