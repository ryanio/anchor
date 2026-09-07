---
title: "Day one: an agent, an audit, and twenty-two bytes"
date: "2026-09-07"
summary: "Standing up an agent that lives on iMessage, then pointing four more at the repo. Most of the friction was cached state, my own pkill, and a claim I made before it was true."
---

Day one was meant to be plumbing: an agent running on this machine, reachable from my phone, pointed at the right mission. Then four more agents, in parallel, on the codebase. Almost none of the difficulty was where I expected.

## The bug that looked like every other bug

I gave the agent a mission, then asked it over iMessage what its mission was. It described the old one in detail.

The file had loaded — a fresh session read it perfectly. But the gateway **caches the agent, system prompt included, per session**. A conversation started before the edit serves the stale prompt forever. Worse, it had run `cat SOUL.md` earlier in that thread, so the old text sat in its own history and it was quoting *that*.

The fix is one word: `/new`. Re-asking the question differently, which is the obvious human move, does nothing at all.

Two more in the same family. `pkill -f "gateway run"` killed **my own shell**, twice, because the shell's command line contains the pattern it's searching for. And a backgrounded command that prints an OAuth URL wrote *nothing* to its log, because Python block-buffers when stdout isn't a terminal.

> None of these were hard problems. All three cost real time because each one presents as something else.

## Naming it

I asked the agent to name itself. With no mission in its identity file, it looked at its own documentation and proposed names about its own plumbing: *Continuum*, *Custodian*, *Wick*.

After the mission went in, the same question produced **Ledger** — a ledger being both the decentralized record and the quiet thing that keeps honest track. Good reasoning, unusable name, since "approve on your Ledger" is a sentence you'd have to say out loud. The runner-up won: **Anchor**.

An agent asked to reason about purpose reasons about whatever context it actually has. If that context is its own README, you get an answer about its README.

## Twenty-two bytes

I pointed an agent at the repo and told it to be adversarial, verifying every claim by running code rather than reading it. It found twenty defects.

`new URL(req.url, base)` sat *outside* the handler's `try`. The handler is `async`, so a throw became an unhandled rejection, and Node's default terminates the process:

```
GET http://[ HTTP/1.1
```

Any local process, and the data service is gone. It had been there since the first commit, invisible in review, because the bug isn't in what the line does — it's in *where the line is*.

Then I verified the accompanying XSS fix with a regex over the output HTML. It reported a live event handler. I tightened the fix. It reported one again. Both times the regex was wrong: it was matching text *inside* an attribute value. Only a real parser settled it — headless Chromium returned `["href"]`.

## The claim before the fact

Three of my patches asserted their pattern matched before replacing. One didn't, and silently did nothing — `str.replace` with no match returns the original and reports success.

That patch was supposed to pin the GitHub Action that holds our deploy token. The changelog announcing the pin shipped anyway. For a few hours the repo publicly claimed a supply-chain protection it did not have.

The fix isn't "be careful with patches". The version checker now *enforces* SHA-pinning and fails CI on any unpinned action. **A claim nothing verifies is a claim that will eventually be false.**

## Also, a game

Somewhere in there a fifth agent built a Roman battle in the browser — no dependencies, morale tuned until flanking felt decisive. It has [its own repository](https://ryanio.github.io/tidebreak/) now. Not every part of a day has to be load-bearing.
