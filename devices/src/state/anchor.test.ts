/**
 * Reading portfolio data.
 *
 * The shapes here are the ones in `@opensea/api-types`, not remembered ones. What these tests pin
 * is the interpretation: that spam is filtered before anything is called a "top" holding, that
 * grouping is by count because the spec carries no price on an NFT, and that an absent reading is
 * never rendered as a zero.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeAge, readCollections, readTokens, TIMEFRAMES } from "./anchor.ts";

describe("readTokens", () => {
  const balances = {
    token_balances: [
      { symbol: "USDC", usd_value: "6210.40", status: "OK" },
      { symbol: "ETH", usd_value: "18400.22", status: "OK" },
      { symbol: "SCAMCOIN", usd_value: "999999", status: "SPAM" },
      { symbol: "DUST", usd_value: "0.001", status: "LOW_VALUE" },
      { symbol: "RISKY", usd_value: "5000", status: "WARNING" },
    ],
  };

  test("sorts by USD value, largest first", () => {
    assert.deepEqual(
      readTokens(balances).map((t) => t.symbol),
      ["ETH", "USDC"],
    );
  });

  test("drops everything OpenSea has not classified OK", () => {
    // An unfiltered "top tokens" list on an airdropped-at wallet is a list of scams shown with
    // Anchor's authority behind it. The highest `usd_value` here is the spam entry, deliberately.
    const symbols = readTokens(balances).map((t) => t.symbol);
    for (const excluded of ["SCAMCOIN", "DUST", "RISKY"]) {
      assert.equal(symbols.includes(excluded), false, `${excluded} must not be shown`);
    }
  });

  test("survives junk rather than throwing", () => {
    assert.deepEqual(readTokens(null), []);
    assert.deepEqual(readTokens({}), []);
    assert.deepEqual(readTokens({ token_balances: "nope" }), []);
    assert.deepEqual(readTokens({ token_balances: [null, 5, {}] }), []);
  });

  test("an unparseable value becomes zero rather than NaN", () => {
    const [only] = readTokens({ token_balances: [{ symbol: "X", usd_value: "n/a", status: "OK" }] });
    assert.equal(only?.usdValue, 0);
  });
});

describe("readCollections", () => {
  test("groups holdings by collection, largest first", () => {
    const nfts = {
      nfts: [
        { collection: "azuki" },
        { collection: "pudgypenguins" },
        { collection: "azuki" },
        { collection: "azuki" },
      ],
    };
    assert.deepEqual(readCollections(nfts), [
      { slug: "azuki", count: 3 },
      { slug: "pudgypenguins", count: 1 },
    ]);
  });

  test("ignores entries with no collection", () => {
    assert.deepEqual(readCollections({ nfts: [{ collection: "" }, {}, { collection: "a" }] }), [
      { slug: "a", count: 1 },
    ]);
  });
});

describe("describeAge", () => {
  test("reads as a duration a person can judge freshness by", () => {
    assert.equal(describeAge(12), "12s ago");
    assert.equal(describeAge(240), "4m ago");
    assert.equal(describeAge(7200), "2h ago");
  });
});

describe("TIMEFRAMES", () => {
  test("are exactly what the endpoint accepts", () => {
    // `/portfolio/value` validates against this list in service/src/server.ts; a fifth value here
    // would silently fall back to the API's default rather than erroring.
    assert.deepEqual([...TIMEFRAMES], ["HOUR", "DAY", "WEEK", "MONTH"]);
  });
});
