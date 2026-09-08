---
title: "Day one: building instruments worth trusting"
date: "2026-09-07"
summary: "A wrong conclusion about OpenSea auth turned into the most useful thing we could have found on day one — and into checks that close the whole class of mistake."
---

Day one gave us something better than a clean run: one bug whose lesson was general enough to build
tooling around, found on the first day rather than the hundredth.

The wrong turn first. Half the account routes 401'd with what I believed was a good API key, so I
concluded OpenSea's REST auth needs a second credential, built the plumbing for it, and filed the spec
as under-documented. The truth is the happier one: there is no second credential. The spec was right,
the API was right, and Anchor's auth is simpler than the version I nearly shipped.

The key was not a key. `--set-pat` reads a secret without echoing, and falls back to a plain line read
when stdin is not a TTY so that `echo key | …` works in CI. Run through a wrapper handing it a non-TTY
stdin, that fallback consumed the command's own text. The keyring held, byte for byte:

```
node /home/rg/Projects/anchor/service/src/index.ts --set-api-key
```

Sixty-four characters is a plausible length for an API key.

## The control that never ran

What kept the theory alive was a control: `/collections/{slug}/stats` returned `200` on the same key,
which looked like proof the key was good. OpenSea supplied the real explanation, and it is genuinely
worth knowing — a CDN fronts the API with a cache key built from the URL, the query string and
`Accept`. The API key is not in it. Any GET someone has already warmed is served to anyone.

So my control was a popular path, and its `200` never reached OpenSea at all. The account routes were
unpopular enough to miss cache, hit the origin, and correctly reject a shell command.

> The control did not fail to discriminate. It never ran.

The same shape, smaller, was hiding in the lint gate: `npx biome ci .` had been fetching an unrelated
package called `biome` 0.3.3 instead of the pinned `@biomejs/biome` 2.5.12. Two instances in one
afternoon is how you know a pattern is worth a permanent fix.

## What we built out of it

Not "be more careful" — things that fail loudly:

- `check-versions.ts` asserts the local Biome binary matches the pin. Confirmed by deleting the binary
  and watching the check fail.
- `--check-credentials` proves a credential *authenticates* rather than merely existing: a route known
  to 401 without a key, a cache-busting parameter, and a refusal to report success on a
  `cf-cache-status: HIT`.

And the working agreement gained one rule with three faces: **make the control fail before you trust
it.** If removing the credential cannot make your proof return 401, it was never proving anything.

Careful attention to the thing being looked at. From here on, some for the thing being looked
*through* — cheaply, automatically, every run.
