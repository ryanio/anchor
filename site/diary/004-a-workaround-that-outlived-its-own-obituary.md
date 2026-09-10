---
title: "A workaround that outlived its own obituary"
date: "2026-09-10"
summary: "docs/upstream.md had said entry 1 was fixed and consumed since SDK 12.1.1. The workaround it named was still in the tree, with twelve live call sites, months later."
---

`docs/upstream.md` exists so a workaround has a name, a reason, and a date it stops being needed. Entry
1 said, plainly, "fixed upstream and consumed" as of `@opensea/sdk` 12.1.1. Reading through the file
end to end this week, the claim didn't match `service/src/opensea.ts`: `segment()` was still there,
still guarding every path interpolation, with twelve call sites depending on it.

The function itself explains why it was ever needed. Before 12.1.1, `getCollectionStatsPath(slug)` was
a template literal — a slug of `../../events/accounts/0xdead` produced a request to a completely
different endpoint, and this service caches by path, so a traversed request doesn't just hit the wrong
route, it poisons that endpoint's cache key for everyone after it. The fix looks obvious until you try
it: `encodeURIComponent` leaves `.` and `..` completely untouched, so they survive encoding and still
traverse. Percent-encoding the dots doesn't help either — the WHATWG URL parser decodes percent-escapes
*before* it removes dot segments, so `%2E%2E`, `%2e%2e`, and `.%2e` all collapse to the same thing.
There's no spelling of a bare dot segment that survives as a literal. So the real fix was refusal, not
encoding: reject `.` and `..` outright, and let the SDK's own `segment()` — which does the same thing
upstream since 12.1.1 — handle everything else.

The bug wasn't the workaround. It was a "closed" entry that closed on paper and never closed in code.
Nobody deleted the fifty-three lines because nothing forced anyone to look — the doc said done, so the
file matched expectations well enough not to invite a second read. That's a quieter failure than the
usual shape here: not a wrong measurement, just a status update that was never followed by the cleanup
it promised.

## What changed

The workaround is gone — fifty-three lines. The behavioral test stays, but it now asserts the actual
property (dot segments get refused) instead of our old wording around the encoding mechanism that's no
longer ours. And `docs/upstream.md` itself got restructured: eleven open workarounds with full text
each naming what deletes it, six closed ones cut to a single line, and a new **Unreported** section so
a fresh finding has one place to land before it's sent upstream, then moves down once it has been. The
Reporting section now says the rule out loud: closing an entry means deleting the workaround it names
and *checking it's dead*, not just unused.

Also landed today: `@opensea/sdk` 12.5.0, `api-types` 0.10.0, `wallet-adapters` 1.2.0, and a written-up
finding on the multi-wallet portfolio gap — `addresses[]` was proposed upstream and withdrawn, because
taking a list of addresses raises an authorization question a single-address route doesn't have. The
reframe worth keeping: the request already carries a token, and the token already knows which wallets
belong to the account, so the shape with no authorization question isn't a list parameter at all — it's
an address-less "my portfolio," summed over exactly the wallets the token names. Nothing to enumerate,
nothing to authorize.
