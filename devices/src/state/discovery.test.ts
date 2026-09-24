/**
 * Every fixture below is a real `data` payload, not a guess — captured from the live service on
 * 2026-09-13, the same way `state/anchor.test.ts` holds every portfolio field to that standard.
 * Pure parsers only: nothing here touches the network, the same discipline `readStats`/`readTokens`
 * are already held to.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  readCollectionHolders,
  readTokenActivity,
  readTokenHolders,
  readTrendingCollections,
  readTrendingTokens,
} from "./discovery.ts";

describe("readTrendingTokens", () => {
  const data = {
    tokens: [
      {
        address: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
        chain: "solana",
        name: "STONK",
        symbol: "STONK",
        imageUrl: "https://i2c.seadn.io/solana/.../d8b01ceda30ad330f164a4cb84e90d7d.png",
        usdPrice: "0.24363121651577396",
        decimals: 9,
        openseaUrl: "https://opensea.io/token/solana/6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
        marketCapUsd: 243631213.93031165,
        volume24h: 26444366.05314564,
        priceChange24h: -0.045847499788359974,
        holdersCount: null,
        isVerified: false,
      },
    ],
  };

  test("parses the usdPrice string into a number", () => {
    const [only] = readTrendingTokens(data);
    assert.equal(only?.symbol, "STONK");
    assert.equal(only?.chain, "solana");
    assert.equal(only?.usdPrice, 0.24363121651577396);
    assert.equal(only?.marketCapUsd, 243631213.93031165);
  });

  test("drops a row with no address or chain rather than guessing one", () => {
    assert.deepEqual(readTrendingTokens({ tokens: [{ name: "no address" }] }), []);
  });

  test("survives junk rather than throwing", () => {
    assert.deepEqual(readTrendingTokens(null), []);
    assert.deepEqual(readTrendingTokens({}), []);
    assert.deepEqual(readTrendingTokens({ tokens: "nope" }), []);
  });
});

describe("readTokenHolders", () => {
  const data = {
    holders: [
      {
        quantity: "37356061.20810475",
        percentageHeld: 3.7356062,
        usdValue: "9097779.92927076",
        ownerAddress: "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit",
        ownerDisplayName: null,
      },
    ],
    totalCount: 79243,
    distribution: {
      totalHolders: 79243,
      topOnePercentConcentration: 82.180466,
      healthScore: 18,
      healthLabel: "BAD",
    },
    next: "WzE4MDcwNDQyMzAwMzQyMDQxLCJGNWhrWXNpOEp4anlBMkpITjVDQTdNYm5uaFd1YmtYQjJaUUI3R2theHFzNiJd",
  };

  test("reads the concentration/health fields alongside the ranked list", () => {
    const result = readTokenHolders(data);
    assert.equal(result.holders[0]?.ownerAddress, "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit");
    assert.equal(result.holders[0]?.usdValue, 9097779.92927076);
    assert.equal(result.totalCount, 79243);
    assert.equal(result.healthLabel, "BAD");
    assert.equal(result.healthScore, 18);
  });

  test("an absent distribution is nulls, not a throw", () => {
    const result = readTokenHolders({ holders: [] });
    assert.equal(result.healthScore, null);
    assert.equal(result.healthLabel, null);
  });
});

describe("readTokenActivity", () => {
  const data = {
    swapEvents: [
      {
        id: "01a09c82-5008-7a33-ae6a-84c65cae3ed2",
        timestamp: 1789332181,
        senderAddress: "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG",
        fromToken: {
          address: "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR",
          chain: "solana",
          amountToken: 1440.794693562,
          amountUsd: "139.63929875052474",
          amountNative: 1.378881196312084,
        },
        toToken: {
          address: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
          chain: "solana",
          amountToken: 572.228670938,
          amountUsd: "139.63929875052474",
          amountNative: 1.378881196312084,
        },
        transactionHash:
          "47baFVTSs3sYfnn1Rg6KK6E2rs4FqKXZk7evDPMt5vw5YFbHDFph2BZMf4ebNjSypdiGwFLwfKrBHag7TqJSNGZw",
        swapProtocol: "Meteora",
        chain: "solana",
      },
    ],
  };

  test("falls back to the address when a swap side carries no symbol", () => {
    const [only] = readTokenActivity(data);
    assert.equal(only?.fromSymbolOrAddress, "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR");
    assert.equal(only?.amountUsd, 139.63929875052474);
    assert.equal(only?.senderAddress, "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG");
  });

  test("a swap with no sender is dropped, not shown with a blank identity", () => {
    assert.deepEqual(readTokenActivity({ swapEvents: [{ fromToken: {} }] }), []);
  });
});

describe("readTrendingCollections", () => {
  test("reads `collection` as the slug, matching state/anchor.ts's own field for it", () => {
    const [only] = readTrendingCollections({
      collections: [
        {
          collection: "courtyard-nft",
          name: "Courtyard.io",
          imageUrl: "https://i2c.seadn.io/polygon/.../3ea70379eaf770c85beae83b89c7a632.png",
          openseaUrl: "https://opensea.io/collection/courtyard-nft",
        },
      ],
    });
    assert.equal(only?.slug, "courtyard-nft");
    assert.equal(only?.name, "Courtyard.io");
  });
});

describe("readCollectionHolders", () => {
  test("reads a plain-number quantity and percentage, unlike a token holder's string money", () => {
    const [only] = readCollectionHolders({
      holders: [
        { address: "0x732134d7f99b90c704d736b360db45425073380f", quantity: 20286, percentage: 0.0491 },
      ],
    });
    assert.equal(only?.address, "0x732134d7f99b90c704d736b360db45425073380f");
    assert.equal(only?.quantity, 20286);
    assert.equal(only?.percentage, 0.0491);
  });
});
