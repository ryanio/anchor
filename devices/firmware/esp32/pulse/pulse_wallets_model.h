#ifndef ANCHOR_PULSE_WALLETS_MODEL_H
#define ANCHOR_PULSE_WALLETS_MODEL_H

#include <ctype.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/*
 * The wallets a unit adds up, as a list somebody edits on the glass, with no LVGL and no NVS in it.
 *
 * Stored as two comma-separated strings in the `anchor-wallets` namespace: `list`, the addresses the
 * feed has always read, and `names`, what the person typed to find each one ("ryanryanryanryan",
 * "name.eth"), in the same order. The names are only ever the person's own words: nothing from the
 * network is kept here. `host/wallets.cpp` tests this file.
 */
namespace pulse_wallets {

constexpr size_t CAPACITY = 12; /* feed::MAX_WALLETS: what one portfolio pass asks about */
constexpr size_t ADDRESS_MAX = 64;
constexpr size_t LABEL_MAX = 32;
constexpr size_t QUERY_MAX = 48;

struct Entry {
	char address[ADDRESS_MAX + 1];
	char name[LABEL_MAX + 1];
};

struct List {
	Entry entries[CAPACITY];
	size_t count;
};

/* `0x` and forty hex digits: an address that needs no lookup. */
inline bool isEvmAddress(const char *text)
{
	if (text == nullptr || strlen(text) != 42 || text[0] != '0' || (text[1] != 'x' && text[1] != 'X')) {
		return false;
	}
	for (size_t i = 2; i < 42; i++) {
		if (!isxdigit((unsigned char)text[i])) return false;
	}
	return true;
}

/*
 * Whether `text` may be sent to OpenSea's accounts endpoint as a path segment.
 *
 * Letters, digits, `_`, `-` and `.`: enough for any OpenSea username and any ENS name, and nothing
 * that means something in a URL. `..` is refused outright, and so is a leading or trailing dot, so a
 * query can never climb out of `/accounts/`.
 */
inline bool querySane(const char *text)
{
	if (text == nullptr) return false;
	const size_t length = strlen(text);
	if (length < 2 || length > QUERY_MAX) return false;
	if (text[0] == '.' || text[length - 1] == '.' || strstr(text, "..") != nullptr) return false;
	for (size_t i = 0; i < length; i++) {
		const char c = text[i];
		const bool ok = isalnum((unsigned char)c) || c == '_' || c == '-' || c == '.';
		if (!ok) return false;
	}
	return true;
}

/* Leading and trailing spaces off, the way a keypad leaves them. */
inline void trim(const char *in, char *out, size_t n)
{
	if (out == nullptr || n == 0) return;
	out[0] = '\0';
	if (in == nullptr) return;
	while (*in == ' ') in++;
	size_t length = strlen(in);
	while (length > 0 && in[length - 1] == ' ') length--;
	if (length >= n) length = n - 1;
	memcpy(out, in, length);
	out[length] = '\0';
}

inline bool sameAddress(const char *a, const char *b)
{
	for (; *a != '\0' && *b != '\0'; a++, b++) {
		if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
	}
	return *a == *b;
}

enum class AddResult { Added, Duplicate, Full, Invalid };

inline AddResult add(List &list, const char *address, const char *name)
{
	if (address == nullptr || address[0] == '\0' || strlen(address) > ADDRESS_MAX) return AddResult::Invalid;
	for (size_t i = 0; i < list.count; i++) {
		if (sameAddress(list.entries[i].address, address)) return AddResult::Duplicate;
	}
	if (list.count >= CAPACITY) return AddResult::Full;
	Entry &entry = list.entries[list.count++];
	snprintf(entry.address, sizeof(entry.address), "%s", address);
	snprintf(entry.name, sizeof(entry.name), "%s", name == nullptr ? "" : name);
	/* A comma in a name would split it in two on the next read. */
	for (char *c = entry.name; *c != '\0'; c++) {
		if (*c == ',') *c = ' ';
	}
	return AddResult::Added;
}

inline bool removeAt(List &list, size_t index)
{
	if (index >= list.count) return false;
	for (size_t i = index; i + 1 < list.count; i++) list.entries[i] = list.entries[i + 1];
	list.count--;
	memset(&list.entries[list.count], 0, sizeof(Entry));
	return true;
}

/* Field `index` of a comma-separated string, spaces trimmed, into `out`. */
inline void field(const char *text, size_t index, char *out, size_t n)
{
	out[0] = '\0';
	if (text == nullptr) return;
	for (size_t at = 0; at < index; at++) {
		text = strchr(text, ',');
		if (text == nullptr) return;
		text++;
	}
	const char *end = strchr(text, ',');
	char piece[ADDRESS_MAX + LABEL_MAX + 2];
	size_t length = end != nullptr ? (size_t)(end - text) : strlen(text);
	if (length >= sizeof(piece)) length = sizeof(piece) - 1;
	memcpy(piece, text, length);
	piece[length] = '\0';
	trim(piece, out, n);
}

inline size_t fieldCount(const char *text)
{
	if (text == nullptr || text[0] == '\0') return 0;
	size_t count = 1;
	for (; *text != '\0'; text++) {
		if (*text == ',') count++;
	}
	return count;
}

/* Empty fields are skipped, and a list longer than `CAPACITY` keeps its first `CAPACITY`. */
inline void parse(List &list, const char *addresses, const char *names)
{
	memset(&list, 0, sizeof(list));
	const size_t fields = fieldCount(addresses);
	for (size_t i = 0; i < fields && list.count < CAPACITY; i++) {
		char address[ADDRESS_MAX + 1];
		field(addresses, i, address, sizeof(address));
		if (address[0] == '\0') continue;
		char name[LABEL_MAX + 1];
		field(names, i, name, sizeof(name));
		add(list, address, name);
	}
}

inline void serialize(const List &list, char *addresses, size_t addressesSize, char *names,
                      size_t namesSize)
{
	size_t a = 0;
	size_t b = 0;
	addresses[0] = '\0';
	names[0] = '\0';
	for (size_t i = 0; i < list.count; i++) {
		const int wroteA = snprintf(addresses + a, addressesSize - a, "%s%s", i == 0 ? "" : ",",
		                            list.entries[i].address);
		const int wroteB =
		    snprintf(names + b, namesSize - b, "%s%s", i == 0 ? "" : ",", list.entries[i].name);
		if (wroteA < 0 || wroteB < 0 || (size_t)wroteA >= addressesSize - a ||
		    (size_t)wroteB >= namesSize - b) {
			break;
		}
		a += (size_t)wroteA;
		b += (size_t)wroteB;
	}
}

/* "0xfba6…a57f": the start and end people check an address by. */
inline void shortAddress(const char *address, char *out, size_t n)
{
	const size_t length = address == nullptr ? 0 : strlen(address);
	if (length <= 13) {
		snprintf(out, n, "%s", address == nullptr ? "" : address);
		return;
	}
	snprintf(out, n, "%.6s\xE2\x80\xA6%s", address, address + length - 4);
}

}  // namespace pulse_wallets

#endif /* ANCHOR_PULSE_WALLETS_MODEL_H */
