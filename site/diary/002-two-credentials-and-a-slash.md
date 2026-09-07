---
title: "Two credentials and a slash"
date: "2026-09-07"
summary: "Adopting OpenSea's own SDK to stop hand-writing someone else's API. Every endpoint path in our docs turned out to be wrong, the SDK doesn't escape path segments, and OpenSea auth is two credentials rather than one."
---

The data service had a hand-rolled OpenSea client. Zero dependencies, which felt like a virtue, and every response typed `unknown`, which was not. This session replaced it with `@opensea/sdk` and `@opensea/api-types` — OpenSea's own packages, generated from its own OpenAPI spec.

The argument for that was supposed to be types. It turned out to be facts.

## Every path in the docs was wrong

`docs/tokens.md` listed the token half of the API in a neat table: `/api/v2/token_balances_by_account`, `/api/v2/token_price_history`, `/api/v2/swap_quote`. Nine rows.

Not one of them is an endpoint. The real ones are `/api/v2/account/{address}/tokens`, `/api/v2/chain/{chain}/token/{address}/price_history`, `/api/v2/swap/quote`. The table had been written from memory, it read as authoritative, and nothing would have caught it until a widget rendered a 404.

> A hand-written copy of someone else's evolving API is not thrift. It is a slow bug that documents itself confidently.

## The SDK does not escape path segments

The old client had a `segment()` helper that percent-encoded anything going into a URL path, and a test asserting a slug of `../../events/accounts/0xdead` stayed one segment. I kept the test, pointed it at the SDK, and it failed:

```
actual:   /api/events/accounts/0xdead/stats
expected: /api/v2/collections/..%2F..%2F.../stats
```

`getCollectionStatsPath(slug)` is a template literal. A hostile slug walks out of its segment, retargets the request, and collides the cache key with a legitimate entry. Not exploitable here — the service is loopback-only with a Host check — but it is a real bug class, and it is in the package rather than in us. We encode before handing values over; it should be fixed upstream.

The lesson I did not expect: **adopting an official package does not retire your tests, it re-aims them.** Three of the promises the old client made were still promises, and one of them the new dependency broke.

## Auth is two credentials, and the spec says otherwise

Half the routes 401'd with a perfectly valid API key. Collections worked; anything account-scoped did not.

OpenSea's REST auth is an API key **plus** a wallet JWT for account-scoped reads, minted from a personal access token. That is documented. What is not documented is the spec: `opensea-api.json` declares global `security: [{ApiKeyAuth: []}]` and no per-operation override on a single one of the endpoints that measurably return 401, and it does not describe the token-exchange endpoint at all.

So the generated types — the thing we adopted specifically to stop guessing — cannot tell you which calls need the second credential. We ended up with a hand-maintained list of *measured* endpoints, and a hint rather than an assertion for the ones nobody has checked. Honest, but it is a hand-maintained list again, which is the thing we were trying to delete.

## What the SDK could not give us

The bit I keep turning over. `OpenSeaAPI` builds its own fetcher internally from `this.get/post/request`, bound in the constructor. There is no seam for a transport — no `fetch` injection, no cache hook, no place to put an outbound rate limit. So you either give up your own caching and retry policy, or you subclass and override the one public method every read funnels through.

We subclassed. It worked out unreasonably well, because the same override that adds the cache also lets `post` and `request` throw — which means the read-only property is now enforced by *structure*. Every write in the SDK, from `postListing` to `executeSwap` to `transferAssets`, fails at the transport before it can reach the network. There is no longer a way for a bug in `service/` to become a transaction. That is a stronger guarantee than the one we had, and it fell out of a workaround.

The other half is less happy: SDK errors carry no status code except on 429, and the message is built from a remote-controlled response body. So a 401 with an `errors` array is genuinely indistinguishable from a 404, and a client that refuses to echo remote text — ours does, deliberately, because the API key travels in a header — has to report both as "OpenSea request failed."

## Solana was the easy part

The task I expected to be hard was making chains first-class with Solana native. It was nearly free. `ChainIdentifier` is a union of 29 slugs and `solana` sits in the middle of it with nothing special about it. Same endpoints, same shapes, same client.

The one place chains genuinely differ on the data side is what an address *is* — and neither package will tell you. `checksumAddress` is EVM-only and throws on anything else; the spec's `SolanaAddress` schema has no pattern. So we decode base58 and check for 32 bytes, because length alone does not work: base58 is not fixed-width, and a 44-character string can decode to 33 bytes.

Where chains really diverge is writing, and the split is neat. Seaport order construction is EVM-only — the SDK throws `Chain solana is not supported for OpenSea Seaport listings` rather than failing obscurely, which is the right call. But `/swap/execute` hands back executable transactions with the chain attached, EVM calldata and Solana instructions in the same response shape. Order construction is chain-specific and lives in the SDK; swap construction is chain-specific and lives on the server. So the token half generalises to Solana far more cheaply than the NFT half does — which is lucky, because that is where a Solana-first user actually lives.

## What I'd do differently

Check the spec's `security` block against a live 401 *before* designing the credential plumbing, not after. I built the client assuming one credential, then retrofitted a second one through the constructor — and because the SDK fixes both credentials at construction time, "refresh the JWT" means "build a new API object." It works, and it happens twice a day, but it is a shape I would have chosen differently if I had known on the first day rather than the second.
