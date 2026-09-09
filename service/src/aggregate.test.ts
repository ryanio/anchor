/**
 * Reading several wallets as one portfolio.
 *
 * The bug these exist for: every wallet-scoped route read `config.wallets[0]` and the widget
 * labelled the answer "3 wallets". A plausible number that is not the number it claims to be.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { combineList, combinePortfolio, fanOut, sumDecimals } from "./aggregate.ts";

const A = `0x${"0".repeat(39)}1`;
const B = `0x${"0".repeat(39)}2`;
const C = `0x${"0".repeat(39)}3`;

const stats = (total: string, nft: string, token: string) => ({
  stats: { totalValueUsd: total, nftValueUsd: nft, tokenValueUsd: token },
});

describe("summing money", () => {
  test("adds decimal strings exactly, where floats would not", () => {
    // The canonical case: 0.1 + 0.2 is 0.30000000000000004 in binary floating point. A portfolio
    // total assembled that way disagrees with the sum of the pages it came from, and "the widget
    // disagrees with OpenSea" is indistinguishable from "the widget is broken".
    assert.equal(sumDecimals(["0.1", "0.2"]), "0.3");
    assert.equal(0.1 + 0.2 === 0.3, false, "the reason this function exists");
  });

  test("keeps the widest precision it was given", () => {
    assert.equal(sumDecimals(["1.005", "2.1", "3"]), "6.105");
    assert.equal(sumDecimals(["1", "2"]), "3");
  });

  test("handles negatives, because a P&L figure can be one", () => {
    assert.equal(sumDecimals(["10.50", "-2.25"]), "8.25");
    assert.equal(sumDecimals(["-1.5", "-2.5"]), "-4.0");
  });

  test("nothing to add is null, not zero", () => {
    // Zero is a claim: it says the portfolio is empty. Null says nobody answered, which is what
    // the panel needs to know to keep showing the last good reading instead of a confident 0.
    assert.equal(sumDecimals([]), null);
    assert.equal(sumDecimals([null, undefined, "not a number"]), null);
    assert.equal(sumDecimals(["0"]), "0");
  });
});

describe("fanning out", () => {
  test("reads every wallet and keeps the order they were configured in", async () => {
    const seen: string[] = [];
    const out = await fanOut([A, B, C], async (w) => {
      seen.push(w);
      return w.slice(-1);
    });
    assert.deepEqual(seen, [A, B, C]);
    assert.deepEqual(
      out.ok.map((r) => r.value),
      ["1", "2", "3"],
    );
    assert.deepEqual(out.incomplete, []);
  });

  test("one wallet failing does not lose the others", async () => {
    const out = await fanOut([A, B, C], async (w) => {
      if (w === B) throw new Error("upstream 503");
      return "ok";
    });
    assert.deepEqual(
      out.ok.map((r) => r.wallet),
      [A, C],
    );
    assert.deepEqual(out.incomplete, [B]);
  });

  test("a fatal error is not a partial answer", async () => {
    // The one this got wrong first time. A rejected credential is about the request, not about an
    // address: swallowed, six auth failures became a 200 with a total of nothing and six wallets
    // listed as "incomplete" — a broken setup rendered as an empty portfolio.
    class Unauthorized extends Error {}
    await assert.rejects(
      () =>
        fanOut(
          [A, B],
          async () => {
            throw new Unauthorized("PAT rejected");
          },
          (err) => err instanceof Unauthorized,
        ),
      Unauthorized,
    );
  });
});

describe("combining a portfolio", () => {
  test("the total is every wallet's total, and each one is still there", () => {
    const combined = combinePortfolio({
      results: [],
      ok: [
        { wallet: A, value: stats("100.10", "60.05", "40.05") },
        { wallet: B, value: stats("200.20", "100.10", "100.10") },
      ],
      incomplete: [],
    });

    assert.equal(combined.stats.totalValueUsd, "300.30");
    assert.equal(combined.stats.nftValueUsd, "160.15");
    assert.equal(combined.stats.tokenValueUsd, "140.15");
    assert.deepEqual(
      combined.wallets.map((w) => [w.address, w.totalValueUsd]),
      [
        [A, "100.10"],
        [B, "200.20"],
      ],
    );
  });

  test("a partial total says which wallets it is missing", () => {
    // Not silently trimmed. A total that quietly drops a wallet is the bug this whole module
    // exists to fix, one layer further down.
    const combined = combinePortfolio({
      results: [],
      ok: [{ wallet: A, value: stats("100", "50", "50") }],
      incomplete: [B],
    });
    assert.equal(combined.stats.totalValueUsd, "100");
    assert.deepEqual(combined.incomplete, [B]);
  });

  test("the single-wallet shape survives, so an older client stays right", () => {
    const combined = combinePortfolio({
      results: [],
      ok: [{ wallet: A, value: stats("42.50", "20", "22.50") }],
      incomplete: [],
    });
    assert.equal(combined.stats.totalValueUsd, "42.50");
  });

  test("field names are read in both spellings the API has used", () => {
    const combined = combinePortfolio({
      results: [],
      ok: [
        { wallet: A, value: { stats: { total_value_usd: "1.50" } } },
        { wallet: B, value: { portfolio: { netWorthUsd: "2.50" } } },
      ],
      incomplete: [],
    });
    assert.equal(combined.stats.totalValueUsd, "4.00");
  });
});

describe("combining a list", () => {
  test("every row says which wallet it came from", () => {
    // The tag is as much the point as the merge. An offer in a list of six wallets' offers is not
    // actionable until you know which of your wallets it is on.
    const merged = combineList(
      {
        results: [],
        ok: [
          { wallet: A, value: { assetEvents: [{ id: 1 }] } },
          { wallet: B, value: { assetEvents: [{ id: 2 }, { id: 3 }] } },
        ],
        incomplete: [C],
      },
      ["assetEvents"],
      "assetEvents",
    );

    assert.deepEqual(merged.assetEvents, [
      { id: 1, anchorWallet: A },
      { id: 2, anchorWallet: B },
      { id: 3, anchorWallet: B },
    ]);
    assert.deepEqual(merged.incomplete, [C]);
  });

  test("a response that is already a list works too", () => {
    const merged = combineList(
      { results: [], ok: [{ wallet: A, value: [{ id: 1 }] }], incomplete: [] },
      ["balances"],
      "balances",
    );
    assert.deepEqual(merged.balances, [{ id: 1, anchorWallet: A }]);
  });
});
