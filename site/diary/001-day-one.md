---
title: "Day one: checking the instruments"
date: "2026-09-07"
summary: "An agent on iMessage, a repo built out by five more, and a day where almost every real problem turned out to be in the thing I was measuring with rather than the thing I was measuring."
---

Day one was meant to be plumbing: an agent on this machine, reachable from my phone, pointed at the right mission. Then more agents, in parallel, on the codebase. Almost none of the difficulty was where I expected, and by evening the same shape had appeared four times.

## Bugs that present as something else

I gave the agent a mission, then asked it over iMessage what its mission was. It described the old one in detail. The file had loaded — a fresh session read it perfectly — but the gateway caches the agent, system prompt included, **per session**, and this conversation had run `cat SOUL.md` earlier in the thread, so it was quoting its own history. The fix is one word: `/new`. Rephrasing the question, which is the obvious human move, does nothing.

Two more in the same family: `pkill -f "gateway run"` killed my own shell, twice, because the shell's command line contains the pattern it is searching for; and a backgrounded command that prints an OAuth URL wrote nothing to its log, because Python block-buffers when stdout is not a terminal. Meanwhile an agent told to verify every claim by running code found `new URL(req.url, base)` sitting *outside* an async handler's `try` — a malformed request line became an unhandled rejection, and Node's default terminates the process. Twenty-two bytes from any local process and the data service is gone.

> None of these were hard. All of them cost real time because each presents as something else.

## Every path in the docs was wrong

The service had a hand-rolled OpenSea client. Zero dependencies, which felt like a virtue, and every response typed `unknown`, which was not. Replacing it with `@opensea/sdk` was supposed to be an argument about types and turned into an argument about facts: our own `docs/tokens.md` listed the token API in a confident table of nine rows, and not one of them was an endpoint. Written from memory, read as authoritative, and nothing would have caught it until a widget rendered a 404.

> A hand-written copy of someone else's evolving API is not thrift. It is a slow bug that documents itself confidently.

The old client had a `segment()` helper that percent-encoded path parameters, and a test asserting a hostile slug stays one segment. I kept the test, aimed it at the SDK, and it failed. Adopting an official package does not retire your tests; it re-aims them.

I reported it upstream. OpenSea fixed it, then told me my proposed fix was insufficient: `encodeURIComponent` leaves `.` and `..` untouched, and percent-encoding them does not help either, because the URL parser strips escapes *before* removing dot segments. They have to be refused, not encoded. Our copy had the same hole.

## The control that never ran

Then the one I will remember.

Half the routes 401'd with what I believed was a valid API key, so I concluded OpenSea's auth needs a second credential, wrote a module around it, published an entry saying so, and filed it upstream.

The key was not a key. `--set-pat` reads a secret without echoing, and falls back to a plain line read when stdin is not a TTY so that `echo key | ...` works in CI. Run through a wrapper that hands it a non-TTY stdin, that fallback consumed the command's own text. The keyring held, byte for byte:

```
node /home/rg/Projects/anchor/service/src/index.ts --set-api-key
```

Sixty-four characters is a plausible length for an API key. Nobody looked at it.

I had a control, though: `/collections/{slug}/stats` returned `200` on that same key, which seemed to prove the key was fine. My first explanation for why that was wrong — the endpoint must be public — was also wrong. OpenSea supplied the real one. A CDN fronts the API with a cache key built from the URL, the query string and `Accept`. The API key is not in it, and a custom cache key makes the CDN ignore the origin's `Vary: X-API-KEY`. So any GET that anyone has already warmed is served to anyone, with no credential at all.

My control was a popular path. The `200` was a cached response that never reached OpenSea. The account routes I was testing were unpopular enough to miss cache, so they hit the origin, and the origin correctly rejected a shell command.

> The control did not fail to discriminate. It never ran.

There is no second credential. The spec was right, the API was right, and infrastructure in front of both told me a plausible story about a question nobody had asked.

## Permission to be inspected

The executor learned Solana the same day, and two holes in it share one sentence.

The Solana guard held an allowlist of programs. The System Program was on it, and the guard did `if (!isTokenProgram(program)) return;` — so its instructions went unread. One of them is `Assign`, which reassigns an account's *owner program*, and an owner program may debit an account's lamports with no signature from anyone. A single `Assign` hands over the entire native balance while appearing to move nothing.

The Compute Budget program was on the same list, described in a comment as inert because it "sets a fee limit". It does not. `SetComputeUnitPrice` names a price in micro-lamports per compute unit, and the fee committed is limit × price ÷ 10⁶. At the maximum unit limit and a large enough price, that is over a thousand SOL — in practice the payer's whole balance, handed to a validator as a tip.

That one is interesting because it is not an authority grant, so the human-only rule does not catch it. It is a **spend that no cap can see**: a priority fee produces no asset delta, so it is invisible to simulation and to every rolling window we enforce. It needed its own ceiling.

> An allowlisted program is permission to be inspected, not permission to run.

Both holes were the same mistake: a program on a list, and nobody reading what it was being asked to do.

## The smaller version, same day

The lint gate is `npx biome ci .`, and the repo root's `node_modules` had never been installed — so `npx` quietly fetched an unrelated package called `biome`, version 0.3.3 rather than `@biomejs/biome` 2.5.12, and ran that. Every local "lint passed" for a day was a different program reporting success. CI kept rejecting code I had already cleared, and I kept assuming CI was stricter.

## The step that should not have existed

The desktop widget landed the same day, and the best fix in it was a deletion.

The complaint was that setup had too many steps in a row. The instinct is to make the list easier to read. The actual fix was that one step should never have been there: it asked for a wallet token, and it existed only because of the credential mistake above. Delete the premise, delete the step. Three steps instead of four, and one of them leaves the list as soon as it's done.

Two more things that were not what they looked like. The icon read as too tall next to its neighbours — measured rather than judged, the mark's artwork is 32×45, so its *drawn* height always binds, while the neighbouring icons are font glyphs filling about 70% of the same canvas. 20px became 12px and the top edges lined up. Thickening the stroke to compensate moved two pixels and was reverted; the apparent thinness was the deliberate dim state doing its job.

And a test file contained a literal NUL byte, so `file` called it `data` and `grep` skipped it in silence. Searches came back empty and empty looked like an answer.

> A tool that declines to read a file and a tool that finds nothing in it produce the same output.

Which is the day's theme again, in the smallest possible form.

## What I actually changed

Not "be more careful." Three things that fail loudly instead:

`check-versions.ts` now asserts the local Biome binary exists and matches the pin — verified by deleting it and watching the check fail. `--check-credentials` proves a credential *authenticates* rather than merely existing, against a route confirmed to 401 without a key, with a cache-busting parameter and a refusal to report success on a `cf-cache-status: HIT`. And a credential is now defined as one opaque token, so a value carrying whitespace is refused rather than stored.

The working agreement gained a section that is really one rule with three faces: **make the control fail before you trust it.** If the endpoint proving your credential works cannot be made to return 401 by removing the credential, it is not proving anything.

All four failures share a shape. Careful attention to the thing being looked at, none at all to the thing being looked *through*.
