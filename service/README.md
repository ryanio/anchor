# service

Anchor's local read-only data service. **Step 1 of the roadmap** — everything else reads from here,
so the whole desktop shares one cache, one rate limit, and one place where data freshness is tracked.

## Design

- **Zero runtime dependencies.** Node's built-in `node:sqlite`, `node:http`, and native TypeScript
  execution mean no build step and no native modules — which keeps the Arch package trivial.
- **Read-only by construction.** Anything that is not a `GET` is refused before routing, so a bug in a
  handler cannot become a write.
- **Loopback only.** Binds `127.0.0.1`. Never the LAN, never the tailnet.
- **The API key lives in the OS keyring**, via libsecret. It is never written to config, never logged,
  and never passed in argv.
- **Freshness is explicit.** Every response carries `meta.fetchedAt`, `meta.ageSeconds`, and
  `meta.stale`. If the network fails, cached data is served with `stale: true` rather than an error.

## Running

```bash
node src/index.ts                # start
node src/index.ts --set-api-key  # store the OpenSea key in the keyring (reads stdin, not argv)
```

Config is written on first run to `~/.config/anchor/config.json`. It holds no secrets, so it is safe
to paste into an issue:

```json
{
  "chain": "ethereum",
  "wallet": "0x...",
  "collections": ["your-collection-slug"],
  "port": 8787,
  "ttl": { "nfts": 300, "events": 60, "stats": 120, "listings": 120, "offers": 60 },
  "requestsPerSecond": 2
}
```

## Endpoints

| Route | What |
|---|---|
| `GET /health` | Liveness plus resolved config. No network call, safe to poll |
| `GET /portfolio` | NFTs owned by the configured wallet. `?collection=slug` |
| `GET /activity` | Account events. `?event_type=` repeatable (sale, transfer, offer, …) |
| `GET /collections` | Stats for every watched collection in one call |
| `GET /collections/:slug` | Collection metadata |
| `GET /collections/:slug/stats` | Floor, volume, sales |
| `GET /collections/:slug/listings` | Best listings |
| `GET /collections/:slug/offers` | Collection offers |

Upstream paths are OpenSea API v2, verified against `docs.opensea.io`.

## Development

```bash
npm install      # dev only: @types/node + typescript
npm run typecheck
```
