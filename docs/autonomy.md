# Autonomy and spend controls

Anchor's agent is meant to **act**, not just suggest — and to do it while holding real value. The goal
is a wallet an agent operates day to day, starting around $100 and growing to $100k+, that other people
are comfortable using.

"Don't let the agent hold much" is not the answer. It doesn't scale, and it makes the product useless.
The answer is that **authority is bounded somewhere the agent cannot reach.**

## The load-bearing idea

The agent must never be the thing that decides whether a transaction is allowed.

Policy is enforced **at signing time, outside the agent's process** — by a key-management service with a
policy engine, or by an onchain smart-account module. The agent can only ever *request*. If it asks for
something outside policy, the request is rejected before funds move, and it does not matter whether the
agent is confused, jailbroken, or fully controlled by an attacker.

This is what makes a large balance defensible. **If the Omarchy desktop is compromised, the attacker
inherits the agent's policy budget — not the balance.** A $100k wallet with a $500 daily cap and an
allowlisted withdrawal address loses at most $500 a day, to an address the attacker doesn't control.

Every control below exists to widen the gap between *balance* and *worst-case daily loss*.

## Where policy can live

| Approach | Enforcement | Trade-off |
|---|---|---|
| **Vendor policy engine** (Privy server wallets, Turnkey, Coinbase CDP) | Off-chain, at signing, inside a secure enclave | Fast to ship, good ergonomics. Adds a trusted third party and a liveness dependency |
| **Onchain policy** (Safe + allowance module, ERC-4337 session keys with scoped permissions) | On-chain, by the account itself | Trust-minimised and self-custodial — no vendor can be compelled or compromised. More work, higher gas, less mature tooling |

Anchor's mission points at the second one. A vendor engine is a reasonable **stepping stone**, not the
destination — and the abstraction should be written so the enforcement backend is swappable from day
one. Concretely: the agent talks to an `Executor` interface; whether that is Privy or a Safe module is
a configuration detail, not an architectural one.

Privy is the likely first backend: per-transaction caps, allowlisted contracts, spending limits, keys
reconstituted only inside secure enclaves, and requests rejected at signing when they fall outside
policy. Bankr is worth evaluating alongside it.

## The controls

**Caps.** Per-transaction, rolling 24-hour, and rolling 7-day. Cumulative caps matter more than
per-transaction ones — a hundred small transfers is the obvious way around a single-transaction limit.

**Contract allowlist.** The agent may only touch the marketplace contracts it actually needs. Anything
else, including a freshly deployed "helpful" contract, is refused.

**An allowlist entry is a (chain, address) pair, never an address.** The same 20 hex bytes are a
different contract on every EVM chain, and `CREATE2` lets someone put chosen code at a chosen address
on a chain the user never configured — so an entry carrying no chain vouches for contracts nobody
approved. This matters most on the withdrawal list: nobody holds the key to "the same address on
another chain" unless they chose to.

**Action allowlist.** Buying below a threshold, accepting an offer above one, cancelling *its own*
listings. Nothing that delegates standing authority is on this list, ever — on EVM that is
`setApprovalForAll`, on Solana the SPL delegate and `SetAuthority`. Approvals are how wallets actually
get drained, and they are worth treating as a separate, human-only action class. See
[security.md](security.md) for the membership test and the full list.

**Withdrawal allowlist — the important one.** The agent may transfer assets *only* to addresses the
user pre-registered, ideally a single cold vault. Changing that list is a human action with a
time-lock. Almost every catastrophic outcome routes through "funds left to an attacker's address," and
this control cuts that path regardless of what else goes wrong.

**Velocity and cooldown.** Rate limits per hour, and an automatic pause after anomalies — an unusual
burst, repeated policy rejections, or a loss. Policy rejections are a signal the agent is confused or
driven; treat a cluster of them as an incident, not as noise.

**Simulation before signing.** Simulate, show the expected asset delta, and refuse on mismatch. Never
sign a payload whose effects haven't been computed.

**Slippage is a spend control.** Easy to miss, because it looks like a trading parameter. A limit of
"$500 per transaction" means nothing if a swap executes at 90% price impact — the agent spent $500,
received $50, and every dollar cap was respected. A maximum slippage and a minimum liquidity floor
belong in the policy beside the dollar limits, enforced in the same place.

**Cap exposure per asset, not only per transaction.** Ten separate $50 buys of one token is a $500
position. Per-item caps work for NFTs because each purchase is a distinct thing; fungible assets
need the policy to hold state across transactions.

**A quote is not a price.** Swap quotes expire. An approval must be bound to the quote it approved and
refused if that quote has moved beyond tolerance, or the decision was made against a number that no
longer exists.

**Time-locks above a threshold.** Large transactions queue with a delay and a notification. The delay
is what converts "I'm asleep" into "I had four hours to hit cancel."

**A kill switch that works.** One command revokes the agent's authority — a session key revocation or
a policy set to zero. It must work from the phone, without the desktop, and it must be the single most
prominent control in the UI.

## The value ladder

Trust is earned in bands. Each promotion needs a clean incident record, not just a calendar date.

| Tier | Balance | Per-tx | Rolling 24h | Added at this tier |
|---|---|---|---|---|
| 0 · Observe | $0 | — | — | Read-only. Proposals surface in the UI; nothing signs |
| 1 · Pocket | ~$100 | $25 | $50 | Contract + withdrawal allowlists, notification per transaction |
| 2 · Working | ~$1,000 | $150 | $300 | Velocity limits, mandatory simulation, auto-pause on anomaly |
| 3 · Serious | ~$10,000 | $1,000 | $2,000 | Human co-sign above per-tx cap, time-lock on transfers out, weekly review |
| 4 · Vault | $100,000+ | policy % | policy % | Onchain-enforced policy, dual control, withdrawal address changes time-locked for days |

Promotion criteria: a set period with no policy violations, no unexplained rejections, and every
transaction reviewed at least in a digest. Demotion is automatic on any incident — the ladder goes both
ways, or it isn't a safety mechanism.

## Observability

Autonomy without a record is indistinguishable from theft after the fact.

- Every action logged locally with the request, the policy decision, and the resulting hash.
- A notification per transaction at low tiers; a digest at high ones. The user should never learn what
  the agent did by checking a block explorer.
- Anchor's local data service is the natural home for this log — it already tracks freshness and is
  read-only, so the record cannot be edited by the thing being recorded.

## Named risks

Being honest about what this model does *not* solve:

- **Vendor risk.** A hosted policy engine can be compromised, compelled, or go down. Onchain
  enforcement is the answer; until then, size balances to your tolerance for that dependency.
- **Policy bugs are the new key leak.** A wrong allowlist entry is now the vulnerability class. Policy
  changes deserve review, and ideally a time-lock of their own.
- **A convinced agent is a hostile agent.** Prompt injection from a listing title, a collection
  description, or a scraped page is a live attack path. Policy holds regardless — which is exactly why
  it must live outside the agent, and why untrusted marketplace content must never be able to widen it.
- **Approvals are not transfers.** A token approval moves no funds and looks harmless in a spend cap,
  yet hands over everything. They must be modelled as their own action class with their own limits.
- **A vendor's rule language is not the same on every chain.** Privy's EVM policies can name a
  function and refuse it; their Solana policies cannot name `Approve` or `SetAuthority` at all, and
  have no cumulative-spend primitive of any window. "The vendor supports Solana" and "the vendor
  enforces the same policy on Solana" are different claims, and the second one is the one that
  matters. See [chains.md](chains.md).
- **Tokens are permissionless, so allowlists invert.** An NFT contract allowlist is a short list of
  marketplaces. Anything can deploy a token, so trading them needs default-deny plus a sellability
  check — honeypots and vanishing liquidity are a risk class with no NFT counterpart. See
  [tokens.md](tokens.md).

## Open questions

- Which backend first — Privy for speed, or a Safe module for trust-minimisation from the start?
- Does the co-sign step at tier 3+ go through iMessage, the desktop, or a hardware device?
- Should policy state be mirrored onchain even when a vendor enforces it, so the user can audit limits
  without trusting the vendor's dashboard?
