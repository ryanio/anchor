---
title: "One credential and a slash"
date: "2026-09-07"
summary: "Adopting OpenSea's own SDK to stop hand-writing someone else's API. Every endpoint path in our docs was wrong, the SDK doesn't escape path segments — and the auth conclusion I published here was wrong, because my control endpoint was public and my API key was a shell command."
---

> **Corrected the same evening.** This entry originally concluded that OpenSea's REST auth needs two
> credentials. It does not. The section below has been rewritten and the original claim is quoted
> inside it, because a build diary that silently edits its mistakes is worth less than one that
> doesn't. The title changed from "Two credentials and a slash"; the URL has not.

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

## Auth is one credential, and I proved otherwise with a broken key

Here is what I published a few hours ago:

> Half the routes 401'd with a perfectly valid API key. Collections worked; anything account-scoped did not. OpenSea's REST auth is an API key **plus** a wallet JWT for account-scoped reads.

Every clause of that is wrong, and the way it is wrong is worth more than the finding would have been.

The API key was not valid. It was not a key at all. `--set-pat` reads a secret from the terminal without echoing it, and falls back to a plain line read when stdin is not a TTY so that `echo key | ... --set-key` works in CI. Run through a wrapper that hands the process a non-TTY stdin, that fallback consumed the command's own text. The keyring held, byte for byte:

```
node /home/rg/Projects/anchor/service/src/index.ts --set-api-key
```

The service reported the credential present, because "present" meant the keyring returned a non-empty string. Sixty-four characters is a plausible length for an API key. Nobody looked at it.

That alone would have been caught in a minute, except for the second half. I had a control: `/collections/{slug}/stats` returned `200` on the same key, which seemed to prove the key was fine and therefore that the 401s meant something else. It proved nothing. That endpoint is **public** — it returns `200` with no `X-API-KEY` header at all.

> A control that passes for the wrong reason is worse than no control. It converts an absent measurement into a confident one.

With a real key and no `Authorization` header, every one of those routes returns `200`. There is no second credential. The spec's `security` block, which I had written up as a bug — four operations declaring only `ApiKeyAuth` while fifty sibling paths declare `WalletAuth` — was correct the entire time. I had filed it upstream. I have withdrawn it.

Two things survive. The first is a real bug I would never have found otherwise: `/account/{address}/portfolio` returns `500` for a large account with no query parameters, and `200` for the same account the moment you add `timeframe` or `chains`. Fine when filtered, fine when small, fails when large and unfiltered.

The second is a guard. A credential is one opaque token — no spaces, no control characters — and a value that isn't gets refused now instead of stored. The tests reproduce both junk values exactly, because the most useful regression test is the one that fails the way the bug actually failed.

The PAT machinery is still in the tree, demoted. Fifty paths in the spec genuinely do declare `WalletAuth`, and writing will need it. It just isn't the second half of a credential pair, because there is no pair.

## What the SDK could not give us

The bit I keep turning over. `OpenSeaAPI` builds its own fetcher internally from `this.get/post/request`, bound in the constructor. There is no seam for a transport — no `fetch` injection, no cache hook, no place to put an outbound rate limit. So you either give up your own caching and retry policy, or you subclass and override the one public method every read funnels through.

We subclassed. It worked out unreasonably well, because the same override that adds the cache also lets `post` and `request` throw — which means the read-only property is now enforced by *structure*. Every write in the SDK, from `postListing` to `executeSwap` to `transferAssets`, fails at the transport before it can reach the network. There is no longer a way for a bug in `service/` to become a transaction. That is a stronger guarantee than the one we had, and it fell out of a workaround.

The other half is less happy: SDK errors carry no status code except on 429, and the message is built from a remote-controlled response body. So a 401 with an `errors` array is genuinely indistinguishable from a 404, and a client that refuses to echo remote text — ours does, deliberately, because the API key travels in a header — has to report both as "OpenSea request failed."

## Solana was the easy part

The task I expected to be hard was making chains first-class with Solana native. It was nearly free. `ChainIdentifier` is a union of 29 slugs and `solana` sits in the middle of it with nothing special about it. Same endpoints, same shapes, same client.

The one place chains genuinely differ on the data side is what an address *is* — and neither package will tell you. `checksumAddress` is EVM-only and throws on anything else; the spec's `SolanaAddress` schema has no pattern. So we decode base58 and check for 32 bytes, because length alone does not work: base58 is not fixed-width, and a 44-character string can decode to 33 bytes.

Where chains really diverge is writing, and the split is neat. Seaport order construction is EVM-only — the SDK throws `Chain solana is not supported for OpenSea Seaport listings` rather than failing obscurely, which is the right call. But `/swap/execute` hands back executable transactions with the chain attached, EVM calldata and Solana instructions in the same response shape. Order construction is chain-specific and lives in the SDK; swap construction is chain-specific and lives on the server. So the token half generalises to Solana far more cheaply than the NFT half does — which is lucky, because that is where a Solana-first user actually lives.

## What I'd do differently

The obvious answer is "check the spec against a live 401 before designing the credential plumbing." That is true and it is too small.

The real one: **I verified the claim and not the instrument.** I checked the spec's `security` block carefully, character by character, against fifty paths. I never checked that the key I was testing with was a key. The evidence was scrupulous and the apparatus underneath it was rotten, and scrupulous reasoning on a rotten apparatus produces confident wrong answers faster than sloppy reasoning does.

So the rule I actually want is: when a measurement is going to carry an architectural decision, first make the control **fail**. If the endpoint that proves my credential works can't be made to return 401 by removing the credential, it is not proving anything. That check takes one request and it would have caught this before any of it was written down.

There is a smaller version of the same lesson from the same afternoon. The repo's lint gate is `npx biome ci .`, and the repo root's `node_modules` had never been installed, so `npx` quietly fetched an unrelated package called `biome` — version 0.3.3, not `@biomejs/biome` 2.5.12 — and ran that instead. Every local "lint passed" for a full day was a different program reporting success. CI kept catching things I had already cleared, and I kept assuming CI was stricter.

Both failures are the same shape, and neither is about being careless with the thing you are looking at. They are about never turning around to check the thing you are looking *through*.
