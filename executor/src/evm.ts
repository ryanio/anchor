/**
 * The smallest amount of ABI encoding this workspace needs, hand-rolled.
 *
 * `viem` and `ethers` both do this well, and neither is worth a runtime dependency for two function
 * selectors (AGENTS.md: the repo is dependency-free on purpose). Everything here is fixed-width
 * static encoding — no dynamic types, no arrays, no tuples — which is exactly the subset that can be
 * written by hand without a decoder to check it.
 */
import type { EvmAddress } from "./types.ts";

/** Left-pad a hex quantity to a 32-byte ABI word. Throws rather than truncating. */
export function word(value: bigint): string {
  if (value < 0n) throw new RangeError("ABI words are unsigned here");
  const hex = value.toString(16);
  if (hex.length > 64) throw new RangeError("value does not fit in a 32-byte word");
  return hex.padStart(64, "0");
}

/** An address as an ABI word. */
export function addressWord(value: EvmAddress): string {
  return word(BigInt(value));
}

/**
 * `safeTransferFrom(address,address,uint256)` — selector `0x42842e0e`.
 *
 * The three-argument overload, not the four-argument one with `bytes data`: the extra parameter is
 * dynamically encoded, and a hand-rolled encoder has no business emitting a dynamic offset. ERC-721
 * requires both overloads, so the simpler one is always available.
 *
 * `safeTransferFrom` rather than `transferFrom` deliberately — the safe variant reverts when the
 * destination is a contract that cannot receive tokens, which turns "sent to a black hole" into a
 * failed transaction. A withdrawal allowlist protects against the wrong address; this protects
 * against the right address being unable to hold the asset.
 */
export const SAFE_TRANSFER_FROM_SELECTOR = "0x42842e0e";

export function encodeSafeTransferFrom(from: EvmAddress, to: EvmAddress, tokenId: bigint): string {
  return SAFE_TRANSFER_FROM_SELECTOR + addressWord(from) + addressWord(to) + word(tokenId);
}

/**
 * `setApprovalForAll(address,bool)` — selector `0xa22cb465`.
 *
 * Exported so it can be *recognised*, never so it can be sent. `containsSetApprovalForAll` uses it
 * to refuse calldata, and the Privy policy audit uses it to check that the remote policy does not
 * allowlist it. There is no encoder for it in this file, on purpose (AGENTS.md invariant 3).
 */
export const SET_APPROVAL_FOR_ALL_SELECTOR = "0xa22cb465";

/** The leading four bytes of calldata, lowercased, or `null` when there aren't four bytes. */
export function selectorOf(data: string | undefined): string | null {
  if (data === undefined) return null;
  const hex = data.startsWith("0x") ? data : `0x${data}`;
  if (hex.length < 10) return null;
  return hex.slice(0, 10).toLowerCase();
}

/** True when this calldata is a blanket operator approval, whatever else it claims to be. */
export function containsSetApprovalForAll(data: string | undefined): boolean {
  return selectorOf(data) === SET_APPROVAL_FOR_ALL_SELECTOR;
}

/**
 * Parse a token id that arrived as a decimal string.
 *
 * `tokenId` is a string on {@link import("./types.ts").ActionRequest} because token ids are 256-bit
 * and JSON has no such number. It reaches here from a marketplace API, so it is untrusted: anything
 * that is not a plain decimal in range is a refusal, never a coercion.
 */
export function tokenIdToBigInt(tokenId: string): bigint {
  if (!/^[0-9]{1,78}$/.test(tokenId)) {
    throw new TypeError(`token id is not a decimal integer: ${JSON.stringify(tokenId)}`);
  }
  const value = BigInt(tokenId);
  if (value >= 1n << 256n) throw new RangeError("token id does not fit in uint256");
  return value;
}

/** CAIP-2 chain identifier for an EVM chain, e.g. `eip155:1`. */
export function caip2(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new RangeError(`not an EVM chain id: ${chainId}`);
  }
  return `eip155:${chainId}`;
}
