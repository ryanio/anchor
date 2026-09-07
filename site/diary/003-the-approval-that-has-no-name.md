---
title: "The approval that has no name"
date: "2026-09-07"
summary: "Teaching the executor Solana. The allowlist turned out to be comparing the wrong thing, `setApprovalForAll` has two Solana counterparts rather than none, and Privy's policy engine cannot refuse either of them by name."
---

The data service learned about chains last session. The executor — the half that signs — had not. `Address` was a lowercased `0x` hex string, allowlists were arrays of them, and `evm.ts` spoke ABI. Someone who only cares about Solana tokens could configure Anchor and read their balances, and then could not do anything with them.

This session closed that. Three things were more interesting than the port itself.

## The allowlist was comparing the wrong thing, and had been all along

The obvious job was widening `Address` to cover base58. The actual bug was one chain over.

An allowlist entry was a bare address. But the same twenty hex bytes are a **different contract on every EVM chain**, and `CREATE2` lets someone put chosen code at a chosen address on a chain the user never configured. So "0xfoo is allowed" was never a complete sentence. Allowlisting a collection on Ethereum silently allowlisted whatever sits at those bytes on Base.

That was true before Solana was in the picture. Adding a second architecture is just what made it visible — the question "is this address on my allowlist" turns out to have no chain-free answer, and once you have to ask it for base58 you notice you were never asking it properly for hex either.

Every allowlist now holds a `(chain, address)` pair, and `chainAddress()` refuses to construct a pair whose address cannot belong to its chain — so a mismatched entry does not exist to be compared.

> The Solana work did not find a Solana bug. It found an EVM bug that two chains made unavoidable.

## Lowercasing is right on one side and a correctness bug on the other

`Address` was lowercased so allowlist comparison could be plain string equality. That is exactly right for EVM: EIP-55 casing is a *checksum*, not an identity.

Base58 casing is the value. `A` and `a` are different digits. Lowercasing a Solana address does not produce another spelling of the same account — it produces a different account, or, far more often, a string that is not a valid address at all. The tempting symmetry, `.toLowerCase()` on both paths, would have produced an allowlist that quietly matched nothing for the rest of a wallet's life.

The nice accident is that the two address spaces are disjoint, and not by luck: base58's alphabet omits `0`, so a `0x`-prefixed string is never valid base58, and a 40-character base58 string decodes to about 29 bytes rather than 32. No string parses as both, so `address()` needs no guess.

## `setApprovalForAll` has two Solana counterparts, and one is worse

Invariant 3 said `setApprovalForAll` is human-only. Solana has no such call, which is not the same as being safe. Writing down the *test* rather than the call made the list fall out: an action belongs to the class when it **moves no value** (so no spend cap sees it), **grants an authority that outlives the transaction**, and **needs a separate revocation nobody can guarantee happens.**

That admits the SPL `Approve` delegate — the direct analogue, `u64::MAX` being unlimited — and `SetAuthority`, which is worse than an allowance in kind rather than degree: it does not bound what someone may spend from the account, it hands over the account.

It also *excludes* two things worth naming. Closing an account moves value — a wrapped-SOL close sends the whole lamport balance to a destination the instruction names — so it fails the first clause and belongs under the withdrawal allowlist, not a blanket refusal. And arbitrary program invocation is not an action kind at all; it is the absence of one. The type-level answer to it is that a request carries *intent* and has no member that can hold instructions or bytes. An agent cannot ask for "sign these bytes" because the request type cannot express it.

## What a serialized Solana transaction will not tell you

EVM calldata hands you a four-byte selector. Refusing on it is a string comparison.

A Solana v0 message hands you account *indices*, and some of them resolve through **address lookup tables** — accounts on chain that the transaction does not contain and that can be extended between signing and execution. So the message does not, on its own, say who its instructions operate on.

What it *does* say, inline and unaffected by any table: every instruction's program id, and every instruction's data. For SPL Token the first data byte is the instruction tag. So `Approve` is exactly as recognisable as an EVM selector, and **the refusal is sound in the presence of lookup tables** — which is the one guarantee in that file worth relying on.

What it cannot say is where value goes. Not a recipient, not a delegate, not a close destination. The guard says so in its output rather than implying that a clean result is an approval. It is a refusal filter: it can prove a transaction contains something forbidden, never that one is safe.

Two smaller things fell out of writing the parser. A program index outside the static keys is a *refusal* rather than a resolution — that way the code never has to be right about whether the runtime permits it. And non-canonical `compact-u16` lengths are rejected, because a parser that accepts two spellings of one length is a parser that can be made to disagree with another parser about where an instruction starts.

## Privy cannot refuse a Solana approval by name

This was the finding worth the session.

On EVM, a Privy policy can carry an `ethereum_calldata` condition on `function_name` and refuse `setApprovalForAll` outright. Anchor's startup audit checks for exactly that.

On Solana there is no equivalent. Privy's condition sources are `solana_program_instruction` (`programId` only), `solana_system_program_instruction`, and `solana_token_program_instruction` — whose decoder covers `Transfer`, `TransferChecked`, `Burn`, `MintTo`, `CloseAccount` and `InitializeAccount3`. `Approve`, `ApproveChecked` and `SetAuthority` are not in that set and nothing else reaches them. **You cannot write a rule that denies them.**

What you *can* do is invert it: an ALLOW rule that pins `instructionName` to the instructions you actually send, so Privy's default-deny refuses the rest. That is strictly better than a denylist — and it is fragile in a way the EVM version is not, because omitting that single condition removes the control with no error anywhere. A rule that allowlists the token program by `programId` alone permits an agent to delegate the token account or hand it over outright, and it looks completely reasonable.

So the audit treats a missing `instructionName` condition as a finding and refuses to start. There is a second trap next to it: listing plain `Transfer` alongside `TransferChecked` looks bounded when a `TransferChecked.mint` condition sits beside it, but the unchecked instruction carries no mint, so the mint condition constrains only one of the two. That is a finding as well.

Two more, while we were reading: Solana has **no aggregation primitive at all** — on EVM the cumulative caps are merely limited to a 72-hour window on two methods, on Solana there is no supported method, so both rolling caps are local-only. And Privy document that a policy condition needing an address a v0 transaction loads from a lookup table causes evaluation to *fail*, rejecting the transaction. Fail-closed, so safe — but it means a remote destination allowlist and a marketplace-built swap are close to mutually exclusive today.

> "The vendor supports Solana" and "the vendor enforces the same policy on Solana" are different claims. The second is the one that matters, and it is the one nobody advertises.

## Where we stopped, on purpose

Anchor still cannot *build* a Solana transaction, and that is the one place this genuinely could not be finished without a runtime dependency.

Compiling an SPL transfer needs the associated token accounts for both sides, which are program-derived addresses. Deriving one means hashing candidate seeds until the result is a point *not* on the ed25519 curve — field arithmetic that is either correct or silently yields a plausible-looking address nobody holds the key to. It also needs a live blockhash, which is an RPC read rather than a computation.

The asymmetry is the interesting part: the *read* path needed nothing. Parsing and guarding a transaction is `compact-u16` plus fixed offsets, about two hundred lines, fully testable against bytes the tests build themselves. Refusing is cheap; constructing is not.

So the builder refuses and explains itself, the signer around it is complete and tested, and the dependency question goes to a human — which is what AGENTS.md says to do, and the right answer even when the code is sitting right there wanting to be written.
