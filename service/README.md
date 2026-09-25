# service

Anchor's local read-only data service. **Step 1 of the roadmap** — everything else reads from here,
so the whole desktop shares one cache, one rate limit, and one place where data freshness is tracked.

## Design

- **Built on OpenSea's own packages.** `@opensea/sdk` makes the calls and `@opensea/api-types` types
  the responses. Those are the only two runtime dependencies, and they replaced a hand-rolled client
  that returned `unknown` everywhere and had two endpoint paths wrong. Everything else is Node's
  built-in `node:sqlite`, `node:http`, and native TypeScript execution — no build step, no native
  modules, which keeps the Arch package simple.
- **Read-only by construction, at both ends.** Anything that is not a `GET` or `HEAD` is refused
  before routing, and the SDK's `post`/`request` are overridden to throw, so no code path here can
  construct, sign or submit a transaction. Order building, swap execution and transfers fail at the
  transport. Signing lives in the executor.
- **We keep the cache, the rate limit and the freshness envelope.** The SDK does not provide them.
  Every read funnels through one overridden `get()`, which is where they live.
- **Loopback only.** Binds `127.0.0.1`. Never the LAN, never the tailnet.
- **Credentials live in the OS keyring**, via libsecret. Never in config, never logged, never in argv.
- **Freshness is explicit.** Every response carries `meta.fetchedAt`, `meta.ageSeconds`, and
  `meta.stale`. If the network fails, cached data is served with `stale: true` rather than an error.

## Credentials

Every read this service makes needs one credential, the **API key**, sent as `x-api-key`. Measured
with a real key and no `Authorization` header:

```
200  /api/v2/collections/{slug}/stats
200  /api/v2/chain/ethereum/account/{addr}/nfts
200  /api/v2/account/{addr}/tokens
200  /api/v2/tokens/trending
500  /api/v2/account/{addr}/portfolio   (server-side bug, unrelated to auth; see docs/upstream.md)
```

A wallet **personal access token (PAT)** is optional. When one is stored (`--set-pat`), the service
exchanges it for a wallet JWT and sends that with account-scoped reads, but no read requires it and
no route refuses without it. A stored PAT that OpenSea rejects does fail account routes, with a 401
naming `--set-pat`. It also supplies wallets: when `wallets` in the config is empty, the
service reads the addresses the token names. The header of `src/auth.ts` has the measurement, what
is verified about the exchange, and why the module still exists.

`GET /health` reports which credentials are present, and so does the startup line. Presence is not
proof: `anchor-service --check-credentials` makes a live call that 401s without a valid key.

## Running

The service is meant to be a systemd **user** unit, not a command a person types. That is what lets
the bar widget's first setup step be a button instead of a `node …` string to copy:

```bash
systemctl --user start anchor-service          # this session
systemctl --user enable --now anchor-service   # and every one after it
systemctl --user status anchor-service         # why it did not start
```

By hand, which is also what the unit runs:

```bash
node src/index.ts                # start
node src/index.ts --set-api-key  # store the OpenSea API key   (reads stdin, not argv)
node src/index.ts --set-pat      # store the OpenSea PAT       (reads stdin, not argv)
```

### Installing the unit

```bash
anchor-service --install-service      # or: node service/src/index.ts --install-service
```

That is the whole thing, and it is idempotent — running it twice is how you check whether you ran it
once. `--uninstall-service` reverses it.

It does one of two things:

- **Packaged**, `/usr/lib/systemd/user/anchor-service.service` is already there, so nothing is
  written and the unit is enabled where it lies. A hand-written copy in `~/.config` would shadow it
  and keep running last month's service after an upgrade, so one is removed if found.
- **From a checkout**, a unit is written to `~/.config/systemd/user/` with `ExecStart` repointed at
  this file, through the `node` that is running it. Both paths absolute: a unit is not started from a
  shell and inherits no PATH worth relying on. Re-run it after moving the checkout.

Either way it ends in `systemctl --user enable --now`, and **`enable` is the word that matters** —
the instructions this replaced ended in `start`, which is this session only. That is why setups
worked until the first reboot and then quietly did not.

`--experimental-strip-types` appears in the ExecStart written from a checkout because the service
runs its TypeScript directly from source. A packaged build compiles it and the packaged unit carries
no such flag.

The widget probes `systemctl --user show anchor-service.service` and only offers the button when
`LoadState=loaded`; without the unit it falls back to showing the command. So a machine with no unit
installed degrades to what shipped before rather than to a button that does nothing.

The unit's hardening is deliberately partial and the omissions are documented in the file itself —
`ProtectHome` and `ProtectSystem=strict` are absent because the service reads
`~/.config/anchor/config.json` and writes a cache under `$XDG_DATA_HOME`, and the loopback-only bind
is enforced in `src/server.ts` where it can be tested rather than in a unit directive.

Config is written on first run to `~/.config/anchor/config.json`. It holds no secrets, so it is safe
to paste into an issue:

```json
{
  "chains": ["ethereum"],
  "wallets": ["0x...", "0x..."],
  "collections": ["your-collection-slug"],
  "tokens": [],
  "port": 8787,
  "ttl": {
    "nfts": 300, "events": 60, "stats": 120, "listings": 120,
    "offers": 60, "portfolio": 120, "tokens": 30, "prices": 30
  },
  "requestsPerSecond": 2
}
```

`wallets` is a list and every entry is watched. The older `wallet: "0x…"` is still read, as a
one-element list, the same way `chain` is read as a one-element `chains`. When the list is empty
and a wallet PAT is stored, the service watches the wallets that token names (its `wallet` claim,
or the `linked_wallets` of the JWT it exchanges for); config always wins over the token. No endpoint
maps a person to their addresses, so without either, nothing is discovered.

`chains` is validated against OpenSea's own chain union, so a typo fails at load with a suggestion
rather than a 400 later. The older single `"chain": "base"` string still works and is read as a
one-element list. Wallet and token addresses are checked against the configured chains — EVM is
`0x` + 40 hex, Solana is base58 decoding to 32 bytes — so a mismatch is caught at startup.
See [../docs/chains.md](../docs/chains.md).

## Endpoints

| Route | What |
|---|---|
| `GET /health` | Liveness, resolved config, configured chains, which credentials are present |
| `GET /portfolio` | NFTs owned by the configured wallet. `?collection=slug` |
| `GET /portfolio/value` | Net worth and P&L across every configured chain. `?timeframe=HOUR\|DAY\|WEEK\|MONTH` |
| `GET /portfolio/history` | Portfolio value over time, for the first configured wallet. `?timeframe=` |
| `GET /balances` | Fungible balances across every configured chain. `?limit=`, `?cursor=` |
| `GET /activity` | Account events. `?event_type=` repeatable (sale, transfer, offer, …) |
| `GET /collections` | Stats for every watched collection in one call |
| `GET /collections/trending` | Trending collections. `?limit=`, `?timeframe=`, `?category=` |
| `GET /collections/top` | Top collections. `?limit=`, `?sort_by=`, `?category=` |
| `GET /collections/:slug` | Collection metadata |
| `GET /collections/:slug/stats` | Floor, volume, sales |
| `GET /collections/:slug/listings` | Best listings |
| `GET /collections/:slug/offers` | Collection offers |
| `GET /collections/:slug/holders` | Collection holders |
| `GET /tokens` | Metadata for every watched token in one call |
| `GET /tokens/trending` | Trending tokens across every configured chain. `?limit=` |
| `GET /tokens/top` | Top tokens across every configured chain. `?limit=` |
| `GET /tokens/:address` | One token, on the first configured chain |
| `GET /tokens/:address/price_history` | `?start_time=`, `?end_time=`. Defaults to the last day |
| `GET /tokens/:address/holders` | Token holders. `?limit=`, `?cursor=`, `?chain=` |
| `GET /tokens/:address/activity` | Token trade activity. `?limit=`, `?cursor=`, `?chain=` |
| `GET /tokens/:address/activity_stats` | Token activity totals. `?chain=` |

Endpoints whose *path* carries a chain use the **first** configured chain; endpoints that take a
`chains` list get all of them. `/health` reports which is which as `primaryChain`.

Upstream paths come from `@opensea/sdk`, not from this repository.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests replace `globalThis.fetch` rather than injecting a client, because the SDK offers no transport
seam — which turns out to be useful: they assert the URL the SDK actually builds.
