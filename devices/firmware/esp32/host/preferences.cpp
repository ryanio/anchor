#include "Preferences.h"

#include <assert.h>
#include <stdio.h>
#include <string>

namespace {

std::string repeatedHex(char byte, size_t bytes)
{
	const char digits[] = "0123456789abcdef";
	std::string out;
	out.reserve(bytes * 2);
	for (size_t i = 0; i < bytes; i++) {
		const unsigned char value = (unsigned char)(byte + (char)i);
		out.push_back(digits[value >> 4]);
		out.push_back(digits[value & 0x0f]);
	}
	return out;
}

std::string maximumProfileBlob()
{
	std::string blob = "v1;";
	for (size_t i = 0; i < 4; i++) {
		blob += repeatedHex((char)('A' + i), 32);
		blob += ',';
		blob += repeatedHex((char)('a' + i), 63);
		blob += ';';
	}
	return blob;
}

void survivesRestartWithoutTruncation(const char *path)
{
	const std::string blob = maximumProfileBlob();
	assert(blob.size() == 771);

	Preferences::simSetPath(path);
	Preferences prefs;
	assert(prefs.begin("anchor-wifi", false));
	assert(prefs.putString("profiles", String(blob)) == blob.size());
	prefs.end();

	/* Reload from disk rather than accepting the process-local map as evidence. */
	Preferences::simSetPath(path);
	assert(prefs.begin("anchor-wifi", true));
	assert(prefs.getString("profiles", "") == blob);
	prefs.end();
}

void mutationsMatchNamespaceAndAccessMode(const char *path)
{
	Preferences::simSetPath(path);
	Preferences prefs;
	assert(prefs.begin("unrelated", false));
	assert(prefs.putString("keep", "present") == 7);
	prefs.end();

	assert(prefs.begin("anchor-wifi", false));
	assert(prefs.putString("ssid", "working") == 7);
	assert(prefs.putString("pass", "secret fixture") == 14);
	prefs.end();

	assert(prefs.begin("anchor-wifi", true));
	assert(!prefs.remove("pass"));
	assert(!prefs.clear());
	assert(prefs.getString("pass", "") == "secret fixture");
	prefs.end();

	assert(prefs.begin("anchor-wifi", false));
	assert(prefs.remove("pass"));
	assert(!prefs.remove("pass"));
	assert(prefs.clear());
	prefs.end();

	Preferences::simSetPath(path);
	assert(prefs.begin("anchor-wifi", true));
	assert(prefs.getString("ssid", "missing") == "missing");
	prefs.end();
	assert(prefs.begin("unrelated", true));
	assert(prefs.getString("keep", "") == "present");
	prefs.end();
}

}  // namespace

int main(int argc, char **argv)
{
	assert(argc == 2);
	survivesRestartWithoutTruncation(argv[1]);
	mutationsMatchNamespaceAndAccessMode(argv[1]);
	remove(argv[1]);
	return 0;
}
