#include "standalone.h"

#include <stdio.h>
#include <string.h>

namespace {

standalone::Token token(const char *chain, const char *address)
{
	standalone::Token value{};
	snprintf(value.chain, sizeof(value.chain), "%s", chain);
	snprintf(value.address, sizeof(value.address), "%s", address);
	return value;
}

standalone::Detail detail(const char *chain, const char *address)
{
	standalone::Detail value{};
	snprintf(value.chain, sizeof(value.chain), "%s", chain);
	snprintf(value.address, sizeof(value.address), "%s", address);
	return value;
}

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
	const standalone::Token ethereum =
	    token("ethereum", "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
	const standalone::Token ethereumLower =
	    token("ethereum", "0xabcdef0123456789abcdef0123456789abcdef01");
	const standalone::Token base = token("base", ethereum.address);
	const standalone::Token solana = token("solana", "AbCdEf123456789");
	const standalone::Token solanaCaseChanged = token("solana", "abcdef123456789");
	char unterminatedChainA[standalone::CHAIN_MAX];
	char unterminatedChainB[standalone::CHAIN_MAX];
	char unterminatedAddressA[standalone::ADDRESS_MAX];
	char unterminatedAddressB[standalone::ADDRESS_MAX];
	memset(unterminatedChainA, 'e', sizeof(unterminatedChainA));
	memset(unterminatedChainB, 'e', sizeof(unterminatedChainB));
	memset(unterminatedAddressA, 'a', sizeof(unterminatedAddressA));
	memset(unterminatedAddressB, 'a', sizeof(unterminatedAddressB));

	bool ok = true;
	ok &= require(standalone::sameTokenIdentity(ethereum, ethereumLower),
	              "EVM checksum casing should not change identity");
	ok &= require(!standalone::sameTokenIdentity(ethereum, base),
	              "the same address on two chains must be two identities");
	ok &= require(!standalone::sameTokenIdentity(solana, solanaCaseChanged),
	              "Solana address casing must remain significant");
	ok &= require(
	    standalone::detailIsForToken(detail(ethereumLower.chain, ethereumLower.address), ethereum),
	    "detail matching should use the shared EVM identity rule");
	ok &= require(!standalone::detailIsForToken(detail(base.chain, base.address), ethereum),
	              "detail matching must reject an address from another chain");
	ok &= require(
	    !standalone::sameTokenIdentity(nullptr, ethereum.address, ethereum.chain, ethereum.address),
	    "a null chain must not identify a token");
	ok &= require(
	    !standalone::sameTokenIdentity(ethereum.chain, nullptr, ethereum.chain, ethereum.address),
	    "a null address must not identify a token");
	ok &= require(
	    !standalone::sameTokenIdentity("", ethereum.address, ethereum.chain, ethereum.address),
	    "an empty chain must not identify a token");
	ok &= require(
	    !standalone::sameTokenIdentity(ethereum.chain, "", ethereum.chain, ethereum.address),
	    "an empty address must not identify a token");
	ok &= require(!standalone::sameTokenIdentity(unterminatedChainA, ethereum.address,
	                                             unterminatedChainB, ethereum.address),
	              "a chain without a terminator must fail closed");
	ok &= require(!standalone::sameTokenIdentity(ethereum.chain, unterminatedAddressA,
	                                             ethereum.chain, unterminatedAddressB),
	              "an address without a terminator must fail closed");
	return ok ? 0 : 1;
}
