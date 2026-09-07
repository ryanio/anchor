/**
 * The address model, tested as the guarantee it exists to provide.
 *
 * Before chains were first class, `Address` was a lowercased hex string and allowlist membership was
 * string equality. That is exactly right on one chain and wrong on two, in two different ways:
 *
 *   - **Lowercasing.** Safe for EVM hex, where casing is an EIP-55 checksum. A correctness bug for
 *     base58, where `A` and `a` are different digits naming different accounts.
 *   - **Bare comparison.** The same 20 hex bytes are a different contract on every EVM chain, so an
 *     allowlist entry that carries no chain vouches for addresses nobody approved.
 *
 * These tests are the regression suite for both.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  address,
  allowlistHas,
  archOf,
  chainAddress,
  chainArch,
  chainSlug,
  describeMalformation,
  evmAddress,
  formatChainAddress,
  isEvmAddress,
  isSolanaAddress,
  sameChainAddress,
  solanaAddress,
  subjectContract,
  tryAddress,
  tryChainAddress,
  tryEvmAddress,
  trySolanaAddress,
} from "./types.ts";

const EVM = evmAddress("0xC011ec0000000000000000000000000000000000");
const SOL = solanaAddress("7ZLB8aQLp4PpY25QLqUc49fLA2TqyauvYQqdmST5ciMg");

describe("EVM addresses normalise; Solana addresses must not", () => {
  test("EVM hex is lowercased, so checksum casing is not a second identity", () => {
    const mixed = evmAddress("0xC011EC0000000000000000000000000000000000");
    const lower = evmAddress("0xc011ec0000000000000000000000000000000000");
    assert.equal(mixed, lower);
    assert.equal(allowlistHas([chainAddress("ethereum", mixed)], chainAddress("ethereum", lower)), true);
  });

  test("a Solana address is preserved verbatim — base58 case is part of the value", () => {
    // The bug this prevents: `.toLowerCase()` applied for symmetry with the EVM path. Base58's
    // alphabet contains both cases and they are different digits, so a lowercased Solana address is
    // a different key or no key at all, and an allowlist of them silently matches nothing.
    assert.equal(solanaAddress(SOL), SOL);
    assert.notEqual(SOL, SOL.toLowerCase());
    assert.equal(trySolanaAddress(SOL.toLowerCase()), null, "the lowercased form is not even valid");
  });

  test("a lowercased Solana address never reaches an allowlist comparison at all", () => {
    // Two layers, and the outer one is the useful part. If something *did* lowercase a Solana
    // address on the way in, it would not parse — so the failure is a refusal at the boundary
    // rather than an allowlist that quietly matches nothing for the rest of the wallet's life.
    const entry = chainAddress("solana", SOL);
    assert.equal(tryChainAddress("solana", SOL.toLowerCase()), null);
    assert.equal(allowlistHas([entry], entry), true);
  });
});

describe("the two address spaces are disjoint, so parsing needs no guess", () => {
  test("an EVM address is never valid base58", () => {
    // Not luck: base58's alphabet omits `0`, so `0x…` cannot be base58 at all.
    assert.equal(trySolanaAddress(EVM), null);
    assert.equal(archOf(address(EVM)), "evm");
  });

  test("a Solana address is never valid EVM hex", () => {
    assert.equal(tryEvmAddress(SOL), null);
    assert.equal(archOf(address(SOL)), "svm");
  });

  test("length alone would not do: a 44-character base58 string can decode to 33 bytes", () => {
    // Which is why the parser decodes rather than pattern-matching a length range.
    const tooLong = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    assert.equal(tooLong.length, 44);
    assert.equal(trySolanaAddress(tooLong), null);
  });

  test("anything that is neither is a refusal, never a coercion", () => {
    for (const junk of ["", "0x", "0xdead", "not-an-address", "0OIl", `0x${"g".repeat(40)}`]) {
      assert.equal(tryAddress(junk), null, junk);
    }
    assert.throws(() => address("boondoggle"), TypeError);
  });

  test("the narrowing predicates agree with the parser", () => {
    assert.equal(isEvmAddress(EVM), true);
    assert.equal(isSolanaAddress(EVM), false);
    assert.equal(isSolanaAddress(SOL), true);
    assert.equal(isEvmAddress(SOL), false);
  });

  test("a long base58 string is refused on length before it is decoded", () => {
    // The decoder is O(n²) — every digit multiplies the accumulated byte array — and it parses
    // strings from places nobody here controls: an agent's request field, a policy document
    // fetched from Privy. Unbounded, a few hundred KB of `z` costs minutes of a single-threaded
    // process, which stalls `revoke()` along with everything else. So the bound is a refusal
    // rather than a slow `null`, and this asserts the cost, not just the answer.
    const enormous = "z".repeat(50_000);
    const started = process.hrtime.bigint();
    assert.equal(trySolanaAddress(enormous), null);
    assert.equal(tryAddress(enormous), null);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 250, `refusing a ${enormous.length}-character string took ${elapsedMs}ms`);
  });

  test("the bound is well clear of every address it must still accept", () => {
    // A 32-byte key is 32–44 base58 characters. The bound is 64, so nothing legitimate is near it —
    // a bound that clipped real addresses would be a refusal that looks like a typo.
    assert.notEqual(trySolanaAddress(SOL), null);
    assert.notEqual(trySolanaAddress("1".repeat(32)), null); // the all-zero key, the shortest there is
    assert.equal(trySolanaAddress("1".repeat(65)), null);
  });
});

describe("an allowlist entry is a (chain, address) pair", () => {
  test("the same address on two EVM chains is two different entries", () => {
    // The case a bare-string allowlist got wrong. `CREATE2` puts an attacker's code at a chosen
    // address on a chain the user never configured, so "0xfoo is allowed" is not a sentence that
    // means anything on its own.
    const onEthereum = chainAddress("ethereum", EVM);
    const onBase = chainAddress("base", EVM);
    assert.equal(sameChainAddress(onEthereum, onBase), false);
    assert.equal(allowlistHas([onEthereum], onBase), false);
    assert.equal(allowlistHas([onEthereum], onEthereum), true);
  });

  test("an EVM entry never matches a Solana candidate, or the reverse", () => {
    assert.equal(allowlistHas([chainAddress("ethereum", EVM)], chainAddress("solana", SOL)), false);
    assert.equal(allowlistHas([chainAddress("solana", SOL)], chainAddress("ethereum", EVM)), false);
  });

  test("a mismatched pair cannot be constructed at all", () => {
    // The strongest form of the guarantee: there is no inconsistent pair to compare, because the
    // constructor refuses to make one.
    assert.throws(() => chainAddress("solana", EVM), /is evm/);
    assert.throws(() => chainAddress("ethereum", SOL), /is svm/);
    assert.equal(tryChainAddress("solana", EVM), null);
  });

  test("a chain slug is normalised, so casing cannot split one chain into two", () => {
    assert.equal(chainSlug("Solana"), "solana");
    assert.equal(sameChainAddress(chainAddress("Ethereum", EVM), chainAddress("ethereum", EVM)), true);
    assert.throws(() => chainSlug("ether eum"), TypeError);
    assert.throws(() => chainSlug(""), TypeError);
  });

  test("chain architecture: solana is svm, everything else on OpenSea's list is evm", () => {
    assert.equal(chainArch("solana"), "svm");
    for (const chain of ["ethereum", "base", "arbitrum", "bera_chain"]) {
      assert.equal(chainArch(chain), "evm", chain);
    }
  });

  test("a formatted pair always names its chain, so a log line is unambiguous", () => {
    assert.equal(formatChainAddress(chainAddress("solana", SOL)), `solana:${SOL}`);
    assert.match(formatChainAddress(chainAddress("base", EVM)), /^base:0x/);
  });
});

describe("a request whose addresses contradict its chain is malformed", () => {
  const envelope = { id: "r1", requestedAt: 0, tokenId: "1", listingId: "l1" } as const;

  test("a well-formed request has nothing to report", () => {
    assert.equal(
      describeMalformation({
        ...envelope,
        kind: "cancel-own-listing",
        chain: "ethereum",
        account: EVM,
        contract: EVM,
        marketplace: EVM,
      }),
      null,
    );
  });

  test("a Solana address on an EVM chain names the offending field", () => {
    const reason = describeMalformation({
      ...envelope,
      kind: "cancel-own-listing",
      chain: "ethereum",
      account: EVM,
      contract: SOL,
      marketplace: EVM,
    });
    assert.match(reason ?? "", /contract is a svm address/);
  });

  test("an EVM address on Solana is caught too, and so is a nonsense chain", () => {
    assert.match(
      describeMalformation({
        ...envelope,
        kind: "cancel-own-listing",
        chain: "solana",
        account: SOL,
        contract: SOL,
        marketplace: EVM,
      }) ?? "",
      /marketplace is a evm address/,
    );
    assert.match(
      describeMalformation({
        ...envelope,
        kind: "cancel-own-listing",
        chain: "NOT A CHAIN",
        account: EVM,
        contract: EVM,
        marketplace: EVM,
      }) ?? "",
      /is not a chain slug/,
    );
  });

  test("subjectContract returns the pair an allowlist is compared against", () => {
    const subject = subjectContract({
      ...envelope,
      kind: "cancel-own-listing",
      chain: "solana",
      account: SOL,
      contract: SOL,
      marketplace: SOL,
    });
    assert.deepEqual(subject, { chain: "solana", address: SOL });
  });
});
