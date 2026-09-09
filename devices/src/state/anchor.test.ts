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

/**
 * The spec and the live API disagree about spelling, so both are pinned.
 *
 * `@opensea/api-types` declares snake_case; `api.opensea.io` answers in camelCase. Reading the
 * generated types is normally what prevents a wrong field name — here the generated types *are* the
 * wrong field name, and only a real response revealed it. Both shapes are tested so that whichever
 * side changes, this keeps working and the test says which spelling arrived.
 */
describe("field spellings", () => {
  test("portfolio stats read from the camelCase the API actually sends", () => {
    // Measured from api.opensea.io on 2026-09-08.
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

  test("portfolio stats still read from the snake_case the spec declares", () => {
    const spec = { total_value_usd: "10", nft_value_usd: "4", token_value_usd: "6", timeframe: "DAY" };
    assert.equal(readStats(spec)?.totalUsd, "10");
    assert.equal(readStats(spec)?.nftUsd, "4");
  });

  test("token balances read from either spelling", () => {
    const live = { tokenBalances: [{ symbol: "ETH", usdValue: "1330.95" }] };
    const spec = { token_balances: [{ symbol: "ETH", usd_value: "1330.95", status: "OK" }] };
    for (const [name, payload] of [
      ["live", live],
      ["spec", spec],
    ] as const) {
      const [only] = readTokens(payload);
      assert.equal(only?.symbol, "ETH", name);
      assert.equal(only?.usdValue, 1330.95, name);
    }
  });

  test("a missing spam classification is treated as OK, not as spam", () => {
    // The live response carries no `status` at all. Filtering everything out because a documented
    // field is absent would be a worse failure than showing the list.
    const [only] = readTokens({ tokenBalances: [{ symbol: "ETH", usdValue: "1" }] });
    assert.equal(only?.symbol, "ETH");
  });

  test("an explicit spam classification is still honoured", () => {
    assert.deepEqual(readTokens({ tokenBalances: [{ symbol: "X", usdValue: "9", status: "SPAM" }] }), []);
  });
});
