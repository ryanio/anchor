/* Checks happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include "../pulse/pulse_wallets_model.h"

#include <cassert>
#include <cstring>

using namespace pulse_wallets;

int main()
{
	const char *main = "0xfBa662e1a8e91a350702cF3b87D0C2d2Fb4BA57F";

	/* An address needs no lookup; a name does, and only one that fits in a URL path segment. */
	assert(isEvmAddress(main));
	assert(!isEvmAddress("0xfBa662e1a8e91a350702cF3b87D0C2d2Fb4BA57")); /* one short */
	assert(!isEvmAddress("0xzBa662e1a8e91a350702cF3b87D0C2d2Fb4BA57F"));
	assert(querySane("ryanryanryanryan"));
	assert(querySane("name.eth"));
	assert(querySane("a_b-c"));
	assert(!querySane("a"));
	assert(!querySane("../account"));
	assert(!querySane("a..b"));
	assert(!querySane(".eth"));
	assert(!querySane("name."));
	assert(!querySane("name/x"));
	assert(!querySane("name?x"));
	assert(!querySane("with space"));

	char trimmed[16];
	trim("  name.eth ", trimmed, sizeof(trimmed));
	assert(strcmp(trimmed, "name.eth") == 0);

	/* Adding refuses a second copy of one address in any case, and stops at CAPACITY. */
	List list{};
	assert(add(list, main, "ryanryanryanryan") == AddResult::Added);
	assert(add(list, "0xfba662e1a8e91a350702cf3b87d0c2d2fb4ba57f", "") == AddResult::Duplicate);
	assert(add(list, "", "") == AddResult::Invalid);
	for (int i = 1; i < (int)CAPACITY; i++) {
		char address[43];
		snprintf(address, sizeof(address), "0x%040d", i);
		assert(add(list, address, "") == AddResult::Added);
	}
	assert(list.count == CAPACITY);
	assert(add(list, "0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3", "") == AddResult::Full);

	/* A name cannot break the comma-separated store. */
	List named{};
	assert(add(named, main, "a,b") == AddResult::Added);
	assert(strcmp(named.entries[0].name, "a b") == 0);

	/* The store round-trips, names staying with their addresses. */
	List two{};
	add(two, main, "ryanryanryanryan");
	add(two, "0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3", "");
	char addresses[1024];
	char names[512];
	serialize(two, addresses, sizeof(addresses), names, sizeof(names));
	assert(strcmp(addresses, "0xfBa662e1a8e91a350702cF3b87D0C2d2Fb4BA57F,"
	                         "0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3") == 0);
	assert(strcmp(names, "ryanryanryanryan,") == 0);
	List back{};
	parse(back, addresses, names);
	assert(back.count == 2);
	assert(strcmp(back.entries[0].name, "ryanryanryanryan") == 0);
	assert(strcmp(back.entries[1].address, "0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3") == 0);
	assert(back.entries[1].name[0] == '\0');

	/* Empty fields are skipped, a missing names string is no names, and nothing is no wallets. */
	parse(back, " ,0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3,, ", nullptr);
	assert(back.count == 1);
	parse(back, "", "");
	assert(back.count == 0);

	/* Removing closes the gap and keeps the order. */
	assert(removeAt(two, 0));
	assert(two.count == 1);
	assert(strcmp(two.entries[0].address, "0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3") == 0);
	assert(!removeAt(two, 1));

	char shortened[24];
	shortAddress(main, shortened, sizeof(shortened));
	assert(strcmp(shortened, "0xfBa6\xE2\x80\xA6"
	                         "A57F") == 0);
	return 0;
}
