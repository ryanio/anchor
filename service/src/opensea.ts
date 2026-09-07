/**
 * Read-only OpenSea API v2 client.
 *
 * Two invariants, both load-bearing:
 *   1. GET only. There is no code path here that mutates anything. Anchor proposes; it never executes.
 *   2. Every request passes through the rate limiter and the cache, so the whole desktop shares one
 *      budget rather than each widget hammering the API independently.
 *
 * A third, quieter promise: an error from this module never carries the API key or the request
 * headers. Errors end up in logs, in the local API's JSON, and in pasted issue reports, so every
 * message here is built from values we control — a status code, an error name, an errno — and never
 * from a free-form message produced elsewhere. See `describeNetworkFailure`.
 *
 * Endpoint paths verified against docs.opensea.io.
 */
import { Cache, type CacheEntry } from "./cache.ts";
import { getApiKey as getApiKeyFromKeyring } from "./keyring.ts";

const BASE = "https://api.opensea.io/api/v2";

/** Retries after the first attempt, so at most MAX_RETRIES + 1 requests hit the network. */
const MAX_RETRIES = 3;
/** Exponential backoff base: 1s, 2s, 4s. */
const BACKOFF_BASE_MS = 1000;
/**
 * A `Retry-After` we honour is a value a remote server chose. Requests are serialised, so an
 * unbounded sleep here stalls every widget on the desktop; cap what a remote can ask of us.
 */
const MAX_RETRY_AFTER_MS = 60_000;
/** Nothing may hold the shared request chain forever. */
const REQUEST_TIMEOUT_MS = 15_000;

export class MissingApiKeyError extends Error {
  constructor() {
    super("No OpenSea API key in the keyring. Run: anchor-service --set-api-key");
    this.name = "MissingApiKeyError";
  }
}

/** Minimum-interval limiter. Serialises requests; simple and predictable beats clever here. */
class RateLimiter {
  #minIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  #last = 0;

  constructor(requestsPerSecond: number) {
    // A NaN or non-finite setting must not disable spacing entirely, so normalise before dividing.
    const rps = Number.isFinite(requestsPerSecond) ? requestsPerSecond : 0.1;
    this.#minIntervalMs = 1000 / Math.max(0.1, rps);
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const wait = this.#last + this.#minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#last = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of individual failures.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface ClientOptions {
  chain: string;
  requestsPerSecond: number;
  cache: Cache;
  /** Seam for tests. Defaults to the global `fetch`; production never passes this. */
  fetchImpl?: typeof fetch;
  /** Seam for tests. Defaults to the OS keyring. */
  getApiKey?: () => Promise<string | null>;
  /** Seam for tests: retry backoff only, so the retry ladder can be asserted without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A path segment built from a wallet address or a collection slug. Both arrive from config or from
 * a local HTTP request, so neither is trusted to be free of `/` or `..`: unencoded, a slug like
 * `../../x` would silently retarget the request at a different endpoint and collide cache keys.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Reason phrases we are willing to print. A response's `statusText` is free-form text chosen by
 * whatever answered the request, so it is never echoed: a hostile or proxied response could use it
 * to smuggle control characters into a log line, or to echo a request header straight back at us.
 * The status code is the only part of the status line we trust, so the phrase is derived from it.
 */
const REASON_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function describeStatus(status: number): string {
  const phrase = REASON_PHRASES[status];
  return phrase ? `OpenSea API ${status} ${phrase}` : `OpenSea API ${status}`;
}

/**
 * Describe a thrown fetch failure without repeating anything it said.
 *
 * Deliberately drops the underlying `message`: transport libraries have a habit of embedding the
 * request — headers included — in their error text, and the API key lives in a header. Only the
 * error's name and an errno-shaped code are propagated, both of which are ours to recognise.
 */
function describeNetworkFailure(err: unknown): string {
  const name = err instanceof Error && /^[A-Za-z]+$/.test(err.name) ? err.name : "Error";
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : null;
  if (name === "TimeoutError" || name === "AbortError") {
    return `OpenSea request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return code ? `OpenSea request failed (${name}: ${code})` : `OpenSea request failed (${name})`;
}

/**
 * Retry-After, per RFC 9110: delay-seconds or an HTTP-date. Anything else — absent, malformed,
 * negative — returns null so the caller falls back to exponential backoff. Clamped, because the
 * value is chosen by the remote end.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - Date.now();
  if (delta <= 0) return null;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

/** Release the connection for a response we are about to discard, so retries do not leak sockets. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already gone; nothing to do.
  }
}

export class OpenSeaClient {
  #chain: string;
  #cache: Cache;
  #limiter: RateLimiter;
  #fetch: typeof fetch;
  #getApiKey: () => Promise<string | null>;
  #sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.#chain = opts.chain;
    this.#cache = opts.cache;
    this.#limiter = new RateLimiter(opts.requestsPerSecond);
    this.#fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#getApiKey = opts.getApiKey ?? getApiKeyFromKeyring;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Cache-first GET. Fresh cache short-circuits; otherwise fetch, and fall back to stale data
   * if the network fails — a slightly old portfolio beats an error card.
   */
  async #get<T>(path: string, params: Record<string, string | string[] | undefined>, ttl: number): Promise<CacheEntry<T>> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
    const key = url.toString();

    const cached = this.#cache.get<T>(key);
    if (cached && !cached.stale) return cached;

    const apiKey = await this.#getApiKey();
    if (!apiKey) {
      if (cached) return cached;
      throw new MissingApiKeyError();
    }

    try {
      const data = await this.#limiter.schedule(() => this.#fetchWithRetry<T>(key, apiKey));
      this.#cache.put(key, data, ttl);
      return { data, fetchedAt: Math.floor(Date.now() / 1000), ageSeconds: 0, stale: false };
    } catch (err) {
      if (cached) return cached; // serve stale rather than nothing
      throw err;
    }
  }

  /** Honours Retry-After on 429; 5xx backs off exponentially. Other 4xx are final — never retried. */
  async #fetchWithRetry<T>(url: string, apiKey: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "GET",
          headers: { "x-api-key": apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Never re-use the thrown message: it may quote the request, and the key is a header.
        throw new Error(describeNetworkFailure(err));
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          await discardBody(res);
          throw new Error(`${describeStatus(res.status)} after ${MAX_RETRIES} retries`);
        }
        const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : null;
        await discardBody(res);
        await this.#sleep(retryAfter ?? 2 ** attempt * BACKOFF_BASE_MS);
        continue;
      }

      if (!res.ok) {
        // Never include the key or headers in an error — these surface in logs and issues.
        await discardBody(res);
        throw new Error(describeStatus(res.status));
      }

      try {
        return (await res.json()) as T;
      } catch {
        // The body is remote-controlled; do not quote a parser error that would echo it back.
        throw new Error(`${describeStatus(res.status)} returned a malformed JSON body`);
      }
    }
  }

  /** NFTs owned by an account. GET /chain/{chain}/account/{address}/nfts */
  nftsByAccount(address: string, ttl: number, opts: { collection?: string; limit?: number; next?: string } = {}) {
    return this.#get<unknown>(`/chain/${segment(this.#chain)}/account/${segment(address)}/nfts`, {
      collection: opts.collection,
      limit: String(opts.limit ?? 50),
      next: opts.next,
    }, ttl);
  }

  /** Account activity. GET /events/accounts/{address} */
  eventsByAccount(address: string, ttl: number, opts: { eventTypes?: string[]; limit?: number; next?: string } = {}) {
    return this.#get<unknown>(`/events/accounts/${segment(address)}`, {
      chain: this.#chain,
      event_type: opts.eventTypes,
      limit: String(opts.limit ?? 50),
      next: opts.next,
    }, ttl);
  }

  /** GET /collections/{slug} */
  collection(slug: string, ttl: number) {
    return this.#get<unknown>(`/collections/${segment(slug)}`, {}, ttl);
  }

  /** Floor price, volume, sales. GET /collections/{slug}/stats */
  collectionStats(slug: string, ttl: number) {
    return this.#get<unknown>(`/collections/${segment(slug)}/stats`, {}, ttl);
  }

  /** GET /listings/collection/{slug}/best */
  bestListings(slug: string, ttl: number, limit = 20) {
    return this.#get<unknown>(`/listings/collection/${segment(slug)}/best`, { limit: String(limit) }, ttl);
  }

  /** GET /offers/collection/{slug} */
  collectionOffers(slug: string, ttl: number, limit = 20) {
    return this.#get<unknown>(`/offers/collection/${segment(slug)}`, { limit: String(limit) }, ttl);
  }
}
