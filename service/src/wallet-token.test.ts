/**
 * Deriving a wallet from the PAT.
 *
 * The tokens here are synthetic — a JWT signature is never checked by this path, and AGENTS.md says
 * to mock a credential rather than use a real one. Each case is a way the derivation must decline
 * rather than guess, because the cost of guessing is a portfolio for the wrong address.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChainIdentifier } from "@opensea/api-types";
import { describeTokenShape, resolveWallets, walletFromToken } from "./wallet-token.ts";

/** Public identifiers, not credentials: OpenSea's Seaport conduit and Wrapped SOL. */
const EVM = "0x1E0049783F008A0085193E00003D00cd54003c71";
const SOL = "So11111111111111111111111111111111111111112";

const ETHEREUM: ChainIdentifier[] = ["ethereum"];
const SOLANA: ChainIdentifier[] = ["solana"];

/** Build an unsigned JWT. Nothing in this path verifies a signature, so the segment is a placeholder. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.signature-not-checked`;
}

describe("walletFromToken", () => {
  test("reads the top-level wallet claim", () => {
    assert.equal(walletFromToken(jwt({ wallet: EVM }), ETHEREUM).address, EVM);
  });

  test("declines an absent token", () => {
    assert.deepEqual(walletFromToken(null, ETHEREUM), { address: null, detail: "no token stored" });
    assert.equal(walletFromToken("   ", ETHEREUM).address, null);
  });

  test("declines an opaque token without throwing", () => {
    // A PAT is not required to be a JWT. That is not an error, it just carries nothing.
    const result = walletFromToken("not-a-jwt-at-all", ETHEREUM);
    assert.equal(result.address, null);
    assert.match(result.detail, /not a JWT/);
  });

  test("declines a JWT with no wallet claim", () => {
    const result = walletFromToken(jwt({ scope: "read" }), ETHEREUM);
    assert.equal(result.address, null);
    assert.match(result.detail, /no wallet claim/);
  });

  test("never falls back to `sub`", () => {
    // The SDK is explicit that `sub` is an account identifier, not a wallet address. A fallback
    // here would produce a confident, wrong address that looks exactly like a right one.
    const result = walletFromToken(jwt({ sub: EVM }), ETHEREUM);
    assert.equal(result.address, null, "sub must never be read as a wallet");
  });

  test("declines a wallet that does not match the configured chains", () => {
    const result = walletFromToken(jwt({ wallet: EVM }), SOLANA);
    assert.equal(result.address, null);
    assert.match(result.detail, /does not match configured chains/);
    assert.match(result.detail, /solana/);
  });

  test("accepts a Solana wallet on a Solana config", () => {
    assert.equal(walletFromToken(jwt({ wallet: SOL }), SOLANA).address, SOL);
  });

  test("no failure detail ever contains the token", () => {
    // The detail is displayed on /health. A credential must not ride out on a diagnostic.
    const token = jwt({ scope: "read", secretish: "do-not-leak" });
    for (const chains of [ETHEREUM, SOLANA]) {
      const { detail } = walletFromToken(token, chains);
      assert.equal(detail.includes(token), false);
      assert.equal(detail.includes("do-not-leak"), false);
    }
  });
});

describe("resolveWallets", () => {
  test("config wins over the token", () => {
    // Someone who wrote an address down means it; a derived one is for the empty case only.
    const other = "0x0000000000000000000000000000000000000001";
    const resolved = resolveWallets([other], jwt({ wallet: EVM }), ETHEREUM);
    assert.deepEqual(resolved.wallets, [other]);
    assert.equal(resolved.source, "config");
  });

  test("falls back to the token when config names none", () => {
    const resolved = resolveWallets([], jwt({ wallet: EVM }), ETHEREUM);
    assert.deepEqual(resolved.wallets, [EVM]);
    assert.equal(resolved.source, "token");
  });

  test("an empty-string wallet counts as unset", () => {
    // `config.json` ships `"wallet": ""`, which is how a fresh install looks.
    const resolved = resolveWallets([""], jwt({ wallet: EVM }), ETHEREUM);
    assert.equal(resolved.source, "token");
  });

  test("reports none, with a reason, when neither supplies one", () => {
    const resolved = resolveWallets([], null, ETHEREUM);
    assert.deepEqual(resolved.wallets, []);
    assert.equal(resolved.source, "none");
    assert.match(resolved.detail, /no token stored/);
  });

  test("keeps every configured wallet, not just the first", () => {
    const second = "0x0000000000000000000000000000000000000002";
    const resolved = resolveWallets([EVM, second], null, ETHEREUM);
    assert.deepEqual(resolved.wallets, [EVM, second]);
  });
});

describe("describeTokenShape", () => {
  test("names a JWT carrying a wallet claim", () => {
    const shape = describeTokenShape(jwt({ wallet: EVM }));
    assert.equal(shape.kind, "jwt");
    assert.equal(shape.hasWalletClaim, true);
    assert.match(shape.summary, /wallet claim present/);
  });

  test("names a JWT with no wallet claim, and says why that matters", () => {
    const shape = describeTokenShape(jwt({ scope: "read" }));
    assert.equal(shape.kind, "jwt");
    assert.equal(shape.hasWalletClaim, false);
    assert.match(shape.summary, /no wallet claim/);
  });

  test("names an opaque token and says a JWT has three segments", () => {
    const shape = describeTokenShape("abc123opaquetoken");
    assert.equal(shape.kind, "opaque");
    assert.equal(shape.segments, 1);
    assert.match(shape.summary, /a JWT has 3/);
  });

  test("flags a value that is not credential-shaped", () => {
    // The documented incident: an interactive prompt stored its own command line, and `/health`
    // then reported the credential present. This is the line that would have caught it.
    const shape = describeTokenShape("anchor-service --set-pat < /dev/null");
    assert.equal(shape.kind, "not-credential-shaped");
    assert.match(shape.summary, /shell command/);
  });

  test("reports an expired JWT as expired", () => {
    const shape = describeTokenShape(jwt({ wallet: EVM, exp: 1000 }));
    assert.match(shape.summary, /EXPIRED/);
  });

  test("the summary never contains the token", () => {
    // This line is printed to a terminal, so it is the one place a credential could walk out.
    for (const token of [
      jwt({ wallet: EVM, secretish: "do-not-leak" }),
      "opaque-do-not-leak-token",
      "not credential shaped do-not-leak",
    ]) {
      const { summary } = describeTokenShape(token);
      assert.equal(summary.includes(token), false, "summary must not embed the token");
      assert.equal(summary.includes("do-not-leak"), false, "summary must not embed token content");
    }
  });
});
