/**
 * Read-only OpenSea API v2 client.
 *
 * Two invariants, both load-bearing:
 *   1. GET only. There is no code path here that mutates anything. Anchor proposes; it never executes.
 *   2. Every request passes through the rate limiter and the cache, so the whole desktop shares one
 *      budget rather than each widget hammering the API independently.
 *
 * Endpoint paths verified against docs.opensea.io.
 */
import { Cache, type CacheEntry } from "./cache.ts";
import { getApiKey } from "./keyring.ts";

const BASE = "https://api.opensea.io/api/v2";

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
    this.#minIntervalMs = 1000 / Math.max(0.1, requestsPerSecond);
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
}

export class OpenSeaClient {
  #chain: string;
  #cache: Cache;
  #limiter: RateLimiter;

  constructor(opts: ClientOptions) {
    this.#chain = opts.chain;
    this.#cache = opts.cache;
    this.#limiter = new RateLimiter(opts.requestsPerSecond);
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

    const apiKey = await getApiKey();
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

  /** Honours Retry-After on 429, then backs off exponentially. */
  async #fetchWithRetry<T>(url: string, apiKey: string, attempt = 0): Promise<T> {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error(`OpenSea API ${res.status} after ${attempt} retries`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.#fetchWithRetry<T>(url, apiKey, attempt + 1);
    }

    if (!res.ok) {
      // Never include the key or headers in an error — these surface in logs and issues.
      throw new Error(`OpenSea API ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** NFTs owned by an account. GET /chain/{chain}/account/{address}/nfts */
  nftsByAccount(address: string, ttl: number, opts: { collection?: string; limit?: number; next?: string } = {}) {
    return this.#get<unknown>(`/chain/${this.#chain}/account/${address}/nfts`, {
      collection: opts.collection,
      limit: String(opts.limit ?? 50),
      next: opts.next,
    }, ttl);
  }

  /** Account activity. GET /events/accounts/{address} */
  eventsByAccount(address: string, ttl: number, opts: { eventTypes?: string[]; limit?: number; next?: string } = {}) {
    return this.#get<unknown>(`/events/accounts/${address}`, {
      chain: this.#chain,
      event_type: opts.eventTypes,
      limit: String(opts.limit ?? 50),
      next: opts.next,
    }, ttl);
  }

  /** GET /collections/{slug} */
  collection(slug: string, ttl: number) {
    return this.#get<unknown>(`/collections/${slug}`, {}, ttl);
  }

  /** Floor price, volume, sales. GET /collections/{slug}/stats */
  collectionStats(slug: string, ttl: number) {
    return this.#get<unknown>(`/collections/${slug}/stats`, {}, ttl);
  }

  /** GET /listings/collection/{slug}/best */
  bestListings(slug: string, ttl: number, limit = 20) {
    return this.#get<unknown>(`/listings/collection/${slug}/best`, { limit: String(limit) }, ttl);
  }

  /** GET /offers/collection/{slug} */
  collectionOffers(slug: string, ttl: number, limit = 20) {
    return this.#get<unknown>(`/offers/collection/${slug}`, { limit: String(limit) }, ttl);
  }
}
