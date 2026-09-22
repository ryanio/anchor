#include "standalone.h"

#include <stdio.h>
#include <string.h>

namespace {

bool require(bool condition, const char *message)
{
	if (!condition) {
		fprintf(stderr, "%s\n", message);
	}
	return condition;
}

}  // namespace

int main()
{
	bool ok = true;
	char chain[standalone::CHAIN_MAX]{};
	char address[standalone::ADDRESS_MAX]{};
	char fullChain[standalone::CHAIN_MAX + 1];
	char fullAddress[standalone::ADDRESS_MAX + 1];
	memset(fullChain, 'c', sizeof(fullChain) - 1);
	fullChain[sizeof(fullChain) - 1] = '\0';
	memset(fullAddress, 'a', sizeof(fullAddress) - 1);
	fullAddress[sizeof(fullAddress) - 1] = '\0';

	ok &= require(standalone::copyTokenIdentity(chain, sizeof(chain), "ethereum"),
	              "a bounded chain should copy");
	ok &= require(strcmp(chain, "ethereum") == 0, "the chain should copy without mutation");
	ok &= require(standalone::copyTokenIdentity(address, sizeof(address), "0xAbC123"),
	              "a bounded address should copy");
	ok &= require(strcmp(address, "0xAbC123") == 0,
	              "address case should survive the identity copy");
	ok &= require(!standalone::copyTokenIdentity(chain, sizeof(chain), fullChain),
	              "an overlong chain should be rejected");
	ok &= require(chain[0] == '\0', "a rejected chain should leave no truncated identity");
	ok &= require(!standalone::copyTokenIdentity(address, sizeof(address), fullAddress),
	              "an overlong address should be rejected");
	ok &= require(address[0] == '\0', "a rejected address should leave no truncated identity");
	ok &= require(!standalone::copyTokenIdentity(address, sizeof(address), "abc\ndef"),
	              "a control-containing address should be rejected");
	ok &= require(address[0] == '\0', "a rejected address should not retain an earlier value");
	ok &= require(!standalone::copyTokenIdentity(address, sizeof(address), ""),
	              "an empty address should be rejected");

	return ok ? 0 : 1;
}
