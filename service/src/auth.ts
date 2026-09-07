/**
 * OpenSea wallet-token auth.
 *
 * OpenSea auth is not one credential. Measured against the live API with a valid key:
 *
 *   200  /api/v2/collections/{slug}/stats
 *   401  /api/v2/chain/ethereum/account/{addr}/nfts
 *   401  /api/v2/account/{addr}/tokens
 *   401  /api/v2/account/{addr}/portfolio
 *   401  /api/v2/tokens/trending
 *
 * So account-scoped reads need a wallet JWT (`Authorization: Bearer …`) *in addition to* the API
 * key. The JWT lasts about twelve hours and is minted from a scoped personal access token (PAT).
 *
 * Anchor deliberately implements only the last step of that chain. Creating a PAT needs a SIWE
 * signature, which is a one-time human action and sits badly with a read-only service that holds
 * no keys — so the user creates a PAT themselves, stores it with `anchor-service --set-pat`, and
 * this module exchanges it for a JWT and keeps the JWT fresh.
 *
 * ## What is verified and what is not
 *
 * - The 401s above were **measured**.
 * - The exchange request and response shapes are taken from `@opensea/sdk`'s own
 *   `OpenSeaAuth.exchangeScopedToken` (`lib/auth/index.js`) — `POST /api/v2/auth/tokens/exchange`
 *   with `{subjectToken, subjectTokenType: "ACCESS_TOKEN"}`, answered with
 *   `{accessToken, expiresIn?, tokenScopes?}`. That is the SDK's code rather than prose docs, but
 *   **this path has never been run end to end here**, because we have no PAT to test with.
 * - The OpenAPI spec shipped with `@opensea/api-types` declares only `ApiKeyAuth` for every one of
 *   the endpoints that measurably 401, and does not describe `/auth/tokens/exchange` at all. The
 *   spec and the live API disagree; we follow the live API.
 *
 * Raw `fetch` here rather than the SDK: `OpenSeaAuth.getValidToken()` throws unless
 * `authenticate()` ran in the same process with a signer, so the SDK has no PAT-only path even
 * though `exchangeScopedToken` is exactly that and is private.
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
      const hint =
        res.status === 401 || res.status === 403
          ? " — the PAT is expired, revoked, or lacks the scopes this read needs. Re-run: anchor-service --set-pat"
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
