/**
 * Chains as configuration, and the thing that actually differs between them: what an address is.
 *
 * Someone who only cares about Solana tokens must be able to set Anchor up as easily as someone
 * doing EVM NFTs, which means a Solana-only config has to be valid, an EVM address in it has to be
 * refused, and both failures have to say so at load time rather than at the first API call.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addressMatchesChain,
  CHAINS,
  chainArch,
  isEvmAddress,
  isSolanaAddress,
  toSdkChain,
} from "./chains.ts";
import { validate } from "./config.ts";

/** Real, well-known addresses. Public identifiers, not credentials. */
const EVM = "0x1E0049783F008A0085193E00003D00cd54003c71"; // OpenSea's Seaport conduit
const SOL_MINT = "So11111111111111111111111111111111111111112"; // Wrapped SOL
const SOL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL Token program

describe("the chain list comes from the SDK", () => {
  test("solana is a chain like any other", () => {
    assert.ok(CHAINS.includes("solana"));
    assert.equal(chainArch("solana"), "svm");
    assert.equal(chainArch("base"), "evm");
  });

  test("every slug round-trips through the SDK's enum", () => {
    for (const chain of CHAINS) assert.equal(toSdkChain(chain), chain);
  });

  test("the list is not a hand-maintained copy", () => {
    // 29 at the time of writing. The number is not the point — the point is that it came from
    // Object.values(Chain), and chains.ts fails to compile if the SDK and api-types disagree.
    assert.ok(CHAINS.length > 20, `expected the SDK's full chain list, got ${CHAINS.length}`);
    assert.ok(CHAINS.includes("ethereum") && CHAINS.includes("base"));
  });
});

describe("address shape is a property of the chain", () => {
  test("EVM is 0x plus 40 hex", () => {
    assert.ok(isEvmAddress(EVM));
    assert.ok(isEvmAddress(EVM.toLowerCase()), "checksum casing is accepted, not required");
    assert.ok(!isEvmAddress(`${EVM}00`));
    assert.ok(!isEvmAddress(EVM.slice(0, -1)));
    assert.ok(!isEvmAddress(EVM.replace("0x", "")), "the 0x prefix is required");
    assert.ok(!isEvmAddress(SOL_MINT));
  });

  test("Solana is base58 decoding to 32 bytes, never 0x-prefixed", () => {
    assert.ok(isSolanaAddress(SOL_MINT));
    assert.ok(isSolanaAddress(SOL_PROGRAM));
    assert.ok(!isSolanaAddress(EVM), "an EVM address is not a Solana address");
    // 0, O, I and l are not in the base58 alphabet — the ambiguity is the reason base58 exists.
    assert.ok(!isSolanaAddress(SOL_MINT.replace("S", "0")));
    assert.ok(!isSolanaAddress(""));
    assert.ok(!isSolanaAddress("abc"), "valid base58, but three bytes rather than thirty-two");
  });

  test("a chain only accepts its own address shape", () => {
    assert.ok(addressMatchesChain(EVM, "ethereum"));
    assert.ok(!addressMatchesChain(EVM, "solana"));
    assert.ok(addressMatchesChain(SOL_MINT, "solana"));
    assert.ok(!addressMatchesChain(SOL_MINT, "base"));
  });
});

describe("config: chains", () => {
  test("defaults to ethereum", () => {
    assert.deepEqual(validate({}).chains, ["ethereum"]);
  });

  test("accepts a list", () => {
    assert.deepEqual(validate({ chains: ["solana", "base"] }).chains, ["solana", "base"]);
  });

  test("a Solana-only config is valid", () => {
    const config = validate({ chains: ["solana"], wallet: SOL_MINT, tokens: [SOL_PROGRAM] });
    assert.deepEqual(config.chains, ["solana"]);
    assert.equal(config.wallet, SOL_MINT);
  });

  test("the older single `chain` string still works, normalised to one element", () => {
    assert.deepEqual(validate({ chain: "base" }).chains, ["base"]);
  });

  test("setting both `chain` and `chains` is refused rather than silently picking one", () => {
    assert.throws(() => validate({ chain: "base", chains: ["ethereum"] }), /both/);
  });

  test("a typo names the mistake and suggests the real chain", () => {
    assert.throws(
      () => validate({ chains: ["etherium"] }),
      (err: Error) => {
        assert.match(err.message, /"etherium"/);
        assert.match(err.message, /ethereum/);
        return true;
      },
    );
  });

  test("the older `chain` string is validated too, and says the array form exists", () => {
    assert.throws(() => validate({ chain: "solanna" }), /solanna/);
    assert.throws(() => validate({ chains: [] }), /one-element/);
  });

  test("duplicates collapse", () => {
    assert.deepEqual(validate({ chains: ["base", "base"] }).chains, ["base"]);
  });
});

describe("config: addresses are checked against the configured chains", () => {
  test("an EVM wallet on an EVM chain is fine", () => {
    assert.equal(validate({ chains: ["base"], wallet: EVM }).wallet, EVM);
  });

  test("an EVM wallet on a Solana-only config is refused at load", () => {
    assert.throws(
      () => validate({ chains: ["solana"], wallet: EVM }),
      (err: Error) => {
        assert.match(err.message, /`wallet`/);
        assert.match(err.message, /base58/);
        assert.match(err.message, /solana/);
        return true;
      },
    );
  });

  test("a Solana wallet on an EVM-only config is refused at load", () => {
    assert.throws(
      () => validate({ chains: ["ethereum"], wallet: SOL_MINT }),
      (err: Error) => {
        assert.match(err.message, /`wallet`/);
        assert.match(err.message, /40 hex/);
        return true;
      },
    );
  });

  test("with both chains configured, either shape is accepted", () => {
    assert.equal(validate({ chains: ["ethereum", "solana"], wallet: EVM }).wallet, EVM);
    assert.equal(validate({ chains: ["ethereum", "solana"], wallet: SOL_MINT }).wallet, SOL_MINT);
  });

  test("token addresses are checked the same way, and the message names the entry", () => {
    assert.throws(() => validate({ chains: ["solana"], tokens: [SOL_MINT, EVM] }), /tokens\[1\]/);
  });

  test("an unset wallet is not a mismatch", () => {
    assert.equal(validate({ chains: ["solana"] }).wallet, "");
  });
});
