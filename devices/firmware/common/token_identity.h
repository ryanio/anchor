#pragma once

#include <stddef.h>

namespace anchor_identity {

constexpr size_t ADDRESS_MAX = 48;
constexpr size_t CHAIN_MAX = 16;

namespace identity {

inline char lowerAscii(char value)
{
	return value >= 'A' && value <= 'Z' ? (char)(value + ('a' - 'A')) : value;
}

inline bool sameBounded(const char *a, const char *b, size_t limit, bool ignoreCase)
{
	if (a == nullptr || b == nullptr || a[0] == '\0' || b[0] == '\0') {
		return false;
	}
	for (size_t i = 0; i < limit; i++) {
		const char left = ignoreCase ? lowerAscii(a[i]) : a[i];
		const char right = ignoreCase ? lowerAscii(b[i]) : b[i];
		if (left != right) {
			return false;
		}
		if (left == '\0') {
			return true;
		}
	}
	return false;
}

inline bool evmAddress(const char *address)
{
	return address != nullptr && address[0] == '0' && (address[1] == 'x' || address[1] == 'X');
}

}  // namespace identity

// EVM addresses are case insensitive because checksummed and lower-case responses name the same
// account. Other address families are case sensitive. Solana base58 in particular assigns
// different values to upper- and lower-case letters.
inline bool sameAddress(const char *a, const char *b)
{
	return identity::sameBounded(a, b, ADDRESS_MAX,
	                             identity::evmAddress(a) && identity::evmAddress(b));
}

// An address is unique only inside its chain. Chain identifiers arrive canonical and lower case,
// so compare them exactly and fail closed if either string is empty or unterminated.
inline bool sameTokenIdentity(const char *chainA, const char *addressA, const char *chainB,
                              const char *addressB)
{
	return identity::sameBounded(chainA, chainB, CHAIN_MAX, false) &&
	       sameAddress(addressA, addressB);
}

}  // namespace anchor_identity
