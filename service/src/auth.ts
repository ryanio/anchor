/**
 * OpenSea wallet-token auth. **Not currently required by anything this service calls.**
 *
 * This module was written on a false premise, and the header is worth keeping accurate because the
 * premise was load-bearing for a while.
 *
 * The original claim was that account-scoped reads need a wallet JWT in addition to the API key,
 * "measured, not assumed". The measurement was taken with a credential that was not a credential —
 * the keyring held a shell command, because an interactive prompt read its own command line off a
 * non-TTY stdin — and the control used to prove the key was valid did not test the key at all.
 *
 * That control was `/collections/{slug}/stats` returning 200. OpenSea explained why, and it is not
 * that the endpoint is public: Cloudflare fronts api.opensea.io with a cache key built from the URL,
 * the query string and `Accept`. The API key is not part of that key, and a custom cache key makes
 * Cloudflare ignore the origin's `Vary: X-API-KEY`. So any GET someone has already warmed is served
 * to anyone, including a caller sending no key. That path is popular; our 200 was a cache HIT that
 * never reached the service. The account routes missed cache, reached the origin, and the origin
 * correctly rejected the junk key.
 *
 * Re-measured with a real API key and no `Authorization` header:
 *
 *   200  /api/v2/collections/{slug}/stats
 *   200  /api/v2/chain/ethereum/account/{addr}/nfts
 *   200  /api/v2/account/{addr}/tokens
 *   200  /api/v2/tokens/trending
 *   500  /api/v2/account/{addr}/portfolio   (server-side bug, unrelated to auth; see docs/upstream.md)
 *
 * So every route this service calls needs the API key and nothing else, and the OpenAPI spec —
 * which declares only `ApiKeyAuth` for those operations — was right all along.
 *
 * ## Why this module still exists
 *
 * The spec declares `WalletAuth` on fifty paths that this service does not currently call:
 * favourites, watchlists, profile, saved tools, order cancellation, drops. Anything that writes will
 * need it too. So a wallet token is a real thing Anchor will need — it is simply not the second half
 * of a credential pair required for ordinary reads.
 *
 * Nothing in `server.ts` should gate a route on this. If you find yourself adding a "needs a PAT"
 * refusal to a read path, re-measure first.
 *
 * ## What is verified and what is not
 *
 * - The 200s above were **measured** with a real key.
 * - The exchange request and response shapes are taken from `@opensea/sdk`'s own
 *   `OpenSeaAuth.exchangeScopedToken` (`lib/auth/index.js:145`) — `POST /api/v2/auth/tokens/exchange`
 *   with `{subjectToken, subjectTokenType: "ACCESS_TOKEN"}`, answered with
 *   `{accessToken, expiresIn?, tokenScopes?}`. That is the SDK's code rather than prose docs, and
 *   **this path has still never been run end to end**, because no route we call needs it.
 * - `/auth/tokens/exchange` is absent from the OpenAPI spec entirely.
 *
 * Raw `fetch` here rather than the SDK: `OpenSeaAuth.getValidToken()` throws unless
 * `authenticate()` ran in the same process with a signer, so the SDK has no PAT-only path even
 * though `exchangeScopedToken` is exactly that and is private.
 *
 * The obvious alternative does not work either. `OpenSeaOAuth` exposes a device authorization flow
 * (`requestDeviceAuthorization` + `pollDeviceToken`) which is exactly the right shape for a headless
 * desktop client — but OpenSea has confirmed third-party clients cannot use OAuth yet, so there is
 * no client ID for an application like this one. Until that opens up, or `exchangeScopedToken`
 * becomes public, reimplementing a private method is the only route to a wallet token. See
 * docs/upstream.md entry 11; delete this module when either lands.
 */

const EXCHANGE_PATH = "/api/v2/auth/tokens/exchange";
const DEFAULT_BASE_URL = "https://api.opensea.io";
/** The SDK assumes an hour when the server omits `expiresIn`; match it rather than guess higher. */
const DEFAULT_TTL_SECONDS = 3600;
/** Refresh this far ahead of expiry, so a long-running request never carries a token that dies. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class MissingPatError extends Error {
  constructor(what: string) {
    super(
      `${what} needs an OpenSea wallet token, which Anchor mints from a personal access token. ` +
        "No PAT is in the keyring. Create one at https://docs.opensea.io/reference/auth and run: " +
        "anchor-service --set-pat",
    );
    this.name = "MissingPatError";
  }
}

export class WalletTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletTokenError";
  }
}

interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface WalletTokenOptions {
  /** Seam for tests. Defaults to the OS keyring. */
  getPat?: () => Promise<string | null>;
  /** Seam for tests. Defaults to the global `fetch`; production never passes this. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiBaseUrl?: string;
}

/**
 * Holds a wallet JWT, exchanging the stored PAT for a new one before the old one expires.
 *
 * Concurrent callers share one exchange: six widgets waking at once must not mint six tokens.
 */
export class WalletTokenProvider {
  #getPat: () => Promise<string | null>;
  #fetch: typeof fetch;
  #now: () => number;
  #baseUrl: string;
  #cached: CachedToken | null = null;
  #inFlight: Promise<CachedToken> | null = null;

  constructor(opts: WalletTokenOptions = {}) {
    this.#getPat = opts.getPat ?? (async () => null);
    this.#fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = opts.now ?? (() => Date.now());
    this.#baseUrl = opts.apiBaseUrl ?? DEFAULT_BASE_URL;
  }

  /** True when a PAT is stored, so `/health` can say why account routes are refusing. */
  async available(): Promise<boolean> {
    return (await this.#getPat()) !== null;
  }

  /**
   * A valid wallet JWT, or `null` when no PAT is stored. Callers turn `null` into
   * {@link MissingPatError} at the point where they know which route the user asked for.
   */
  async token(): Promise<string | null> {
    if (this.#cached && this.#cached.expiresAt - this.#now() > REFRESH_MARGIN_MS) {
      return this.#cached.accessToken;
    }
    const pat = await this.#getPat();
    if (pat === null) return null;

    this.#inFlight ??= this.#exchange(pat).finally(() => {
      this.#inFlight = null;
    });
    const fresh = await this.#inFlight;
    this.#cached = fresh;
    return fresh.accessToken;
  }

  /**
   * POST the PAT and receive a JWT.
   *
   * Every error message here is built from a status code, never from the response body: a token
   * exchange is the one request whose body is most likely to quote the credential back.
   */
  async #exchange(pat: string): Promise<CachedToken> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${EXCHANGE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ subjectToken: pat, subjectTokenType: "ACCESS_TOKEN" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error && /^[A-Za-z]+$/.test(err.name) ? err.name : "Error";
      throw new WalletTokenError(`OpenSea token exchange failed (${name})`);
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // A 403 here is deliberately opaque upstream: an unknown, revoked, rotated or non-scoped
      // token and a disabled integration all return the same "Token exchange is not available".
      // So the message says what to try, and does not pretend to know which of those it was — a
      // confident wrong diagnosis attached to a real failure sends people down the wrong path.
      // 422 covers malformed JSON, a missing field and an unsupported subjectTokenType; 400 is a
      // validation failure such as a subjectToken outside 10–8192 characters.
      const hint =
        res.status === 401 || res.status === 403
          ? " — the token was not accepted, and the reason is not distinguishable from here. " +
            "Check it is a current scoped token, then re-run: anchor-service --set-pat"
          : res.status === 400 || res.status === 422
            ? " — the request or the token was malformed rather than rejected. Re-run: anchor-service --set-pat"
            : "";
      throw new WalletTokenError(`OpenSea token exchange rejected the PAT (${res.status})${hint}`);
    }

    let body: { accessToken?: unknown; expiresIn?: unknown };
    try {
      body = (await res.json()) as { accessToken?: unknown; expiresIn?: unknown };
    } catch {
      throw new WalletTokenError("OpenSea token exchange returned a malformed JSON body");
    }

    if (typeof body.accessToken !== "string" || body.accessToken.length === 0) {
      throw new WalletTokenError("OpenSea token exchange returned no access token");
    }
    const ttl =
      typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : DEFAULT_TTL_SECONDS;
    return { accessToken: body.accessToken, expiresAt: this.#now() + ttl * 1000 };
  }
}

export { EXCHANGE_PATH };
