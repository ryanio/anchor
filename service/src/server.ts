/**
 * The local API. Binds 127.0.0.1 only — never the LAN, never the tailnet (docs/security.md).
 *
 * Read-only by construction, at both ends: only GET and HEAD are routed inbound, and the OpenSea
 * client refuses every outbound write (see opensea.ts), so a bug in a handler cannot become a write.
 *
 * Every response carries a `meta` block with fetch time, age, and staleness, so consumers can show
 * data freshness rather than implying everything is live.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MissingPatError, WalletTokenError } from "./auth.ts";
import type { CacheEntry } from "./cache.ts";
import type { Config } from "./config.ts";
import { MissingApiKeyError, type OpenSeaClient } from "./opensea.ts";
import type { WalletSource } from "./wallet-token.ts";

const HOST = "127.0.0.1";

/** A day of price history is the useful default for a bar widget; callers can widen it. */
const DEFAULT_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ROUTES = [
  "/health",
  "/portfolio",
  "/portfolio/value",
  "/portfolio/history",
  "/balances",
  "/activity",
  "/collections",
  "/collections/:slug",
  "/collections/:slug/stats",
  "/collections/:slug/listings",
  "/collections/:slug/offers",
  "/tokens",
  "/tokens/trending",
  "/tokens/top",
  "/tokens/:address",
  "/tokens/:address/price_history",
];

/** Routes that read the configured wallet, and so need one configured. */
const WALLET_ROUTES = new Set([
  "/portfolio",
  "/portfolio/value",
  "/portfolio/history",
  "/balances",
  "/activity",
]);

export interface ServerDeps {
  /** Which credentials are present. Local only — no network call, so `/health` stays cheap. */
  credentials?: () => Promise<{ apiKey: boolean; pat: boolean }>;
  /** Where `config.wallets` came from, so a caller can tell a typed address from a derived one. */
  walletSource?: WalletSource;
  /** Why no wallet was derived, when none was. Never contains the token. */
  walletDetail?: string;
}

/**
 * Binding to loopback stops the network reaching us; it does not stop a *browser* reaching us.
 * A page on attacker.example whose DNS rebinds to 127.0.0.1 becomes same-origin with this service
 * and can read the wallet inventory. Requiring a loopback Host header closes that, because the
 * rebound request still carries the attacker's hostname.
 */
function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return true; // HTTP/1.0 without Host
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function send(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  // RFC 9110: HEAD is GET without a body. Headers must otherwise match.
  headOnly ? res.end() : res.end(payload);
}

function envelope<T>(entry: CacheEntry<T>) {
  return {
    data: entry.data,
    meta: {
      fetchedAt: new Date(entry.fetchedAt * 1000).toISOString(),
      ageSeconds: entry.ageSeconds,
      stale: entry.stale,
    },
  };
}

/** A positive integer query param, or undefined. A bad value is ignored rather than fatal. */
function intParam(value: string | null, max: number): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
}

export function createApp(config: Config, client: OpenSeaClient, deps: ServerDeps = {}) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headOnly = req.method === "HEAD";

    // Read-only gate, before any routing. HEAD is read-only too — refusing it breaks curl -I,
    // health checkers and systemd readiness probes for no security gain.
    if (req.method !== "GET" && !headOnly) {
      send(res, 405, { error: "Anchor's data service is read-only. Only GET and HEAD are accepted." });
      return;
    }

    if (!hostAllowed(req)) {
      send(res, 403, { error: "Unrecognised Host header." }, headOnly);
      return;
    }

    try {
      // Parsing is inside the try: Node passes absolute-form request targets through verbatim, so a
      // malformed one (`GET http://[ HTTP/1.1`) throws here. Outside the try that became an
      // unhandled rejection and killed the process — one 22-byte request took the service down.
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health") {
        send(
          res,
          200,
          {
            ok: true,
            // Both spellings. `wallets` is the truth; `wallet` is its first element, kept so a
            // widget or script written against the singular keeps working.
            wallets: config.wallets,
            wallet: config.wallets[0] ?? null,
            chains: config.chains,
            /** The chain used by endpoints whose path carries one. See docs/chains.md. */
            primaryChain: config.chains[0],
            collections: config.collections,
            tokens: config.tokens,
            credentials: (await deps.credentials?.()) ?? { apiKey: false, pat: false },
            /**
             * Provenance, not reassurance. A wallet derived from the PAT is not wrong, but it is a
             * different claim from one the user typed, and a reader cannot check a number whose
             * source is unstated (`theme/README.md` principle 6).
             */
            walletSource: deps.walletSource ?? "config",
            ...(deps.walletDetail ? { walletDetail: deps.walletDetail } : {}),
          },
          headOnly,
        );
        return;
      }

      const primaryWallet = config.wallets[0] ?? "";

      if (!primaryWallet && WALLET_ROUTES.has(path)) {
        send(
          res,
          428,
          {
            error: "No wallet configured. Add one to `wallets` in the config file.",
            config: "~/.config/anchor/config.json",
          },
          headOnly,
        );
        return;
      }

      if (path === "/portfolio") {
        const collection = url.searchParams.get("collection") ?? undefined;
        send(
          res,
          200,
          envelope(await client.nftsByAccount(primaryWallet, config.ttl.nfts, { collection })),
          headOnly,
        );
        return;
      }

      if (path === "/portfolio/value") {
        const timeframe = url.searchParams.get("timeframe");
        const allowed = ["HOUR", "DAY", "WEEK", "MONTH"] as const;
        const chosen = allowed.find((t) => t === timeframe);
        send(
          res,
          200,
          envelope(await client.portfolioStats(primaryWallet, config.ttl.portfolio, chosen)),
          headOnly,
        );
        return;
      }

      if (path === "/portfolio/history") {
        const timeframe = url.searchParams.get("timeframe");
        const allowed = ["HOUR", "DAY", "WEEK", "MONTH"] as const;
        const chosen = allowed.find((t) => t === timeframe);
        send(
          res,
          200,
          envelope(await client.portfolioHistory(primaryWallet, config.ttl.portfolio, chosen)),
          headOnly,
        );
        return;
      }

      if (path === "/balances") {
        send(
          res,
          200,
          envelope(
            await client.tokenBalances(primaryWallet, config.ttl.tokens, {
              limit: intParam(url.searchParams.get("limit"), 200),
              cursor: url.searchParams.get("cursor") ?? undefined,
            }),
          ),
          headOnly,
        );
        return;
      }

      if (path === "/activity") {
        const types = url.searchParams.getAll("event_type");
        send(
          res,
          200,
          envelope(
            await client.eventsByAccount(primaryWallet, config.ttl.events, {
              eventTypes: types.length ? types : undefined,
            }),
          ),
          headOnly,
        );
        return;
      }

      if (path === "/tokens/trending" || path === "/tokens/top") {
        const limit = intParam(url.searchParams.get("limit"), 100) ?? 20;
        const entry =
          path === "/tokens/trending"
            ? await client.trendingTokens(config.ttl.tokens, limit)
            : await client.topTokens(config.ttl.tokens, limit);
        send(res, 200, envelope(entry), headOnly);
        return;
      }

      // Metadata for every watched token, in one call. Mirrors /collections; a missing API key or
      // PAT is a whole-service condition, not a per-token one, so it is rethrown rather than
      // reported per row.
      if (path === "/tokens") {
        const results: Array<{ address: string } & Record<string, unknown>> = [];
        for (const address of config.tokens) {
          try {
            results.push({ address, ...envelope(await client.token(address, config.ttl.tokens)) });
          } catch (err) {
            if (isCredentialError(err)) throw err;
            results.push({ address, error: (err as Error).message });
          }
        }
        send(
          res,
          200,
          { data: results, meta: { count: results.length, chain: client.primaryChain } },
          headOnly,
        );
        return;
      }

      // Stats for every watched collection. A missing API key is a whole-service condition, not a
      // per-slug one — swallowing it here returned 200 with error strings, and a widget checking
      // res.ok rendered "no collections" instead of prompting for a key.
      if (path === "/collections") {
        const results: Array<{ slug: string } & Record<string, unknown>> = [];
        for (const slug of config.collections) {
          try {
            const stats = envelope(await client.collectionStats(slug, config.ttl.stats));
            // The collection's own display name, so consumers can stop showing people a slug.
            // Secondary and non-fatal: the floor is what this route is for, and a row that has a
            // price but no name is far better than one with neither. Cached at the same ttl, and a
            // name changes about as often as a collection is renamed, which is never.
            let name: string | null = null;
            try {
              const info = (await client.collection(slug, config.ttl.stats)).data as {
                name?: unknown;
              };
              if (typeof info?.name === "string" && info.name !== "") name = info.name;
            } catch (nameErr) {
              if (isCredentialError(nameErr)) throw nameErr;
            }
            results.push({ slug, name, ...stats });
          } catch (err) {
            if (isCredentialError(err)) throw err;
            results.push({ slug, name: null, error: (err as Error).message });
          }
        }
        send(res, 200, { data: results, meta: { count: results.length } }, headOnly);
        return;
      }

      const tokenMatch = /^\/tokens\/([^/]+)(?:\/(price_history))?$/.exec(path);
      if (tokenMatch) {
        const address = decodeURIComponent(tokenMatch[1]!);
        if (tokenMatch[2] === "price_history") {
          const startTime =
            url.searchParams.get("start_time") ??
            new Date(Date.now() - DEFAULT_PRICE_WINDOW_MS).toISOString();
          const endTime = url.searchParams.get("end_time") ?? undefined;
          send(
            res,
            200,
            envelope(await client.tokenPriceHistory(address, config.ttl.prices, { startTime, endTime })),
            headOnly,
          );
          return;
        }
        send(res, 200, envelope(await client.token(address, config.ttl.tokens)), headOnly);
        return;
      }

      const match = /^\/collections\/([^/]+)(?:\/(stats|listings|offers))?$/.exec(path);
      if (match) {
        const slug = decodeURIComponent(match[1]!);
        switch (match[2]) {
          case "stats":
            send(res, 200, envelope(await client.collectionStats(slug, config.ttl.stats)), headOnly);
            return;
          case "listings":
            send(res, 200, envelope(await client.bestListings(slug, config.ttl.listings)), headOnly);
            return;
          case "offers":
            send(res, 200, envelope(await client.collectionOffers(slug, config.ttl.offers)), headOnly);
            return;
          default:
            send(res, 200, envelope(await client.collection(slug, config.ttl.stats)), headOnly);
            return;
        }
      }

      send(res, 404, { error: "Not found", routes: ROUTES }, headOnly);
    } catch (err) {
      if (isCredentialError(err)) {
        send(res, 401, { error: (err as Error).message }, headOnly);
        return;
      }
      if (err instanceof TypeError && /Invalid URL/i.test((err as Error).message)) {
        send(res, 400, { error: "Malformed request URL." }, headOnly);
        return;
      }
      send(res, 502, { error: (err as Error).message }, headOnly);
    }
  });
}

/**
 * A missing or rejected credential is a whole-service condition: it does not become better on the
 * next slug, and answering 200 with an error string per row hides it from anything checking res.ok.
 */
function isCredentialError(err: unknown): boolean {
  return (
    err instanceof MissingApiKeyError || err instanceof MissingPatError || err instanceof WalletTokenError
  );
}

export { HOST, hostAllowed, ROUTES };
