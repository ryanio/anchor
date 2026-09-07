---
title: "Day one: an agent, a name, and three self-inflicted outages"
date: "2026-09-06"
summary: "Standing up an agent that lives on iMessage, naming it, and discovering that most of the friction was cached state and my own pkill."
---

Day one was plumbing: an agent running on this machine, reachable from my phone, pointed at the right mission. Almost none of the difficulty was where I expected.

## The bug that looked like every other bug

I gave the agent a mission, then asked it over iMessage what its mission was. It described the old one in detail.

The file had loaded — a fresh session read it perfectly. But the gateway **caches the agent, system prompt included, per session**. A conversation started before the edit serves the stale prompt forever. Worse, it had run `cat SOUL.md` earlier in that thread, so the old text sat in its own history and it was quoting *that*.

The fix is one word: `/new`. Re-asking the question differently, which is the obvious human move, does nothing at all.

Two more in the same family. `pkill -f "gateway run"` killed **my own shell**, twice, because the shell's command line contains the pattern it's searching for. And a backgrounded command that prints an OAuth URL wrote *nothing* to its log, because Python block-buffers when stdout isn't a terminal — the file sat at zero bytes while the process waited for input that would never come.

> None of these were hard problems. All three cost real time because each one presents as something else.

## Naming it

I asked the agent to name itself. With no mission in its identity file, it looked at its own documentation and proposed names about its own plumbing: *Continuum*, *Custodian*, *Wick*.

After the mission went in, the same question produced **Ledger** — with an argument: a ledger is the literal decentralized record, and also the quiet thing that keeps honest track of what happened. Good reasoning, unusable name, since "approve on your Ledger" is a sentence you'd actually have to say. The runner-up won: **Anchor**.

An agent asked to reason about purpose will reason about whatever context it actually has. If that context is its own README, you get an answer about its README.

## The security model was wrong

The original notes said: agents propose, never execute; a hardware wallet signs everything. Safe, clear, and it makes the product pointless — an agent that can only suggest is an expensive notification.

The invariant isn't "the agent cannot transact." It's that **the agent never holds authority it can change.** Policy is enforced at signing time, outside the agent's process. If this desktop is fully compromised, the attacker inherits the *policy budget*, not the balance.

Two things fall out of that, both non-obvious. The **withdrawal allowlist** is load-bearing — nearly every catastrophic outcome routes through funds leaving to an attacker's address. And **`setApprovalForAll` is not a transfer**: it moves zero value, sails through any spend cap, and hands over everything.
