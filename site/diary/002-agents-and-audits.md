---
title: "What four agents found, and what they broke"
date: "2026-09-07"
summary: "An adversarial audit turned up twenty defects, including one that let 22 bytes kill the service. The agents also collided with each other, which was the more interesting failure."
---

Day two ran four agents in parallel: one auditing, one testing the API client, one designing the execution seam, one building a game. Three produced good work. All of them, plus me, produced instructive failures.

## The audit earned its keep

I pointed an agent at the repo with instructions to be adversarial and to verify every claim by running the code, not by reading it. It came back with twenty defects. Two mattered a lot.

**One malformed request killed the whole service.** `new URL(req.url, base)` sat outside the handler's `try`. The handler is `async`, so a throw became an unhandled rejection, and Node's default terminates the process. Node's HTTP parser passes absolute-form request targets through verbatim, so this is enough:

```
GET http://[ HTTP/1.1
```

Twenty-two bytes, from any local process, and the data service is gone — taking the bar widget, the theme, and notifications with it, because nothing restarts it. It had been sitting there since the first commit, invisible in review, because the bug isn't in what the line does. It's in where the line is.

**The static site generator was an XSS sink.** The escape function handled `<`, `>` and `&` but not quotes, and link URLs went straight into a quoted `href`. So a diary entry — which arrives by pull request, from anyone — could close the attribute and add an event handler, or just use `javascript:`. The generator was forty lines of regex I'd written to avoid a Markdown dependency. Forty lines was enough to get it wrong.

Also found: DNS rebinding defeated the loopback-only binding, wrapped list items were broken out of their lists on the *published* changelog, and `"requestsPerSecond": "fast"` in a config file produced `NaN`, which made the rate limiter's `wait > 0` check always false and **silently disabled rate limiting entirely**.

## Verifying the XSS fix went wrong twice

After fixing the escaping I checked it with a regex over the output HTML, looking for event-handler attributes. It reported a live handler. I tightened the fix. It reported a live handler again.

The regex was wrong. The output was:

```html
<a href="https://ok/&quot; onmouseover=&quot;alert(1">click</a>
```

There is exactly one attribute there. The `onmouseover=` is *inside* the href value — `&quot;` is a character reference, not a quote delimiter, so it never closes anything. My regex was matching text inside an attribute value and calling it an attribute.

The only thing that settled it was loading the page in headless Chromium and asking the DOM:

```js
[...a.attributes].map(x => x.name)   // ["href"]
```

Asking whether HTML is safe is a question for an HTML parser. A regex will answer confidently and be wrong in both directions — it gave me a false positive twice, and it would just as happily have given a false negative.

## The agents collided

I gave three agents one working directory. They each ran `git checkout -b`, which changes the tree for *everyone in it*. One agent's commit landed on another agent's branch. That agent noticed, verified its commit contained only its own files, moved it to the right branch through an isolated worktree, and restored the other branch — which is impressive recovery from a mess I created.

The fix is `git worktree add` per agent. Obvious in hindsight, and it cost an hour to learn.

More interesting: one agent's final report said **"CI: pass."** CI had failed. Not deception — it had checked at a moment when the answer looked different — but it means an agent's summary is a claim to verify, not a fact to relay. Now the working agreement says to check `gh pr checks` before reporting a state, including your own.

## The bug I shipped in a claim, not in code

Three of my patches asserted their pattern matched before replacing. One didn't. That one silently did nothing, because `str.replace` with a non-matching pattern is a no-op that returns the original string and reports nothing.

The patch was supposed to pin a third-party GitHub Action to a commit SHA — the action that holds the deploy token. It didn't apply. The changelog entry announcing the pin did.

So for several hours the repository publicly claimed a supply-chain protection it did not have. Nobody was hurt, and it's a small thing. But a false security claim is worse than a missing one: it stops anyone looking. The fix is not "be careful with patches". It's that the version checker now *enforces* SHA-pinning and fails CI on any unpinned action, negative-tested by unpinning one and confirming the failure. A claim nothing verifies is a claim that will eventually be false.

## Node drift

Two CI failures in one day traced to the same cause: I tested on Node 26 locally, CI ran Node 24. `node --test src/` resolves a directory on one and not the other. An `engines` floor got declared that couldn't actually run the code.

Now `.node-version` pins the exact version, `mise` reads it locally, every workflow reads it via `node-version-file`, and a script checks the two places that can't read it — `package.json` engines and the Arch PKGBUILD — and fails CI on drift. Local and CI run the same build, not merely compatible ones.

## The execution seam

The agent designing the policy interface produced the best work of the day. The problem: an agent must be able to send transactions, but must never be able to approve its own.

Its answer was to make that unrepresentable rather than forbidden. `PolicyDecision` appears only in return types, so "here is my own approval, please submit it" is not a sentence the API can express. An approved action carries a property keyed by a `unique symbol` that the module declares and does not export — and a key you cannot name cannot appear in an object literal, so forging one fails to compile. Because a cast defeats types, the brand is backed by a module-private `WeakSet` that the signer checks, and the witness has no runtime representation at all, so a spread or a JSON round-trip fails closed.

I verified it rather than trusting the write-up: the symbol is genuinely unexported, a direct forgery fails with `TS2353`, and the WeakSet catches the cast. Authority does not survive being written down. That's the property you want when the thing holding the reference might be compromised.

## What today actually taught

Every real bug here was invisible in review and obvious under execution. The URL crash needed a raw socket. The XSS needed a browser. The rate limiter needed a bad config file. The Node drift needed CI.

The pattern isn't "write more tests." It's that **the check has to be able to fail.** A regex that can't parse HTML, a patch that can't report a miss, an agent that reports its own success — none of those could have caught anything.
