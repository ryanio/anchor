/**
 * The OpenSea client's promises, tested at its boundary rather than through its internals.
 *
 * The promises under test:
 *   - the SDK builds the paths, and they are the ones OpenSea documents,
 *   - the service is read-only: every SDK signing and order-building call is refused at transport,
 *   - one shared request budget: requests are serialised and spaced,
 *   - a fresh cache costs nothing, and a dead network still returns the last good answer,
 *   - and no error this module produces ever carries a credential.
 *
 * Nothing here touches the network: `globalThis.fetch` is replaced for the duration of each test,
 * and the credentials are obvious placeholders — real ones live in the OS keyring.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_KEY,
  FRESH_TTL,
  type Harness,
  harness,
  jsonResponse,
  NO_TTL,
  PAT,
  rejects,
  respondInOrder,
  statusResponse,
  tempCache,
  withExchange,
} from "./fixtures.ts";
import { MissingApiKeyError, ReadOnlyOpenSeaAPI, ReadOnlyViolationError } from "./opensea.ts";

/** Run a harness and always put `globalThis.fetch` back, whatever the test does. */
async function using(h: Harness, fn: (h: Harness) => Promise<void>): Promise<void> {
  try {
    await fn(h);
  } finally {
    h.restore();
  }
}

const ok = () => jsonResponse({ ok: true });

/** Seaport 1.6. Only its *shape* matters here: the SDK validates the address before posting. */
const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";

describe("the SDK owns the paths", () => {
  // Every one of these was verified against docs.opensea.io. They are asserted here because two of
  // them were wrong when the client hand-rolled its own URLs, which is why the SDK was adopted.
  const cases: Array<[string, (h: Harness) => Promise<unknown>, string]> = [
    ["collection", (h) => h.client.collection("cool-cats", NO_TTL), "/api/v2/collections/cool-cats"],
    [
      "collection stats",
      (h) => h.client.collectionStats("cool-cats", NO_TTL),
      "/api/v2/collections/cool-cats/stats",
    ],
    [
      "best listings",
      (h) => h.client.bestListings("cool-cats", NO_TTL),
      "/api/v2/listings/collection/cool-cats/best",
    ],
    [
      "collection offers",
      (h) => h.client.collectionOffers("cool-cats", NO_TTL),
      "/api/v2/offers/collection/cool-cats",
    ],
    [
      "nfts by account",
      (h) => h.client.nftsByAccount("0xdead", NO_TTL),
      "/api/v2/chain/ethereum/account/0xdead/nfts",
    ],
    ["account events", (h) => h.client.eventsByAccount("0xdead", NO_TTL), "/api/v2/events/accounts/0xdead"],
    ["portfolio", (h) => h.client.portfolioStats("0xdead", NO_TTL), "/api/v2/account/0xdead/portfolio"],
    ["balances", (h) => h.client.tokenBalances("0xdead", NO_TTL), "/api/v2/account/0xdead/tokens"],
    ["trending tokens", (h) => h.client.trendingTokens(NO_TTL), "/api/v2/tokens/trending"],
    ["top tokens", (h) => h.client.topTokens(NO_TTL), "/api/v2/tokens/top"],
    ["token", (h) => h.client.token("0xbeef", NO_TTL), "/api/v2/chain/ethereum/token/0xbeef"],
    [
      "token price history",
      (h) => h.client.tokenPriceHistory("0xbeef", NO_TTL, { startTime: "2026-01-01T00:00:00Z" }),
      "/api/v2/chain/ethereum/token/0xbeef/price_history",
    ],
  ];

  for (const [name, call, expected] of cases) {
    test(`${name} hits ${expected}`, async () => {
      const h = harness(withExchange(ok));
      await using(h, async () => {
        await call(h);
        const read = h.calls.find((c) => c.method === "GET");
        assert.ok(read, "expected a GET");
        assert.equal(new URL(read.url).pathname, expected);
        assert.equal(new URL(read.url).origin, "https://api.opensea.io");
      });
    });
  }
});

describe("read-only, enforced at the transport", () => {
  /**
   * Every SDK write funnels through `post`/`request`, so refusing those refuses the whole class:
   * order posting, offer building, listing and offer *actions*, swap execution, transfers, drop
   * mints. `getSwapQuote` is a GET and so cannot be caught here — it is covered by the source scan
   * below, which asserts the service never names it.
   */
  const writes: Array<[string, (api: ReadOnlyOpenSeaAPI) => Promise<unknown>]> = [
    ["postListing", (api) => api.postListing({} as never, SEAPORT)],
    ["postOffer", (api) => api.postOffer({} as never, SEAPORT)],
    ["postCollectionOffer", (api) => api.postCollectionOffer({} as never, "cool-cats")],
    ["buildOffer", (api) => api.buildOffer("0xdead", 1, "cool-cats")],
    ["createListingActions", (api) => api.createListingActions({} as never)],
    ["createOfferActions", (api) => api.createOfferActions({} as never)],
    ["executeSwap", (api) => api.executeSwap({} as never)],
    ["transferAssets", (api) => api.transferAssets({} as never)],
    ["sweepCollection", (api) => api.sweepCollection({} as never)],
    ["deployDropContract", (api) => api.deployDropContract({} as never)],
    ["buildDropMintTransaction", (api) => api.buildDropMintTransaction("drop", {} as never)],
    ["offchainCancelOrder", (api) => api.offchainCancelOrder(SEAPORT, "0xhash")],
  ];

  for (const [name, call] of writes) {
    test(`${name} is refused before it reaches the network`, async () => {
      const h = harness(() => {
        assert.fail("a write must never reach the network");
      });
      await using(h, async () => {
        const api = new ReadOnlyOpenSeaAPI(
          { apiKey: API_KEY },
          { cache: tempCache(), limiter: { schedule: (fn) => fn() } },
        );
        const err = await rejects(() => call(api));
        assert.ok(err instanceof ReadOnlyViolationError, `${name} was not refused: ${err.message}`);
        assert.match(err.message, /read-only/);
        assert.equal(h.calls.length, 0);
      });
    });
  }

  test("the service source names no signing or order-building call", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const here = dirname(fileURLToPath(import.meta.url));
    // Everything the service ships, minus this file — which necessarily names them all.
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && f !== "opensea.test.ts");

    /** Signing, order construction, swap execution, and the ethers-backed SDK entry point. */
    const forbidden = [
      "OpenSeaSDK",
      "seaport",
      "getSwapQuote",
      "executeSwap",
      "postListing",
      "postOffer",
      "postCollectionOffer",
      "buildOffer",
      "createListingActions",
      "createOfferActions",
      "createCancelOrderActions",
      "createListingFulfillmentActions",
      "createOfferFulfillmentActions",
      "generateFulfillmentData",
      "offchainCancelOrder",
      "transferAssets",
      "sweepCollection",
      "deployDropContract",
      "buildDropMintTransaction",
      "signMessage",
      "signTypedData",
      "sendTransaction",
    ];

    /**
     * Comments are stripped first: this module's own documentation explains *which* calls are
     * refused and why, and naming them in prose must not read as calling them. Crude but adequate —
     * the question is only whether an identifier appears in code.
     */
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const file of sources) {
      const text = stripComments(readFileSync(join(here, file), "utf8"));
      for (const name of forbidden) {
        assert.ok(
          !text.includes(name),
          `${file} names ${name}. Signing and order construction belong in the executor, never in service/.`,
        );
      }
    }
  });
});

describe("rate limiter", () => {
  test("spaces requests by the configured interval", async () => {
    // 20 requests/second => a 50ms floor between starts.
    const h = harness(withExchange(ok), { requestsPerSecond: 20 });
    await using(h, async () => {
      await Promise.all([
        h.client.collectionStats("a", NO_TTL),
        h.client.collectionStats("b", NO_TTL),
        h.client.collectionStats("c", NO_TTL),
      ]);

      assert.equal(h.calls.length, 3);
      for (let i = 1; i < h.calls.length; i++) {
        const gap = h.calls[i]!.at - h.calls[i - 1]!.at;
        // Timers may fire a hair early; the point is that the interval is respected, not exact.
        assert.ok(gap >= 40, `expected >=40ms between requests, saw ${gap}ms`);
      }
    });
  });

  test("serialises requests — never two in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return jsonResponse({ ok: true });
    });
    await using(h, async () => {
      await Promise.all(["a", "b", "c"].map((s) => h.client.collectionStats(s, NO_TTL)));
      assert.equal(peak, 1);
    });
  });

  test("a rejected request does not break the chain for the ones behind it", async () => {
    const h = harness(
      (call) => (call.url.includes("boom") ? statusResponse(404) : jsonResponse({ ok: true })),
      { requestsPerSecond: 50 },
    );
    await using(h, async () => {
      const results = await Promise.allSettled([
        h.client.collectionStats("boom", NO_TTL),
        h.client.collectionStats("after-1", NO_TTL),
        h.client.collectionStats("after-2", NO_TTL),
      ]);

      assert.equal(results[0]!.status, "rejected");
      assert.equal(results[1]!.status, "fulfilled");
      assert.equal(results[2]!.status, "fulfilled");
      assert.equal(h.calls.length, 3);
      assert.ok(h.calls[2]!.at - h.calls[1]!.at >= 15);
    });
  });
});

describe("request shape", () => {
  test("sends the key as a header, and only ever GETs", async () => {
    const h = harness(ok);
    await using(h, async () => {
      await h.client.collectionStats("cool-cats", NO_TTL);
      const call = h.calls[0]!;
      assert.equal(call.method, "GET");
      assert.equal(call.headers["x-api-key"], API_KEY);
      // The key belongs in a header, never in a URL that gets cached and logged.
      assert.ok(!call.url.includes(API_KEY));
    });
  });

  test("the only outbound non-GET is the wallet token exchange", async () => {
    const h = harness(withExchange(ok));
    await using(h, async () => {
      await h.client.collectionStats("cool-cats", NO_TTL);
      await h.client.tokenBalances("0xdead", NO_TTL);
      await h.client.portfolioStats("0xdead", NO_TTL);

      const writes = h.calls.filter((c) => c.method !== "GET");
      assert.equal(writes.length, 1);
      assert.equal(new URL(writes[0]!.url).pathname, "/api/v2/auth/tokens/exchange");
      // A credential exchange touches no chain. It is the one outbound write the service makes.
      assert.ok(!writes[0]!.url.includes(PAT), "the PAT belongs in the body, not the URL");
    });
  });

  test("a slug cannot escape its path segment", async () => {
    const h = harness(ok);
    await using(h, async () => {
      await h.client.collectionStats("../../events/accounts/0xdead", NO_TTL);
      const url = new URL(h.calls[0]!.url);
      assert.equal(url.origin, "https://api.opensea.io");
      assert.equal(
        url.pathname,
        "/api/v2/collections/..%2F..%2Fevents%2Faccounts%2F0xdead/stats",
        "an untrusted slug must stay one path segment",
      );
    });
  });

  // Encoding is necessary but not sufficient, which is the part that is easy to get wrong.
  // `encodeURIComponent` leaves `.` and `..` untouched, and the URL parser strips percent-escapes
  // before it removes dot segments, so no encoding of them survives. They have to be refused.
  test("a bare dot segment is refused rather than encoded", async () => {
    const h = harness(ok);
    await using(h, async () => {
      for (const probe of [".", ".."]) {
        await assert.rejects(
          () => h.client.collectionStats(probe, NO_TTL),
          /relative path reference/,
          `${JSON.stringify(probe)} must be refused`,
        );
      }
      assert.equal(h.calls.length, 0, "a refused slug must never reach the network");
    });
  });

  // Rejection is sufficient as well as necessary: after encoding, nothing else is a dot segment.
  test("values that merely look like dot segments still encode safely", async () => {
    for (const probe of ["...", "%2e%2e", ".%2e", "..a", "a..", "....//"]) {
      const path = `/api/v2/collections/${encodeURIComponent(probe)}/stats`;
      assert.equal(
        new URL(path, "https://api.opensea.io").pathname,
        path,
        `${JSON.stringify(probe)} must survive as a literal segment`,
      );
    }
  });

  test("repeatable and optional query params are built as documented", async () => {
    const h = harness(withExchange(ok));
    await using(h, async () => {
      await h.client.eventsByAccount("0xdead", NO_TTL, { eventTypes: ["sale", "transfer"] });
      const url = new URL(h.calls.find((c) => c.method === "GET")!.url);
      assert.deepEqual(url.searchParams.getAll("event_type"), ["sale", "transfer"]);
      assert.equal(url.searchParams.get("chain"), "ethereum");
      assert.equal(url.searchParams.get("limit"), "50");
      assert.equal(url.searchParams.get("next"), null);
    });
  });
});

describe("cache-first", () => {
  test("a fresh entry short-circuits without touching the network", async () => {
    const h = harness(ok);
    await using(h, async () => {
      await h.client.collectionStats("cool-cats", FRESH_TTL);
      assert.equal(h.calls.length, 1);
      await h.client.collectionStats("cool-cats", FRESH_TTL);
      assert.equal(h.calls.length, 1, "the second call must come from cache");
    });
  });

  test("a stale entry triggers a fetch and the fresh answer wins", async () => {
    const cache = tempCache();
    const first = harness(() => jsonResponse({ floor: 1 }), { cache });
    await using(first, async () => {
      await first.client.collectionStats("cool-cats", NO_TTL);
    });

    const second = harness(() => jsonResponse({ floor: 2 }), { cache });
    await using(second, async () => {
      const entry = await second.client.collectionStats("cool-cats", FRESH_TTL);
      assert.deepEqual(entry.data, { floor: 2 });
      assert.equal(entry.stale, false);
      assert.equal(entry.ageSeconds, 0);
      assert.equal(second.calls.length, 1);
    });
  });

  test("different params are different cache entries", async () => {
    const h = harness(withExchange(ok));
    await using(h, async () => {
      await h.client.trendingTokens(FRESH_TTL, 10);
      await h.client.trendingTokens(FRESH_TTL, 20);
      assert.equal(h.calls.filter((c) => c.method === "GET").length, 2);
    });
  });
});

describe("stale fallback — a slightly old answer beats an error card", () => {
  /** Warm the cache with `{floor: 1}` at a ttl of zero, so it is present but stale. */
  async function warmed() {
    const cache = tempCache();
    const h = harness(() => jsonResponse({ floor: 1 }), { cache });
    await using(h, async () => {
      await h.client.collectionStats("cool-cats", NO_TTL);
    });
    return cache;
  }

  const failures: Array<[string, () => Response]> = [
    ["a 5xx", () => statusResponse(503)],
    ["a 4xx", () => statusResponse(404)],
  ];

  for (const [name, response] of failures) {
    test(`${name} falls back to the cached entry`, async () => {
      const h = harness(response, { cache: await warmed() });
      await using(h, async () => {
        const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
        assert.deepEqual(entry.data, { floor: 1 });
        // Freshness stays visible: the caller is told the answer is old (docs/security.md).
        assert.equal(entry.stale, true);
      });
    });
  }

  test("a network failure serves the cached entry instead of throwing", async () => {
    const h = harness(
      () => {
        throw new TypeError("fetch failed");
      },
      { cache: await warmed() },
    );
    await using(h, async () => {
      const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
      assert.deepEqual(entry.data, { floor: 1 });
      assert.equal(entry.stale, true);
    });
  });

  test("with nothing cached there is nothing to fall back to, so it throws", async () => {
    const h = harness(() => {
      throw new TypeError("fetch failed");
    });
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.match(err.message, /OpenSea request failed/);
    });
  });
});

describe("missing API key", () => {
  test("MissingApiKeyError when there is no key", async () => {
    const h = harness(
      () => {
        assert.fail("must not reach the network without a key");
      },
      { apiKey: null },
    );
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.ok(err instanceof MissingApiKeyError);
      assert.equal(h.calls.length, 0);
    });
  });

  test("an empty-string key counts as no key", async () => {
    const h = harness(
      () => {
        assert.fail("must not reach the network without a key");
      },
      { apiKey: "" },
    );
    await using(h, async () => {
      assert.ok((await rejects(() => h.client.collectionStats("c", NO_TTL))) instanceof MissingApiKeyError);
    });
  });

  test("MissingApiKeyError explains the fix and names no secret", async () => {
    const h = harness(ok, { apiKey: null });
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.match(err.message, /--set-api-key/);
      assert.ok(!err.message.includes(API_KEY));
    });
  });
});

describe("errors never carry a credential", () => {
  /**
   * The SDK builds its error messages from the response body, which is remote-controlled, so the
   * client rebuilds every message from a status code it recognises and drops the rest. These cases
   * are the ways a hostile or merely chatty upstream could try to get a header back out of us.
   */
  const cases: Array<[string, () => Response]> = [
    [
      "a 4xx whose body echoes the key",
      () => jsonResponse({ errors: [`bad key ${API_KEY}`] }, { status: 403 }),
    ],
    [
      "a body full of control characters",
      () => jsonResponse({ errors: [`Bad\r\nSet-Cookie: k=${API_KEY} `] }, { status: 400 }),
    ],
    ["a 5xx echoing the PAT", () => jsonResponse({ errors: [`token ${PAT}`] }, { status: 503 })],
    [
      "a body that echoes the key back as invalid JSON",
      () => new Response(`{"key": "${API_KEY}"`, { status: 200 }),
    ],
  ];

  for (const [name, response] of cases) {
    test(`${name} produces a clean message`, async () => {
      const h = harness(response);
      await using(h, async () => {
        const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
        assert.ok(!err.message.includes(API_KEY), `key leaked: ${err.message}`);
        assert.ok(!err.message.includes(PAT), `PAT leaked: ${err.message}`);
        assert.ok(!/x-api-key/i.test(err.message), `headers leaked: ${err.message}`);
        assert.ok(!/set-cookie/i.test(err.message), `headers leaked: ${err.message}`);
        // Control characters would let a remote forge log lines.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point — this asserts they are absent
        assert.ok(!/[\x00-\x1f]/.test(err.message), `control characters in: ${JSON.stringify(err.message)}`);
        // Still useful to a human: it says which API failed.
        assert.match(err.message, /OpenSea/);
      });
    });
  }

  test("a transport error keeps the errno, which is the useful part", async () => {
    const h = harness(() => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ENOTFOUND" };
      throw err;
    });
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.equal(err.message, "OpenSea request failed (TypeError: ENOTFOUND)");
    });
  });

  test("a transport error that quotes the whole request is not repeated", async () => {
    const h = harness(() => {
      // Real HTTP clients do this: the request, headers and all, embedded in the message.
      const err = new Error(`connect ECONNREFUSED — headers: {"x-api-key":"${API_KEY}"}`);
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    });
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.ok(!err.message.includes(API_KEY));
      assert.ok(!/x-api-key/i.test(err.message));
    });
  });

  test("a 4xx with a status in the message is reported by status alone", async () => {
    const h = harness(() => statusResponse(404));
    await using(h, async () => {
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.equal(err.message, "OpenSea API 404 Not Found");
    });
  });

  test("a retryable status is not retried past the deadline", async () => {
    // The SDK owns the 429 ladder; what matters here is that it terminates and reports cleanly.
    const h = harness(
      respondInOrder(
        () => statusResponse(429, { "retry-after": "1" }),
        () => jsonResponse({ ok: true }),
      ),
    );
    await using(h, async () => {
      const entry = await h.client.collectionStats("cool-cats", NO_TTL);
      assert.deepEqual(entry.data, { ok: true });
      assert.equal(h.calls.length, 2, "a 429 is retried once the Retry-After has elapsed");
    });
  });
});
