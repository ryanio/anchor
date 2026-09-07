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

## Credentials — there are two

OpenSea auth is not a single API key, and this is the most likely reason a fresh install returns 401
on half its routes.

| Credential | Header | Needed for |
|---|---|---|
| **API key** | `x-api-key` | Everything. Public REST and quota |
| **Wallet JWT** | `Authorization: Bearer …` | Account-scoped reads, *in addition to* the API key |

Measured against the live API with a valid key and no wallet token:

```
200  /api/v2/collections/{slug}/stats
401  /api/v2/chain/ethereum/account/{addr}/nfts
401  /api/v2/account/{addr}/tokens
401  /api/v2/account/{addr}/portfolio
401  /api/v2/tokens/trending
```

The JWT lasts about twelve hours and is minted from a **personal access token (PAT)**. Anchor stores
the PAT and exchanges it for a JWT automatically, refreshing before expiry. It does *not* implement
the SIWE flow that creates a PAT in the first place: that needs a wallet signature, which is a
one-time human action and sits badly with a service that holds no keys. Create the PAT yourself —
see [docs.opensea.io/reference/auth](https://docs.opensea.io/reference/auth) — and store it.

Without a PAT, account routes fail with a message naming `--set-pat` **before** any network call,
rather than passing a bare 401 through. `GET /health` reports which credentials are present, and so
does the startup line.

> **Unverified.** The exchange itself has never been run end to end here, because we have no PAT to
> test with. The request and response shapes are taken from `@opensea/sdk`'s own
> `OpenSeaAuth.exchangeScopedToken` (`POST /api/v2/auth/tokens/exchange` with
> `{subjectToken, subjectTokenType: "ACCESS_TOKEN"}` → `{accessToken, expiresIn, tokenScopes}`), which
> is code rather than prose, but is still not a live call. Note also that the OpenAPI spec shipped
> with `@opensea/api-types` declares only `ApiKeyAuth` for every endpoint that measurably 401s, and
> does not describe the exchange endpoint at all — the spec and the live API disagree, and this
> follows the live API.

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

Packaged, `packaging/anchor-service.service` lands at `/usr/lib/systemd/user/` and names
`/usr/bin/anchor-service`. **That wrapper does not exist yet** — see the TODO in `packaging/PKGBUILD`
— so until Anchor is packaged the unit has to be written against a checkout:

```bash
mkdir -p ~/.config/systemd/user
sed "s|ExecStart=.*|ExecStart=$(command -v node) $PWD/service/src/index.ts|" \
  packaging/anchor-service.service > ~/.config/systemd/user/anchor-service.service
systemctl --user daemon-reload
systemctl --user start anchor-service
```

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
  "wallet": "0x...",
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
| `GET /balances` | Fungible balances across every configured chain. `?limit=`, `?cursor=` |
| `GET /activity` | Account events. `?event_type=` repeatable (sale, transfer, offer, …) |
| `GET /collections` | Stats for every watched collection in one call |
| `GET /collections/:slug` | Collection metadata |
| `GET /collections/:slug/stats` | Floor, volume, sales |
| `GET /collections/:slug/listings` | Best listings |
| `GET /collections/:slug/offers` | Collection offers |
| `GET /tokens` | Metadata for every watched token in one call |
| `GET /tokens/trending` | Trending tokens across every configured chain. `?limit=` |
| `GET /tokens/top` | Top tokens across every configured chain. `?limit=` |
| `GET /tokens/:address` | One token, on the first configured chain |
| `GET /tokens/:address/price_history` | `?start_time=`, `?end_time=`. Defaults to the last day |

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
