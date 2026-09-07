/**
 * The local API. Binds 127.0.0.1 only — never the LAN, never the tailnet (docs/security.md).
 *
 * Read-only by construction: only GET and HEAD are routed, so a bug in a handler cannot become a write.
 *
 * Every response carries a `meta` block with fetch time, age, and staleness, so consumers can show
 * data freshness rather than implying everything is live.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CacheEntry } from "./cache.ts";
import type { Config } from "./config.ts";
import { MissingApiKeyError, type OpenSeaClient } from "./opensea.ts";

const HOST = "127.0.0.1";

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

export function createApp(config: Config, client: OpenSeaClient) {
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
            wallet: config.wallet || null,
            chain: config.chain,
            collections: config.collections,
          },
          headOnly,
        );
        return;
      }

      if (!config.wallet && (path === "/portfolio" || path === "/activity")) {
        send(
          res,
          428,
          {
            error: "No wallet configured. Set `wallet` in the config file.",
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
          envelope(await client.nftsByAccount(config.wallet, config.ttl.nfts, { collection })),
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
            await client.eventsByAccount(config.wallet, config.ttl.events, {
              eventTypes: types.length ? types : undefined,
            }),
          ),
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
            results.push({ slug, ...envelope(await client.collectionStats(slug, config.ttl.stats)) });
          } catch (err) {
            if (err instanceof MissingApiKeyError) throw err;
            results.push({ slug, error: (err as Error).message });
          }
        }
        send(res, 200, { data: results, meta: { count: results.length } }, headOnly);
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

      send(
        res,
        404,
        {
          error: "Not found",
          routes: [
            "/health",
            "/portfolio",
            "/activity",
            "/collections",
            "/collections/:slug",
            "/collections/:slug/stats",
            "/collections/:slug/listings",
            "/collections/:slug/offers",
          ],
        },
        headOnly,
      );
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        send(res, 401, { error: err.message }, headOnly);
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

export { HOST, hostAllowed };
