---
title: "Permission to be inspected"
date: "2026-09-07"
summary: "Picking up interrupted work. The Solana guard had a second allowlisted program nobody was reading, and it could spend the whole balance as a fee. Then we went and checked the vendor claims we had been asserting from memory."
---

This session started in someone else's half-finished sentence. Two agents had been stopped mid-edit on the Solana executor work, and the branch carried four commits, two of them labelled `wip` and explicitly unreviewed. One of them did not typecheck: it added two tests referencing `SYSTEM_PROGRAM` without adding it to the import list.

That is a good outcome, not a bad one. The alternative to a `wip` commit that fails `tsc` is work that exists only in a dead process. Committing early and often is the reason there was anything to pick up.

## The same bug, one program over

The last complete commit before the interruption fixed a real hole: the System Program was on the Solana guard's program allowlist and the guard did `if (!isTokenProgram(program)) return;`, so every one of its instructions passed unread. That matters because `Assign` reassigns an account's **owner program**, and an owner program may debit its lamports with no signature from anyone. One `Assign` hands over the entire native balance, having moved nothing a spend cap can see.

The fix was right. The interesting part was the shape of it, so we asked the same question of every other entry on that list: *which of these "inert" programs has instructions nobody reads?*

The Compute Budget program. Its comment described it as a program that "sets a fee limit" and was therefore safe to allow unconditionally.

It does not set a fee limit. `SetComputeUnitPrice` names a price in micro-lamports **per compute unit**, as a `u64`. The fee committed is `limit × price ÷ 1,000,000`, and at the maximum unit limit of 1,400,000 a price of 10¹² comes to 1,400 SOL — in practice the payer's whole native balance, paid to a validator as a tip.

We measured it before fixing it, which AGENTS.md now insists on. A transaction carrying exactly those two instructions came back from the guard with `findings: []`. So did one carrying a Compute Budget instruction tag that does not exist. Nine of the eleven tests written for it fail against the previous commit.

> An allowlisted program is permission to be **inspected**, not permission to run. Both holes found in this file so far were an allowlisted program whose instructions nobody read.

It is deliberately *not* a member of the human-only class. It grants no standing authority; it is over when the block is. What it is instead is a spend that no cap can see — a priority fee produces no asset delta, so it appears in no simulation and in no rolling window. Same first symptom as the approval class, a completely different cause, and filing it under the wrong heading would have been worse than missing it.

There was a small bonus trap. This is now the **third** discriminant encoding in one file: SPL Token's tag is one byte, the System Program's is a four-byte little-endian `u32`, and the Compute Budget program's is a one-byte borsh tag. Read the third with the second's rule and `03 00 00 00 …` becomes a different instruction entirely. Also, where the runtime takes the *last* `SetComputeUnitPrice`, the guard takes the largest — otherwise appending a cheap instruction after an expensive one launders the check.

## Then we checked the things we had been asserting

One of the interrupted commits contradicted itself. The Privy audit treated an `instructionName` condition on `solana_system_program_instruction` as clearing a finding, while the finding's own text said "whether it can pin an instruction name is not established here." One of the two had to be wrong, and neither had been checked.

So we read Privy's actual documentation instead of reasoning about it. Four claims held exactly as written — the token decoder's six instructions, `Approve`/`SetAuthority` being unreachable, no aggregation primitive for any Solana method, and ALT-loaded addresses failing evaluation. One did not: `solana_system_program_instruction` **does** carry `instructionName`, with `Create` and `Transfer` in the examples. The code was right and the comment was stale. So the System Program hole, unlike the token program one, is closable remotely as well as locally.

And one thing nobody had thought to look for: **there is no Compute Budget condition source at all.** The only rule that reaches the program is `programId`, which permits invocation and says nothing about the price. A Privy Solana policy therefore cannot refuse the drain we had just fixed locally.

That is a different kind of gap from the others in the register. The rest are controls weaker than their EVM counterparts. This is a control with **no remote expression whatsoever**, which is why the audit *states* it on every startup rather than refusing to start: a finding means "fix this in Privy", and nearly every real Solana transaction sets a compute unit limit, so refusing would reject every honest policy while offering no remedy.

> Making the distinction between "the vendor's control is weaker here" and "the vendor has no control here" is worth the extra list. They call for opposite responses.

## The correction that didn't finish landing

The session before this one retracted a claim: Anchor does not need a second OpenSea credential. The original measurement had been taken with a keyring entry holding a shell command, against an endpoint that is public and returns 200 for anyone — a control that passed for the wrong reason.

That retraction corrected `auth.ts`, the changelog, and the published diary entry. It missed `docs/security.md`, which still said "There are two OpenSea credentials" in the normative voice, in the file most likely to be read as the rule.

Fixed here, along with a note on why the original measurement was wrong. A retraction that lands in three of four places is a retraction that will be quietly un-retracted by the next person who greps.

## Still open, still on purpose

Anchor still cannot *build* a Solana transaction, for the reasons entry 003 gives: associated token account derivation is ed25519 field arithmetic, and a blockhash is an RPC read. The recommendation has firmed up rather than changed — take the compiled transaction from OpenSea's `/swap/execute` if it can return one, and only otherwise reach for `@solana/kit`. Either way it is a human's call, so the builder still refuses and explains itself.

The read path needed no dependency at all. It is worth saying twice, because the whole security posture rests on it: refusing is cheap, constructing is not, and everything Anchor genuinely must be certain about lives on the cheap side.
