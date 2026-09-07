/**
 * Read-only OpenSea client, built on `@opensea/sdk`.
 *
 * The SDK owns the wire: paths, query shaping, camelisation, and every response type. We own the
 * things the SDK does not provide and that Anchor promises — one shared cache, one shared outbound
 * rate limit, an explicit freshness envelope, and errors that can never carry a credential.
 *
 * Three invariants, all load-bearing:
 *
 *   1. **GET only.** `post()` and `request()` are overridden to throw, so every SDK method that
 *      writes — `postListing`, `postOffer`, `buildOffer`, `createListingActions`, `executeSwap`,
 *      `transferAssets`, `sweepCollection`, the drop-mint builders — fails at the transport before
 *      it can reach the network. The read-only property is enforced by structure, not by hoping
 *      nobody calls the wrong method.
 *   2. **One budget.** Every request passes through the rate limiter and the cache, so the whole
 *      desktop shares one budget rather than each widget hammering the API independently.
 *   3. **No credential in an error.** Errors end up in logs, in the local API's JSON, and in pasted
 *      issue reports. Every message here is built from values we control — a status code, an error
 *      name — and never from a free-form message produced elsewhere.
 *
 * ### Why `get()` is overridden rather than wrapped
 *
 * `OpenSeaAPI` builds its own `Fetcher` internally from `this.get/post/request` bound in the
 * constructor, and offers no seam for injecting a transport. Overriding the public `get()` is
 * therefore the one place every read funnels through, which is exactly where a cache and a rate
 * limit belong. The per-call ttl and the resulting freshness metadata travel through an
 * `AsyncLocalStorage` scope, because `get()`'s signature belongs to the SDK and cannot carry them.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChainIdentifier } from "@opensea/api-types";
import { OpenSeaAPI, type RequestOptions } from "@opensea/sdk";
import { MissingPatError, WalletTokenError, type WalletTokenProvider } from "./auth.ts";
import type { Cache, CacheEntry } from "./cache.ts";
import { toSdkChain } from "./chains.ts";
import { getApiKey as getApiKeyFromKeyring } from "./keyring.ts";

/** Per-attempt ceiling. Nothing may hold the shared request chain forever. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Whole-call ceiling, retries included. The SDK honours a `Retry-After` up to five minutes, which
 * would stall every widget on the desktop behind one unlucky request; the abort signal we pass in
 * cancels the SDK's retry sleep as well as the request.
 */
const CALL_DEADLINE_MS = 60_000;

/**
 * Transient-failure retries.
 *
 * This could not exist before `@opensea/sdk` 12.1.1. Until then only 429 and 599 carried a
 * `statusCode`; every other failure was a bare `Error` whose message was built from a
 * remote-controlled body, so a retryable 502 was indistinguishable from a permanent 404. Parsing
 * the message was never a fallback available to us either — errors are scrubbed on the way out
 * because both credentials travel in headers. `OpenSeaApiError` now sets `statusCode` on every
 * non-OK response, which is the whole reason a ladder is possible.
 *
 * **500 is deliberately not retryable.** Tempting, but there is a measured counter-example:
 * `/account/{address}/portfolio` returns a *deterministic* 500 for a large account with no query
 * parameters (docs/upstream.md entry 7). Retrying that spends two extra requests and delays the
 * stale-cache fallback, which would have served the user something useful. Gateway errors are the
 * honestly transient ones.
 *
 * **429 is not retried here either.** The SDK runs its own `Retry-After` ladder for rate limits; a
 * second ladder on top multiplies the wait rather than shortening it.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** Attempts after the first. Two rides out a gateway blip without stalling a bar widget. */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;

/**
 * True when a failure is worth trying again.
 *
 * A transport error with no status — a socket reset, a DNS blip — is retryable. A timeout is not:
 * the per-attempt ceiling already elapsed, so another attempt would spend what remains of the call
 * deadline and most likely time out too.
 */
function isRetryable(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return false;
  const status = statusOf(err);
  return status === null ? true : RETRYABLE_STATUSES.has(status);
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more here than the growth curve: the widget wakes several readers at once, so a
 * fixed backoff retries them in lockstep and hits the same struggling gateway together.
 */
function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * RETRY_BASE_DELAY_MS * 2 ** attempt);
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export class MissingApiKeyError extends Error {
  constructor() {
    super("No OpenSea API key in the keyring. Run: anchor-service --set-api-key");
    this.name = "MissingApiKeyError";
  }
}

/** Thrown when anything in `service/` reaches for a write path. Never caught — it is a bug. */
export class ReadOnlyViolationError extends Error {
  constructor(method: string, path: string) {
    super(
      `Anchor's data service is read-only and refused an outbound ${method} to ${path}. ` +
        "Signing, order construction and swaps belong in the executor, never here.",
    );
    this.name = "ReadOnlyViolationError";
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
 * Recover a status code from an SDK error without trusting its text.
 *
 * The SDK attaches `statusCode` to rate-limit errors only. For every other failure it throws a bare
 * `Error` whose message is either `Server Error (404): Not Found` or `Server Error: <body text>` —
 * so a 401 whose body carries an `errors` array is genuinely indistinguishable from a 404. The
 * anchored pattern below is deliberately strict: an error string that merely *contains* something
 * parenthesised must not be read as a status.
 */
function statusOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) return code;
  const message = err instanceof Error ? err.message : "";
  const match = /^Server Error \((\d{3})\): /.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Describe a failure without repeating anything it said.
 *
 * Deliberately drops the underlying `message`: transport libraries have a habit of embedding the
 * request — headers included — in their error text, and both credentials travel in headers. Only a
 * status code and the error's name are propagated, both of which are ours to recognise.
 */
function describeFailure(err: unknown): string {
  const name = err instanceof Error && /^[A-Za-z]+$/.test(err.name) ? err.name : "Error";
  if (name === "TimeoutError" || name === "AbortError") {
    return `OpenSea request timed out after ${CALL_DEADLINE_MS / 1000}s`;
  }
  const status = statusOf(err);
  if (status !== null) return describeStatus(status);
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : null;
  return code ? `OpenSea request failed (${name}: ${code})` : `OpenSea request failed (${name})`;
}

/**
 * Guard a value the SDK is about to interpolate into a path.
 *
 * **This no longer encodes.** `@opensea/sdk` 12.1.1 applies its own `segment()` across `apiPaths.ts`,
 * so encoding here as well would double-encode — a slug containing a space would go out as `%2520`
 * rather than `%20`. The bump and the removal of our `encodeURIComponent` had to be one commit, and
 * the traversal test below caught it when they briefly were not: it failed with `%252F` where it
 * expected `%2F`. That test asserts the *behaviour*, which is why it survived the mechanism changing.
 *
 * **The rejection stays**, and is not redundant with the SDK's. It fails before the request is
 * built, and this service caches by path: a traversed path does not merely reach the wrong endpoint,
 * it poisons that endpoint's cache key.
 *
 *
 * **The SDK did not do this before 12.1.1.** `getCollectionStatsPath(slug)` was a template literal,
 * so a slug of `../../events/accounts/0xdead` produced a request to
 * `/api/events/accounts/0xdead/stats` — a different endpoint entirely, with a cache key that
 * collides with the real one. Slugs and addresses arrive from config and from local HTTP requests,
 * so neither is trusted.
 *
 * Do not reintroduce encoding here on the grounds that it is harmless for real values. It is
 * harmless for `[a-z0-9-]` slugs and hex or base58 addresses — and it is wrong for exactly the
 * hostile inputs this function exists to handle, which is the worst possible place to be wrong.
 *
 * ## Encoding is not sufficient — `.` and `..` must be refused
 *
 * OpenSea confirmed this while fixing the same bug in `apiPaths.ts`, and it defeats the obvious fix.
 * `encodeURIComponent` leaves `.` and `..` completely untouched, so they survive encoding and still
 * traverse:
 *
 *     `/api/v2/collections/../stats`  →  `/api/v2/stats`
 *     `/api/v2/collections/./stats`   →  `/api/v2/collections/stats`
 *
 * Percent-encoding the dots does not help either. The WHATWG URL parser decodes percent-escapes
 * *before* it removes dot segments, so `%2E%2E`, `%2e%2e` and `.%2e` all collapse identically.
 * There is no spelling of a bare dot segment that survives as a literal.
 *
 * So they are rejected rather than encoded. Rejection is also sufficient, not merely necessary:
 * after encoding, nothing else is still a dot segment — `"..."` stays `"..."`, and `"%2e%2e"`
 * becomes `"%252e%252e"`. Only the two bare forms need refusing.
 *
 * No legitimate collection slug or address is `.` or `..`, so this costs nothing real.
 */
function segment(value: string): string {
  if (value === "." || value === "..") {
    throw new TypeError(
      `path segment ${JSON.stringify(value)} is a relative path reference and cannot be used — ` +
        "it would traverse to a different endpoint",
    );
  }
  // Deliberately returned unchanged. See the note above the doc comment.
  return value;
}

/** Carries the ttl into `get()` and the freshness metadata back out. See the module comment. */
interface CallScope {
  ttl: number;
  meta?: Omit<CacheEntry<unknown>, "data">;
}
const callScope = new AsyncLocalStorage<CallScope>();

/** Stable cache key: the same query in a different key order must not be a second entry. */
function cacheKey(apiPath: string, query: object | undefined): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? apiPath : `${apiPath}?${JSON.stringify(entries)}`;
}

/** The scheduling half of the transport. Structural so a test can pass a pass-through. */
export interface Scheduler {
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TransportOptions {
  cache: Cache;
  limiter: Scheduler;
}

/**
 * `OpenSeaAPI` with Anchor's transport policy bolted onto the one method every read passes through.
 *
 * Exported so the read-only property can be asserted directly — `opensea.test.ts` calls the SDK's
 * signing and order-building methods on it and requires every one to be refused. Nothing outside
 * `OpenSeaClient` should construct one; it needs a ttl scope to function at all.
 */
export class ReadOnlyOpenSeaAPI extends OpenSeaAPI {
  // Assigned in the constructor body, but the base constructor binds `this.get` before that runs,
  // so nothing may read these until the first call — which is always after construction.
  #transport!: TransportOptions;

  constructor(config: { apiKey: string; authToken?: string }, transport: TransportOptions) {
    super(config);
    this.#transport = transport;
  }

  /**
   * Cache-first GET. A fresh entry short-circuits without touching the network; otherwise the
   * request is scheduled on the shared limiter, and a failure falls back to stale data — a slightly
   * old portfolio beats an error card.
   */
  override async get<T>(apiPath: string, query?: object, options?: RequestOptions) {
    type Result = Awaited<ReturnType<typeof OpenSeaAPI.prototype.get<T>>>;
    const scope = callScope.getStore();
    if (scope === undefined) {
      // Every read must come through OpenSeaClient, which is what supplies the ttl. Reaching the
      // SDK directly would silently bypass the cache and the freshness envelope.
      throw new Error("OpenSea reads must go through OpenSeaClient, not the SDK object directly.");
    }

    const { cache, limiter } = this.#transport;
    const key = cacheKey(apiPath, query);
    const cached = cache.get<Result>(key);
    if (cached && !cached.stale) {
      scope.meta = { fetchedAt: cached.fetchedAt, ageSeconds: cached.ageSeconds, stale: false };
      return cached.data;
    }

    // One deadline for the whole call, retries and backoff included, so a struggling gateway can
    // never hold a widget past it.
    const deadline = AbortSignal.timeout(CALL_DEADLINE_MS);

    try {
      // Each attempt is scheduled separately, and the backoff sleep happens *outside* the limiter.
      // Sleeping while holding a slot would starve every other read on the desktop, queued behind a
      // request that is doing nothing at all.
      //
      // The return type is inferred rather than annotated: the SDK's `Camelize<T>` is a conditional
      // type that `Awaited<>` will not collapse, and `Camelize` is not exported from the SDK root
      // (docs/upstream.md entry 8), so there is no name to write here even if we wanted one.
      const attemptWithRetries = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await limiter.schedule(() =>
              super.get<T>(apiPath, query, {
                ...options,
                timeout: REQUEST_TIMEOUT_MS,
                signal: deadline,
              }),
            );
          } catch (err) {
            if (attempt >= MAX_RETRIES || deadline.aborted || !isRetryable(err)) throw err;
            await sleep(retryDelayMs(attempt), deadline);
          }
        }
      };
      const data = await attemptWithRetries();
      cache.put(key, data, scope.ttl);
      scope.meta = { fetchedAt: Math.floor(Date.now() / 1000), ageSeconds: 0, stale: false };
      return data;
    } catch (err) {
      if (cached) {
        scope.meta = { fetchedAt: cached.fetchedAt, ageSeconds: cached.ageSeconds, stale: true };
        return cached.data; // serve stale rather than nothing
      }
      throw new Error(describeFailure(err));
    }
  }

  /**
   * The read-only property, enforced structurally.
   *
   * Every write in the SDK — order posting, offer building, listing and offer *actions*, swap
   * execution, transfers, drop mints — funnels through `post`/`request`. Refusing them here means
   * no code path in `service/` can construct, sign or submit a transaction even by mistake.
   */
  override async post(apiPath: string, _body?: object, _headers?: object): Promise<never> {
    throw new ReadOnlyViolationError("POST", apiPath);
  }

  override async request(method: never, apiPath: string): Promise<never> {
    throw new ReadOnlyViolationError(String(method), apiPath);
  }
}

export interface ClientOptions {
  /** Configured chains, in order. The first is used by endpoints whose path carries one chain. */
  chains: readonly ChainIdentifier[];
  requestsPerSecond: number;
  cache: Cache;
  /** Supplies the wallet JWT that account-scoped reads additionally require. See auth.ts. */
  walletToken: WalletTokenProvider;
  /** Seam for tests. Defaults to the OS keyring. */
  getApiKey?: () => Promise<string | null>;
}

/**
 * Whether a call needs the API key only, or is account-scoped.
 *
 * There used to be a third, narrower scope for reads believed to require a wallet JWT as a second
 * credential, and those reads were refused up front when no PAT was stored. That belief was wrong —
 * it came from measurements taken with a credential that was actually a shell command, against a
 * control endpoint that turns out to be public. Re-measured with a real API key, every one of them
 * returns 200. See the header of auth.ts.
 *
 * The distinction that remains is only about error messages: an account-scoped call needs a wallet
 * address configured, and saying so beats a bare upstream error.
 */
type Scope = "account" | "public";

export class OpenSeaClient {
  #chains: readonly ChainIdentifier[];
  #cache: Cache;
  #limiter: RateLimiter;
  #walletToken: WalletTokenProvider;
  #getApiKey: () => Promise<string | null>;
  #api: ReadOnlyOpenSeaAPI | null = null;
  #apiFor: { apiKey: string; authToken: string | null } | null = null;

  constructor(opts: ClientOptions) {
    this.#chains = opts.chains;
    this.#cache = opts.cache;
    this.#limiter = new RateLimiter(opts.requestsPerSecond);
    this.#walletToken = opts.walletToken;
    this.#getApiKey = opts.getApiKey ?? getApiKeyFromKeyring;
  }

  /** The chain used by endpoints whose *path* carries a single chain. Documented in docs/chains.md. */
  get primaryChain(): ChainIdentifier {
    return this.#chains[0] ?? "ethereum";
  }

  get chains(): readonly ChainIdentifier[] {
    return this.#chains;
  }

  /**
   * The SDK fixes both credentials at construction, so a refreshed wallet JWT means a new instance.
   * That happens about twice a day; the constructor only allocates.
   */
  async #resolveApi(scope: Scope): Promise<ReadOnlyOpenSeaAPI> {
    const apiKey = await this.#getApiKey();
    if (!apiKey) throw new MissingApiKeyError();

    let authToken: string | null = null;
    if (scope !== "public") {
      // Sent when we have one, never required. No read this service makes needs it.
      authToken = await this.#walletToken.token();
    }

    if (this.#api === null || this.#apiFor?.apiKey !== apiKey || this.#apiFor.authToken !== authToken) {
      this.#api = new ReadOnlyOpenSeaAPI(
        { apiKey, ...(authToken === null ? {} : { authToken }) },
        { cache: this.#cache, limiter: this.#limiter },
      );
      this.#apiFor = { apiKey, authToken };
    }
    return this.#api;
  }

  /**
   * Run one SDK call inside a ttl scope and wrap the result in the freshness envelope.
   *
   * `MissingApiKeyError`, `MissingPatError` and `WalletTokenError` pass through untouched: they
   * name a missing credential rather than quoting one, and the server turns them into a 401 the
   * user can act on.
   */
  async #call<T>(
    ttl: number,
    scope: Scope,
    what: string,
    fn: (api: ReadOnlyOpenSeaAPI) => Promise<T>,
  ): Promise<CacheEntry<T>> {
    const api = await this.#resolveApi(scope);
    const store: CallScope = { ttl };
    let data: T;
    try {
      data = await callScope.run(store, () => fn(api));
    } catch (err) {
      if (err instanceof MissingPatError || err instanceof WalletTokenError) throw err;
      // Deliberately no "you are probably missing a PAT" hint here. That hint was wrong, and a
      // confident wrong diagnosis attached to a real failure costs more than no diagnosis.
      throw err;
    }
    const meta = store.meta ?? { fetchedAt: Math.floor(Date.now() / 1000), ageSeconds: 0, stale: false };
    return { data, ...meta };
  }

  // ---------------------------------------------------------------------------------------------
  // NFTs and collections
  // ---------------------------------------------------------------------------------------------

  /** NFTs owned by an account, on the primary chain. GET /chain/{chain}/account/{address}/nfts */
  nftsByAccount(
    address: string,
    ttl: number,
    opts: { collection?: string; limit?: number; next?: string } = {},
  ) {
    const chain = toSdkChain(this.primaryChain);
    // The SDK's `getNFTsByAccount` has no `collection` filter, though the endpoint documents one,
    // so a collection-scoped request uses `getNFTsByCollection` — which is the same data, filtered
    // server-side by collection rather than by owner.
    return this.#call(ttl, "account", "/portfolio", (api) =>
      opts.collection === undefined
        ? api.getNFTsByAccount(segment(address), opts.limit ?? 50, opts.next, chain)
        : api.getNFTsByCollection(segment(opts.collection), opts.limit ?? 50, opts.next),
    );
  }

  /** Account activity. GET /events/accounts/{address} */
  eventsByAccount(
    address: string,
    ttl: number,
    opts: { eventTypes?: string[]; limit?: number; next?: string } = {},
  ) {
    return this.#call(ttl, "account", "/activity", (api) =>
      api.getEventsByAccount(segment(address), {
        // `GetEventsArgs.eventType` is typed as a single value, but the endpoint takes a repeatable
        // `event_type` and the SDK's query builder already appends arrays element by element. The
        // cast is the type being narrower than the API, not us going around the SDK.
        ...({ eventType: opts.eventTypes } as { eventType?: string }),
        chain: this.primaryChain,
        limit: opts.limit ?? 50,
        next: opts.next,
      }),
    );
  }

  /** GET /collections/{slug} */
  collection(slug: string, ttl: number) {
    return this.#call(ttl, "public", "/collections/:slug", (api) => api.getCollection(segment(slug)));
  }

  /** Floor price, volume, sales. GET /collections/{slug}/stats */
  collectionStats(slug: string, ttl: number) {
    return this.#call(ttl, "public", "/collections/:slug/stats", (api) =>
      api.getCollectionStats(segment(slug)),
    );
  }

  /** GET /listings/collection/{slug}/best */
  bestListings(slug: string, ttl: number, limit = 20) {
    return this.#call(ttl, "public", "/collections/:slug/listings", (api) =>
      api.getBestListings(segment(slug), limit),
    );
  }

  /** GET /offers/collection/{slug} */
  collectionOffers(slug: string, ttl: number, limit = 20) {
    return this.#call(ttl, "public", "/collections/:slug/offers", (api) =>
      api.getCollectionOffers(segment(slug), limit),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Tokens. OpenSea is both marketplaces (docs/tokens.md), and every one of these is chain-aware.
  // ---------------------------------------------------------------------------------------------

  /** Net worth and P&L across every configured chain. GET /account/{address}/portfolio */
  portfolioStats(address: string, ttl: number, timeframe?: "HOUR" | "DAY" | "WEEK" | "MONTH") {
    return this.#call(ttl, "account", "/portfolio/value", (api) =>
      // `PortfolioArgs` omits `chains`, though the endpoint documents and accepts it. The SDK
      // forwards args verbatim to the query builder, so widening the object is enough.
      api.getPortfolioStats(segment(address), {
        ...(timeframe === undefined ? {} : { timeframe }),
        ...({ chains: [...this.#chains] } as object),
      }),
    );
  }

  /** Fungible balances across every configured chain. GET /account/{address}/tokens */
  tokenBalances(address: string, ttl: number, opts: { limit?: number; cursor?: string } = {}) {
    return this.#call(ttl, "account", "/balances", (api) =>
      api.getAccountTokens(segment(address), {
        chains: [...this.#chains],
        limit: opts.limit ?? 50,
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      }),
    );
  }

  /** GET /tokens/trending */
  trendingTokens(ttl: number, limit = 20) {
    return this.#call(ttl, "account", "/tokens/trending", (api) =>
      // As with portfolio: `GetTokensArgs` omits the `chains` the endpoint documents.
      api.getTrendingTokens({ limit, ...({ chains: [...this.#chains] } as object) }),
    );
  }

  /** GET /tokens/top */
  topTokens(ttl: number, limit = 20) {
    return this.#call(ttl, "account", "/tokens/top", (api) =>
      api.getTopTokens({ limit, ...({ chains: [...this.#chains] } as object) }),
    );
  }

  /** One token on the primary chain. GET /chain/{chain}/token/{address} */
  token(address: string, ttl: number) {
    return this.#call(ttl, "public", "/tokens/:address", (api) =>
      api.getToken(this.primaryChain, segment(address)),
    );
  }

  /** Price history on the primary chain. GET /chain/{chain}/token/{address}/price_history */
  tokenPriceHistory(address: string, ttl: number, opts: { startTime: string; endTime?: string }) {
    const chain = toSdkChain(this.primaryChain);
    return this.#call(ttl, "public", "/tokens/:address/price_history", (api) =>
      api.getTokenPriceHistory(chain, segment(address), {
        startTime: opts.startTime,
        ...(opts.endTime === undefined ? {} : { endTime: opts.endTime }),
      }),
    );
  }
}
