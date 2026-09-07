/**
 * The local API. Binds 127.0.0.1 only — never the LAN, never the tailnet (docs/security.md).
 *
 * Read-only by construction: anything that is not a GET is refused before routing, so a bug in a
 * handler cannot turn into a write.
 *
 * Every response carries a `meta` block with fetch time, age, and staleness, so consumers can show
 * data freshness rather than implying everything is live.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { OpenSeaClient, MissingApiKeyError } from "./opensea.ts";
import type { CacheEntry } from "./cache.ts";

const HOST = "127.0.0.1";

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
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
    // Read-only gate, before any routing.
    if (req.method !== "GET") {
      send(res, 405, { error: "Anchor's data service is read-only. Only GET is accepted." });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // GET /health — no network, safe to poll.
      if (path === "/health") {
        send(res, 200, {
          ok: true,
          wallet: config.wallet || null,
          chain: config.chain,
          collections: config.collections,
        });
        return;
      }

      if (!config.wallet && (path === "/portfolio" || path === "/activity")) {
        send(res, 428, {
          error: "No wallet configured. Set `wallet` in the config file.",
          config: "~/.config/anchor/config.json",
        });
        return;
      }

      // GET /portfolio — NFTs owned by the configured wallet.
      if (path === "/portfolio") {
        const collection = url.searchParams.get("collection") ?? undefined;
        send(res, 200, envelope(await client.nftsByAccount(config.wallet, config.ttl.nfts, { collection })));
        return;
      }

      // GET /activity — account events. ?event_type= repeatable.
      if (path === "/activity") {
        const types = url.searchParams.getAll("event_type");
        send(res, 200, envelope(
          await client.eventsByAccount(config.wallet, config.ttl.events, {
            eventTypes: types.length ? types : undefined,
          }),
        ));
        return;
      }

      // GET /collections — stats for every watched collection, in one call.
      if (path === "/collections") {
        const results = await Promise.all(
          config.collections.map(async (slug) => {
            try {
              return { slug, ...envelope(await client.collectionStats(slug, config.ttl.stats)) };
            } catch (err) {
              return { slug, error: (err as Error).message };
            }
          }),
        );
        send(res, 200, { data: results, meta: { count: results.length } });
        return;
      }

      // GET /collections/:slug{,/stats,/listings,/offers}
      const match = /^\/collections\/([^/]+)(?:\/(stats|listings|offers))?$/.exec(path);
      if (match) {
        const slug = decodeURIComponent(match[1]!);
        switch (match[2]) {
          case "stats":
            send(res, 200, envelope(await client.collectionStats(slug, config.ttl.stats)));
            return;
          case "listings":
            send(res, 200, envelope(await client.bestListings(slug, config.ttl.listings)));
            return;
          case "offers":
            send(res, 200, envelope(await client.collectionOffers(slug, config.ttl.offers)));
            return;
          default:
            send(res, 200, envelope(await client.collection(slug, config.ttl.stats)));
            return;
        }
      }

      send(res, 404, {
        error: "Not found",
        routes: ["/health", "/portfolio", "/activity", "/collections", "/collections/:slug",
                 "/collections/:slug/stats", "/collections/:slug/listings", "/collections/:slug/offers"],
      });
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        send(res, 401, { error: err.message });
        return;
      }
      send(res, 502, { error: (err as Error).message });
    }
  });
}

export { HOST };
