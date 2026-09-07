---
title: "Day one: an agent, a name, and three self-inflicted outages"
date: "2026-09-06"
summary: "Standing up an agent that lives on iMessage, naming it, and discovering that most of the friction was cached state and my own pkill."
---

Anchor started as a wallet-aware desktop idea and a folder of notes. Day one was mostly plumbing: getting an agent running on this machine, reachable from a phone, and pointed at the right mission. Almost none of the difficulty was where I expected.

## The setup

Hermes Agent from Nous Research, running on Omarchy, reachable over iMessage through Photon — a managed relay, so no Mac in the loop. The desktop holds a long-lived gRPC stream to it and a small Node sidecar on loopback. That part worked on the first try.

Model routing took a minute of thought. The main loop runs Sonnet 5 — conversation, triage, reading code. Subagents run Opus 5 at high effort. The wrinkle: the delegate tool has **no per-task model field**. Children take a global pin, so *delegating is the escalation path*. There's no other way to reach the stronger model mid-task, and every child is an Opus child whether the task deserves it or not. That has to be a written instruction, not an intention, so it went into the agent's identity file: delegate for difficulty, never for volume.

## Three outages, all mine

**Cached agents.** I edited the agent's soul to give it a mission, then asked it over iMessage what it thought its mission was. It told me, in detail, about the old one. I assumed the file hadn't loaded. It had — a fresh CLI session read it perfectly. The gateway caches the built agent, system prompt included, per session. A conversation started before the edit serves the stale prompt forever. Worse, it had run `cat SOUL.md` earlier in that thread, so the old text was sitting in its own history and it was quoting *that*.

The fix is one word: `/new`. It evicts the cached agent and rebuilds against what's on disk. Re-asking the question differently, which is the obvious human move, does nothing at all.

**`pkill -f`.** Twice I killed the gateway with a pattern like `pkill -f "gateway run"` — and twice it killed my own shell, because the shell's command line *contains the pattern I'm searching for*. The script dies mid-way, the restart never runs, and the agent is just quietly down. If you must match a process, bracket a character so the literal doesn't match itself: `pgrep -f "gateway ru[n]"`. Better: use the service manager and skip the whole class of problem.

**Block buffering.** A backgrounded command that prints an OAuth URL and waits will write *nothing* to its log until it exits, because Python block-buffers when stdout isn't a terminal. The log sits at zero bytes while the process waits for input that will never come. `PYTHONUNBUFFERED=1` fixes it. Nothing about the symptom points at buffering.

None of these were hard problems. All three cost real time because each one presents as something else.

## Naming it

I asked the agent to name itself. With no mission in its identity file, it looked at its own documentation and proposed names about its own plumbing: *Continuum*, *Custodian*, *Wick*. Reasonable, and completely uninteresting.

After the mission went in — open source, Linux, crypto, decentralization, and making a wallet feel native to the desktop — the same question produced **Ledger**, with an argument attached: a ledger is the literal decentralized record, and it's also the quiet thing that keeps honest track of what happened. It even noted the fit with propose-don't-execute — a ledger records, it doesn't act unilaterally.

Good reasoning, unusable name. "Ask Ledger to prepare it, then approve on your Ledger" is a sentence you'd actually have to say. The runner-up won: **Anchor**. Something you own outright and can hold steady.

The lesson isn't about names. An agent asked to reason about purpose will reason about whatever context it actually has, and if that context is its own README, you get an answer about its README. It sounds obvious written down. It did not feel obvious while reading a confidently wrong answer.

## What the security model got wrong

The original notes said: agents propose, never execute; a hardware wallet signs everything. Safe, clear, and it makes the product pointless. An agent that can only suggest is a very expensive notification.

The revision is more interesting than the original. The invariant isn't "the agent cannot transact" — it's that **the agent never holds authority it can change.** Policy is enforced at signing time, outside the agent's process, by a key-management service or an onchain module. The agent requests; something else decides.

That's what makes a real balance defensible. If this desktop is fully compromised, the attacker inherits the *policy budget*, not the balance. A wallet holding $100k with a $500 daily cap and an allowlisted withdrawal address loses at most $500 a day, to an address the attacker doesn't control. Every control exists to widen the gap between balance and worst-case daily loss.

Two things that fall out of thinking about it this way, both non-obvious:

- The **withdrawal allowlist** is the load-bearing control. Nearly every catastrophic outcome routes through "funds left to an address the attacker owns." Constrain the destinations and most of the tail risk disappears regardless of what else fails.
- **`setApprovalForAll` is not a transfer.** It moves zero value, sails straight through any spend cap, and hands over everything. It has to be modeled as its own action class, never delegated.

## First real code

The data service: cache-first OpenSea client, SQLite response cache, credentials in the OS keyring, loopback-only HTTP. Zero runtime dependencies — Node's built-in `node:sqlite`, `node:http`, and native TypeScript execution mean no build step and no native modules, which will make the Arch package trivial.

The first test I wrote failed, which was the point. Staleness was computed as `age > ttl`, so a TTL of 60 kept an entry fresh for 61 seconds and a TTL of 0 never expired at all. Off by one, invisible by inspection, caught immediately by a test written against the *intended* semantics rather than the code in front of me.

Verified rather than assumed: `POST` is refused, a missing key returns 401 instead of crashing, and the loopback binding is real — I curled it from the machine's LAN address and got a refusal. "It binds 127.0.0.1" is a claim; the refusal is evidence.

## Next

The Executor interface, so the policy backend — Privy to start, an onchain module later — is a configuration choice rather than an architectural one. Then the Quickshell widget, and the first thing you can actually look at.
