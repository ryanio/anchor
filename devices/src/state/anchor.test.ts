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
import { describeAge, readCollections, readStats, readTokens, TIMEFRAMES } from "./anchor.ts";

describe("readTokens", () => {
  const balances = {
    tokenBalances: [
      { symbol: "USDC", usdValue: "6210.40", status: "OK" },
      { symbol: "ETH", usdValue: "18400.22", status: "OK" },
      { symbol: "SCAMCOIN", usdValue: "999999", status: "SPAM" },
      { symbol: "DUST", usdValue: "0.001", status: "LOW_VALUE" },
      { symbol: "RISKY", usdValue: "5000", status: "WARNING" },
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
    // Anchor's authority behind it. The highest `usdValue` here is the spam entry, deliberately.
    const symbols = readTokens(balances).map((t) => t.symbol);
    for (const excluded of ["SCAMCOIN", "DUST", "RISKY"]) {
      assert.equal(symbols.includes(excluded), false, `${excluded} must not be shown`);
    }
  });

  test("survives junk rather than throwing", () => {
    assert.deepEqual(readTokens(null), []);
    assert.deepEqual(readTokens({}), []);
    assert.deepEqual(readTokens({ tokenBalances: "nope" }), []);
    assert.deepEqual(readTokens({ tokenBalances: [null, 5, {}] }), []);
  });

  test("an unparseable value becomes zero rather than NaN", () => {
    const [only] = readTokens({ tokenBalances: [{ symbol: "X", usdValue: "n/a", status: "OK" }] });
    assert.equal(only?.usdValue, 0);
  });

  test("`balances` is read when the aggregating service wraps them, `tokenBalances` otherwise", () => {
    const wrapped = readTokens({ balances: [{ symbol: "ETH", usdValue: "1", status: "OK" }] });
    const single = readTokens({ tokenBalances: [{ symbol: "ETH", usdValue: "1", status: "OK" }] });
    assert.equal(wrapped[0]?.symbol, "ETH");
    assert.equal(single[0]?.symbol, "ETH");
  });

  test("a missing spam classification is treated as OK, not as spam", () => {
    // Defensive only: the API populates `status` on every balance today (docs/upstream.md entry 0).
    // Filtering everything out because a field went missing would be a worse failure than showing
    // the list unfiltered.
    const [only] = readTokens({ tokenBalances: [{ symbol: "ETH", usdValue: "1" }] });
    assert.equal(only?.symbol, "ETH");
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

/**
 * `readStats` reads the camelCase the API actually sends.
 *
 * `docs/upstream.md` entry 0 used to say this needed both spellings: `@opensea/api-types` declares
 * these fields in snake_case, and a wallet measured through the local service came back camelCase.
 * That was a false alarm — the mismatch was `@opensea/sdk`'s own `camelizeResponse` (default `true`)
 * rewriting the wire response before this module ever saw it, not a disagreement between the spec
 * and the API. What arrives here is always the camelCase view.
 */
describe("readStats", () => {
  test("reads the camelCase the SDK's camelizeResponse produces", () => {
    // Measured from api.opensea.io on 2026-09-08, through the local service.
    const live = {
      totalValueUsd: "1381.84",
      nftValueUsd: "50.89",
      tokenValueUsd: "1330.95",
      pnlAbsolute: "+10.98",
      pnlPercentage: "+0.80",
      timeframe: "DAY",
    };
    const stats = readStats(live);
    assert.equal(stats?.totalUsd, "1381.84");
    assert.equal(stats?.nftUsd, "50.89");
    assert.equal(stats?.pnlPercentage, "+0.80");
  });
});
