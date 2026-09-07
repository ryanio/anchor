/**
 * Chains as a first-class concept.
 *
 * Anchor is not an Ethereum wallet that also knows about other chains — someone who only cares
 * about Solana tokens should be able to configure it as easily as someone doing EVM NFTs. That
 * means the chain list, the address rules, and the failure messages all have to be chain-aware.
 *
 * The list of chains is **not** maintained here. `Chain` is the SDK's enum and `ChainIdentifier`
 * is the union generated from OpenSea's OpenAPI spec; `ChainsAgree` below is a compile-time proof
 * that the two still describe the same set, so a chain added upstream shows up as a typecheck
 * failure rather than as a slug we silently reject.
 *
 * See docs/chains.md for what actually differs between chains, and what does not.
 */

import type { ChainIdentifier } from "@opensea/api-types";
import { Chain } from "@opensea/sdk";

/**
 * `readonly ChainIdentifier[]` when the SDK enum and the api-types union agree in both
 * directions, and `never` otherwise — which makes the assignment below fail to compile.
 *
 * This is the whole reason we can build the chain list from `Object.values(Chain)` instead of
 * hand-maintaining a copy that would rot the first time OpenSea ships a new chain.
 */
type ChainsAgree = `${Chain}` extends ChainIdentifier
  ? ChainIdentifier extends `${Chain}`
    ? readonly ChainIdentifier[]
    : never
  : never;

/** Every chain slug the OpenSea API accepts, straight from the SDK. 29 at the time of writing. */
export const CHAINS: ChainsAgree = Object.values(Chain);

/**
 * The api-types union and the SDK enum are the same strings, but TypeScript treats a string enum
 * as nominal, so a `ChainIdentifier` is not directly assignable to a `Chain`. A lookup keeps the
 * conversion honest rather than casting.
 */
const SDK_CHAIN: ReadonlyMap<ChainIdentifier, Chain> = new Map(
  Object.values(Chain).map((chain) => [chain, chain] as const),
);

export function isChainIdentifier(value: unknown): value is ChainIdentifier {
  return typeof value === "string" && SDK_CHAIN.has(value as ChainIdentifier);
}

/** Convert a validated slug to the enum the SDK's path-scoped methods expect. */
export function toSdkChain(chain: ChainIdentifier): Chain {
  const sdk = SDK_CHAIN.get(chain);
  if (sdk === undefined) throw new Error(`Unknown chain: ${JSON.stringify(chain)}`);
  return sdk;
}

/**
 * Address architecture. Solana is the only non-EVM chain OpenSea currently exposes, but the shape
 * of this function is the point: the question "is this address valid" has no chain-free answer.
 */
export type ChainArch = "evm" | "svm";

export function chainArch(chain: ChainIdentifier): ChainArch {
  return chain === "solana" ? "svm" : "evm";
}

/** EVM: 0x followed by 40 hex characters. Checksum casing is accepted but not required. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode base58 to bytes, or null if the string is not base58 at all.
 *
 * A length check on the string is not enough: base58 is not a fixed-width encoding, so a 32-byte
 * key is 32–44 characters and a 44-character string can decode to 33 bytes. Decoding is the only
 * way to tell, and it is twenty lines.
 */
function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

/** Solana: base58, decoding to exactly 32 bytes, and never 0x-prefixed. */
export function isSolanaAddress(value: string): boolean {
  return decodeBase58(value)?.length === 32;
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

/** True when `address` could belong to `chain`. */
export function addressMatchesChain(address: string, chain: ChainIdentifier): boolean {
  return chainArch(chain) === "svm" ? isSolanaAddress(address) : isEvmAddress(address);
}

/**
 * Reject an address that cannot belong to any configured chain.
 *
 * This runs at config load rather than at the first API call on purpose. A Solana address in an
 * EVM-only config is a typo, and finding out at startup is the difference between "fix your
 * config" and a 400 from OpenSea three widgets deep, hours later, cached as an error card.
 */
export function assertAddressForChains(
  address: string,
  chains: readonly ChainIdentifier[],
  field: string,
): void {
  if (address === "") return; // unset is not a mismatch; the server reports it as 428
  if (chains.some((chain) => addressMatchesChain(address, chain))) return;

  const shapes = [...new Set(chains.map(chainArch))].map((arch) =>
    arch === "svm" ? "base58, 32 bytes, no 0x prefix (solana)" : "0x followed by 40 hex characters (evm)",
  );
  throw new Error(
    `config: \`${field}\` is not a valid address for any configured chain (${chains.join(", ")}). ` +
      `Expected ${shapes.join(" or ")}.`,
  );
}
