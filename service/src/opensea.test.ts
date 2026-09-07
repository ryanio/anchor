/**
 * The OpenSea client's promises, tested at its boundary rather than through its internals.
 *
 * The promises under test:
 *   - one shared request budget: requests are serialised and spaced,
 *   - a transient failure is retried, a permanent one is not,
 *   - a fresh cache costs nothing, and a dead network still returns the last good answer,
 *   - and no error this module produces ever carries the API key.
 *
 * Nothing here touches the network: `fetchImpl` and `getApiKey` are injected, and the key below is
 * an obvious placeholder — real credentials live in the OS keyring (docs/security.md).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Cache } from "./cache.ts";
import { type ClientOptions, MissingApiKeyError, OpenSeaClient } from "./opensea.ts";

const API_KEY = "placeholder-not-a-real-key-0123456789";
const NO_TTL = 0; // ttl 0 => the entry is stale the moment it is written
const FRESH_TTL = 600;

function tempCache(): Cache {
  return new Cache(join(mkdtempSync(join(tmpdir(), "anchor-os-")), "cache.sqlite"));
}

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

/** A fetch stub that records every call and answers from `handler`. */
function stubFetch(handler: Handler): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {}, at: Date.now() };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { impl, calls };
}

/** Answer each call from a list, reusing the last entry once the list runs out. */
function respondInOrder(...responses: (() => Response)[]): Handler {
  return (_call, i) => responses[Math.min(i, responses.length - 1)]!();
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

/**
 * A hostile response shape. `Response` refuses to hold a malformed `statusText`, which is exactly
 * the case worth covering: the field is remote-controlled and ends up in our logs.
 */
function fakeResponse(status: number, statusText: string, body: string | null = null): Response {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: null,
    json: async () => (body === null ? {} : JSON.parse(body)),
  } as unknown as Response;
}

interface Harness {
  client: OpenSeaClient;
  cache: Cache;
  calls: Call[];
  sleeps: number[];
}

function harness(
  handler: Handler,
  opts: { cache?: Cache; apiKey?: string | null; requestsPerSecond?: number; realSleep?: boolean } = {},
): Harness {
  const cache = opts.cache ?? tempCache();
  const { impl, calls } = stubFetch(handler);
  const sleeps: number[] = [];
  const clientOpts: ClientOptions = {
    chain: "ethereum",
    requestsPerSecond: opts.requestsPerSecond ?? 1000,
    cache,
    fetchImpl: impl,
    getApiKey: async () => (opts.apiKey === undefined ? API_KEY : opts.apiKey),
  };
  if (!opts.realSleep) {
    // Record the retry ladder instead of living through it; the delays are asserted directly.
    clientOpts.sleep = async (ms: number) => {
      sleeps.push(ms);
    };
  }
  return { client: new OpenSeaClient(clientOpts), cache, calls, sleeps };
}

async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail("expected the call to reject");
}

describe("rate limiter", () => {
  test("spaces requests by the configured interval", async () => {
    // 20 requests/second => a 50ms floor between starts.
    const h = harness(() => jsonResponse({ ok: true }), { requestsPerSecond: 20, realSleep: true });
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

  test("serialises requests — never two in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness(
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return jsonResponse({ ok: true });
      },
      { realSleep: true },
    );

    await Promise.all(["a", "b", "c"].map((s) => h.client.collectionStats(s, NO_TTL)));
    assert.equal(peak, 1);
  });

  test("a rejected request does not break the chain for the ones behind it", async () => {
    const h = harness(
      (call) => (call.url.includes("boom") ? statusResponse(404) : jsonResponse({ ok: true })),
      {
        requestsPerSecond: 50,
        realSleep: true,
      },
    );

    const results = await Promise.allSettled([
      h.client.collectionStats("boom", NO_TTL),
      h.client.collectionStats("after-1", NO_TTL),
      h.client.collectionStats("after-2", NO_TTL),
    ]);

    assert.equal(results[0]!.status, "rejected");
    assert.equal(results[1]!.status, "fulfilled");
    assert.equal(results[2]!.status, "fulfilled");
    assert.equal(h.calls.length, 3);
    // Still spaced: the failure did not collapse the interval either.
    assert.ok(h.calls[2]!.at - h.calls[1]!.at >= 15);
  });
});

describe("retries", () => {
  test("429 honours Retry-After", async () => {
    const h = harness(
      respondInOrder(
        () => statusResponse(429, { "retry-after": "2" }),
        () => jsonResponse({ ok: true }),
      ),
    );

    const entry = await h.client.collectionStats("cool-cats", NO_TTL);
    assert.deepEqual(entry.data, { ok: true });
    assert.deepEqual(h.sleeps, [2000]);
  });

  test("429 accepts an HTTP-date Retry-After", async () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const h = harness(
      respondInOrder(
        () => statusResponse(429, { "retry-after": when }),
        () => jsonResponse({ ok: true }),
      ),
    );

    await h.client.collectionStats("cool-cats", NO_TTL);
    assert.equal(h.sleeps.length, 1);
    // toUTCString() truncates to whole seconds, and a loaded CI box may take a moment to get here;
    // what matters is that the date was read as a delay rather than discarded.
    assert.ok(h.sleeps[0]! > 500 && h.sleeps[0]! <= 5000, `unexpected wait ${h.sleeps[0]}ms`);
  });

  test("a hostile Retry-After cannot stall the shared chain for longer than a minute", async () => {
    const h = harness(
      respondInOrder(
        () => statusResponse(429, { "retry-after": "86400" }),
        () => jsonResponse({ ok: true }),
      ),
    );

    await h.client.collectionStats("cool-cats", NO_TTL);
    assert.deepEqual(h.sleeps, [60_000]);
  });

  test("a malformed or absent Retry-After falls back to exponential backoff", async () => {
    const variants: Record<string, string>[] = [{}, { "retry-after": "soon" }, { "retry-after": "-5" }];
    for (const headers of variants) {
      const h = harness(
        respondInOrder(
          () => statusResponse(429, headers),
          () => jsonResponse({ ok: true }),
        ),
      );
      await h.client.collectionStats("cool-cats", NO_TTL);
      assert.deepEqual(h.sleeps, [1000], `headers ${JSON.stringify(headers)}`);
    }
  });

  test("5xx backs off exponentially", async () => {
    const h = harness(
      respondInOrder(
        () => statusResponse(500),
        () => statusResponse(502),
        () => statusResponse(503),
        () => jsonResponse({ ok: true }),
      ),
    );

    const entry = await h.client.collectionStats("cool-cats", NO_TTL);
    assert.deepEqual(entry.data, { ok: true });
    assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
    assert.equal(h.calls.length, 4);
  });

  test("5xx ignores Retry-After — the documented contract is exponential backoff", async () => {
    const h = harness(
      respondInOrder(
        () => statusResponse(503, { "retry-after": "30" }),
        () => jsonResponse({ ok: true }),
      ),
    );

    await h.client.collectionStats("cool-cats", NO_TTL);
    assert.deepEqual(h.sleeps, [1000]);
  });

  test("gives up after the retry budget", async () => {
    const h = harness(() => statusResponse(503));

    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.match(err.message, /503/);
    assert.match(err.message, /after 3 retries/);
    // The first attempt plus three retries, and no more.
    assert.equal(h.calls.length, 4);
    assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
  });

  test("4xx other than 429 is final — no retry, no wait", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const h = harness(() => statusResponse(status));
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
      assert.match(err.message, new RegExp(String(status)));
      assert.equal(h.calls.length, 1, `status ${status} should not be retried`);
      assert.deepEqual(h.sleeps, []);
    }
  });

  test("a malformed JSON body is an error, not a crash", async () => {
    const h = harness(() => new Response("<html>not json</html>", { status: 200 }));
    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.match(err.message, /malformed JSON/);
    assert.equal(h.calls.length, 1);
  });
});

describe("request shape", () => {
  test("sends the key as a header, and only ever GETs", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.collectionStats("cool-cats", NO_TTL);

    const call = h.calls[0]!;
    assert.equal(call.init.method, "GET");
    assert.equal((call.init.headers as Record<string, string>)["x-api-key"], API_KEY);
    // The key belongs in a header, never in a URL that gets cached and logged.
    assert.ok(!call.url.includes(API_KEY));
  });

  test("carries an abort signal so a hung connection cannot wedge the chain", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.collectionStats("cool-cats", NO_TTL);
    assert.ok(h.calls[0]!.init.signal instanceof AbortSignal);
  });

  test("a slug cannot escape its path segment", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.collectionStats("../../events/accounts/0xdead", NO_TTL);

    const url = new URL(h.calls[0]!.url);
    assert.equal(url.origin, "https://api.opensea.io");
    assert.equal(
      url.pathname,
      "/api/v2/collections/..%2F..%2Fevents%2Faccounts%2F0xdead/stats",
      "an untrusted slug must stay one path segment",
    );
  });

  test("an address cannot escape its path segment", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.nftsByAccount("0xabc/../../evil", NO_TTL);

    const url = new URL(h.calls[0]!.url);
    assert.equal(url.pathname, "/api/v2/chain/ethereum/account/0xabc%2F..%2F..%2Fevil/nfts");
  });

  test("repeatable and optional query params are built as documented", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.eventsByAccount("0xdead", NO_TTL, { eventTypes: ["sale", "transfer"] });

    const url = new URL(h.calls[0]!.url);
    assert.deepEqual(url.searchParams.getAll("event_type"), ["sale", "transfer"]);
    assert.equal(url.searchParams.get("chain"), "ethereum");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("next"), null);
  });
});

describe("cache-first", () => {
  test("a fresh entry short-circuits without touching the network", async () => {
    const cache = tempCache();
    const h = harness(
      () => {
        assert.fail("a fresh cache entry must not cause a request");
      },
      { cache },
    );
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, FRESH_TTL);

    const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
    assert.deepEqual(entry.data, { floor: 1 });
    assert.equal(entry.stale, false);
    assert.equal(h.calls.length, 0);
  });

  test("a stale entry triggers a fetch and the fresh answer wins", async () => {
    const cache = tempCache();
    const h = harness(() => jsonResponse({ floor: 2 }), { cache });
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, NO_TTL);

    const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
    assert.deepEqual(entry.data, { floor: 2 });
    assert.equal(entry.stale, false);
    assert.equal(entry.ageSeconds, 0);
    assert.equal(h.calls.length, 1);
  });

  test("a successful fetch is cached, so the next call is free", async () => {
    const h = harness(() => jsonResponse({ floor: 3 }));
    await h.client.collectionStats("cool-cats", FRESH_TTL);
    const second = await h.client.collectionStats("cool-cats", FRESH_TTL);

    assert.deepEqual(second.data, { floor: 3 });
    assert.equal(h.calls.length, 1);
  });

  test("different params are different cache entries", async () => {
    const h = harness(() => jsonResponse({ ok: true }));
    await h.client.nftsByAccount("0xdead", FRESH_TTL, { collection: "a" });
    await h.client.nftsByAccount("0xdead", FRESH_TTL, { collection: "b" });
    assert.equal(h.calls.length, 2);
  });
});

describe("stale fallback — a slightly old answer beats an error card", () => {
  test("a network failure serves the cached entry instead of throwing", async () => {
    const cache = tempCache();
    const h = harness(
      () => {
        throw new TypeError("fetch failed");
      },
      { cache },
    );
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, NO_TTL);

    const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
    assert.deepEqual(entry.data, { floor: 1 });
    // Freshness stays visible: the caller is told the answer is old (docs/security.md).
    assert.equal(entry.stale, true);
  });

  test("an exhausted retry budget also falls back to cache", async () => {
    const cache = tempCache();
    const h = harness(() => statusResponse(503), { cache });
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, NO_TTL);

    const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
    assert.deepEqual(entry.data, { floor: 1 });
    assert.equal(entry.stale, true);
  });

  test("a 4xx also falls back to cache", async () => {
    const cache = tempCache();
    const h = harness(() => statusResponse(404), { cache });
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, NO_TTL);

    assert.deepEqual((await h.client.collectionStats("cool-cats", FRESH_TTL)).data, { floor: 1 });
  });

  test("with nothing cached there is nothing to fall back to, so it throws", async () => {
    const h = harness(() => {
      throw new TypeError("fetch failed");
    });
    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.match(err.message, /OpenSea request failed/);
  });
});

describe("missing API key", () => {
  test("MissingApiKeyError when there is no key and no cache", async () => {
    const h = harness(
      () => {
        assert.fail("must not reach the network without a key");
      },
      { apiKey: null },
    );

    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.ok(err instanceof MissingApiKeyError);
    assert.equal(h.calls.length, 0);
  });

  test("cached data is still served when there is no key", async () => {
    const cache = tempCache();
    const h = harness(
      () => {
        assert.fail("must not reach the network without a key");
      },
      { cache, apiKey: null },
    );
    cache.put("https://api.opensea.io/api/v2/collections/cool-cats/stats", { floor: 1 }, NO_TTL);

    const entry = await h.client.collectionStats("cool-cats", FRESH_TTL);
    assert.deepEqual(entry.data, { floor: 1 });
    assert.equal(entry.stale, true);
  });

  test("an empty-string key counts as no key", async () => {
    const h = harness(
      () => {
        assert.fail("must not reach the network without a key");
      },
      { apiKey: "" },
    );
    assert.ok((await rejects(() => h.client.collectionStats("c", NO_TTL))) instanceof MissingApiKeyError);
  });
});

describe("errors never carry the API key", () => {
  /** Every error message this module can produce, gathered through the public surface. */
  const cases: { name: string; build: () => Harness }[] = [
    {
      name: "a transport error that quotes the whole request",
      build: () =>
        harness(() => {
          // Real HTTP clients do this: the request, headers and all, embedded in the message.
          const err = new Error(`connect ECONNREFUSED — request headers: {"x-api-key":"${API_KEY}"}`);
          err.cause = { code: "ECONNREFUSED", headers: { "x-api-key": API_KEY } };
          throw err;
        }),
    },
    {
      name: "a timeout",
      build: () =>
        harness(() => {
          const err = new Error(`aborted while sending x-api-key: ${API_KEY}`);
          err.name = "TimeoutError";
          throw err;
        }),
    },
    {
      name: "a 4xx whose statusText echoes the request",
      build: () => harness(() => fakeResponse(403, `Forbidden for key ${API_KEY}`)),
    },
    {
      name: "a statusText full of control characters",
      build: () => harness(() => fakeResponse(400, `Bad\r\nSet-Cookie: k=${API_KEY} `)),
    },
    {
      name: "an exhausted retry budget",
      build: () => harness(() => fakeResponse(503, `Unavailable ${API_KEY}`)),
    },
    {
      name: "a body that echoes the key back as invalid JSON",
      build: () => harness(() => new Response(`{"key": "${API_KEY}"`, { status: 200 })),
    },
  ];

  for (const { name, build } of cases) {
    test(`${name} produces a clean message`, async () => {
      const h = build();
      const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));

      assert.ok(!err.message.includes(API_KEY), `key leaked: ${err.message}`);
      assert.ok(!/x-api-key/i.test(err.message), `headers leaked: ${err.message}`);
      assert.ok(!/set-cookie/i.test(err.message), `headers leaked: ${err.message}`);
      // Control characters would let a remote forge log lines.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point — this asserts they are absent
      assert.ok(!/[\x00-\x1f]/.test(err.message), `control characters in: ${JSON.stringify(err.message)}`);
      // Still useful to a human: it says which API failed.
      assert.match(err.message, /OpenSea/);
    });
  }

  test("a timeout says so, without quoting the aborted request", async () => {
    const h = harness(() => {
      const err = new Error(`aborted: ${API_KEY}`);
      err.name = "TimeoutError";
      throw err;
    });
    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.match(err.message, /timed out after 15s/);
  });

  test("a transport error keeps the errno, which is the useful part", async () => {
    const h = harness(() => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ENOTFOUND" };
      throw err;
    });
    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.equal(err.message, "OpenSea request failed (TypeError: ENOTFOUND)");
  });

  test("MissingApiKeyError explains the fix and names no secret", async () => {
    const h = harness(() => jsonResponse({}), { apiKey: null });
    const err = await rejects(() => h.client.collectionStats("cool-cats", NO_TTL));
    assert.match(err.message, /--set-api-key/);
    assert.ok(!err.message.includes(API_KEY));
  });
});
