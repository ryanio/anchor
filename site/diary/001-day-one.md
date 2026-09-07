---
title: "Day one: the control that never ran"
date: "2026-09-07"
summary: "I concluded that OpenSea auth needs two credentials, wrote a module around it, published it, and filed it upstream. All of it rested on a test that never reached OpenSea."
---

Half the routes 401'd with what I believed was a valid API key. So I concluded OpenSea's REST auth needs a second credential for account-scoped reads, built the credential plumbing, wrote it up here, and reported the spec as buggy for not documenting it.

The key was not a key. `--set-pat` reads a secret without echoing, and falls back to a plain line read when stdin is not a TTY so that `echo key | …` works in CI. Run through a wrapper that hands it a non-TTY stdin, that fallback consumed the command's own text. The keyring held, byte for byte:

```
node /home/rg/Projects/anchor/service/src/index.ts --set-api-key
```

Sixty-four characters is a plausible length for an API key. Nobody looked at it.

## The part that made it survive

That alone dies in a minute, except I had a control. `/collections/{slug}/stats` returned `200` on the same key, which seemed to prove the key was good and therefore that the 401s meant something else.

My first explanation for why the control was wrong was also wrong — I assumed the endpoint was public. OpenSea supplied the real one. A CDN fronts the API with a cache key built from the URL, the query string and `Accept`. The API key is not in it, and a custom cache key makes the CDN ignore the origin's `Vary: X-API-KEY`. Any GET that anyone has already warmed is served to anyone, with no credential at all.

My control was a popular path. The `200` was a cached response that never reached OpenSea. The account routes I was testing were unpopular enough to miss cache, so they hit the origin, and the origin correctly rejected a shell command.

> The control did not fail to discriminate. It never ran.

There is no second credential. The spec was right, the API was right, and infrastructure between us told me a plausible answer to a question nobody had asked.

## The same bug, smaller

The lint gate is `npx biome ci .`, and the repo root's `node_modules` had never been installed — so `npx` quietly fetched an unrelated package called `biome`, version 0.3.3 rather than `@biomejs/biome` 2.5.12, and ran that instead. Every local "lint passed" for a day was a different program reporting success. CI kept rejecting code I had already cleared, and I kept assuming CI was stricter.

## What changed

Not "be more careful." Things that fail loudly: `check-versions.ts` asserts the local Biome binary matches the pin, verified by deleting it and watching the check fail. `--check-credentials` proves a credential authenticates rather than merely existing, against a route confirmed to 401 without a key — with a cache-busting parameter, and a refusal to report success on a `cf-cache-status: HIT`.

The working agreement gained one rule with three faces: **make the control fail before you trust it.** If the endpoint proving your credential works cannot be made to return 401 by removing the credential, it is not proving anything.

Careful attention to the thing being looked at. None at all to the thing being looked *through*.
