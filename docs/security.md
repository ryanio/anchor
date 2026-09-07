# Security model

These constraints define the project. Anything that violates one is out of scope, however convenient.

## Keys and signing

The agent is meant to act autonomously, including sending onchain transactions and holding real value.
The safety property is **not** "the agent cannot transact" — it is that **the agent never holds
unbounded authority.**

- **Policy is enforced outside the agent**, at signing time, by a key-management service with a policy
  engine or by an onchain smart-account module. The agent can request; it cannot approve its own
  request. A compromised desktop therefore inherits the *policy budget*, not the balance.
- **Private keys and seed phrases never touch this codebase**, an agent process, device firmware, or a
  log file. Keys live in a secure enclave or a smart account — never in Anchor.
- **Withdrawals go only to pre-registered addresses.** Changing that list is a human action with a
  time-lock. This is the single control that makes a large balance survivable.
- **Delegating standing authority is its own action class.** `setApprovalForAll` moves no funds and
  slips past a spend cap, yet hands over everything. It is never delegated to the agent — and neither
  are its Solana counterparts, which are not the same call and in one case are worse. The test for
  membership is that an action *moves no value*, *grants an authority that outlives the transaction*,
  and *needs a second action to revoke that nobody can guarantee happens*:

  | Chain | Action | Why |
  |---|---|---|
  | EVM | `setApprovalForAll` | blanket operator rights over a whole collection |
  | Solana | SPL `Approve` / `ApproveChecked` / `Revoke` | names a delegate over a token account's balance; `u64::MAX` is unlimited, and a bounded amount is still a delegation |
  | Solana | SPL `SetAuthority` | not a limit on spending the account — it *is* the account, or the mint, or a program's upgrade authority |
  | Solana | System `Assign` / `AssignWithSeed` | the widest member, and the one an SPL-only reading misses. A wallet account is system-owned, and an account's owner program may debit its lamports with **no signature from anyone** — so one `Assign` hands over the whole native balance, at a time the attacker picks |
  | Solana | System `AuthorizeNonceAccount` | a durable nonce authority is the standing power to hold a signed transaction and replay it later |
  | Solana | BPF upgradeable loader | replacing a program's code means the program that was audited is not the program that runs |

  Closing an account is deliberately **not** in the class: it moves value (a wrapped-SOL close sends
  the whole lamport balance to a destination the instruction names), so it belongs under the
  withdrawal allowlist rather than under a blanket refusal. Arbitrary program invocation is not in
  the class either, because it is not an action — the answer to it is that a request carries intent
  and never instructions or bytes.

- **A fee is a spend, and on Solana it is an unbounded one.** Not the class above — a priority fee
  grants no standing authority and is over when the block is — but it fails the same first test, for
  a different reason: it produces **no asset delta**, so it appears in no simulation and no rolling
  window, and every cap in [autonomy.md](autonomy.md) is blind to it. Solana's `SetComputeUnitPrice`
  names a price in micro-lamports *per compute unit* as a `u64`; at the maximum unit limit of
  1,400,000 that is the account's entire native balance, paid to a validator. It is refused against
  a ceiling in `executor/src/solana.ts`, and that ceiling is local: Privy's policy engine has no
  Compute Budget condition source, so no remote rule can bound it. The general lesson is the one
  worth keeping — **an allowlisted program is permission to be inspected, not permission to run.**
  Both holes found so far were an allowlisted program whose instructions nobody read.
- **A kill switch must work from the phone, without the desktop.**

The full model — control surface, value tiers from $100 to $100k+, vendor versus onchain enforcement,
and the named residual risks — is in [autonomy.md](autonomy.md).

## Tokens and credentials

- Use the **least-privilege scoped token** the API offers.
- Store tokens in the **OS keyring**. Never in a config file, a theme file, an environment file that
  gets committed, or an agent prompt.
- `.env` is gitignored and must stay that way.
- One documented exception: `ANCHOR_OPENSEA_API_KEY` is read from the environment for CI and
  development. A process environment is readable at `/proc/<pid>/environ` and is inherited by child
  processes, so it is strictly weaker than the keyring. The keyring is the supported path for real
  use; this is named here so the list above is exhaustive rather than aspirational.
- **There is one OpenSea credential: the API key.** Every read Anchor makes works with it alone.
  An earlier version of this file claimed a second credential was required for account-scoped
  reads; that claim was retracted in #28 and this paragraph was the copy it missed. The original
  measurement was taken with a keyring entry holding a shell command, against
  `/collections/{slug}/stats` — an endpoint that is public and returns 200 with no key at all, so
  the control passed for the wrong reason. See the "Measuring things" section of `AGENTS.md`, which
  exists because of it.

  `service/src/auth.ts` still mints a wallet JWT from a PAT stored as `opensea-pat`, but it gates
  nothing and no route Anchor calls needs one. If a PAT is ever stored it gets **no**
  environment-variable escape hatch, because unlike the API key it carries whatever scopes it was
  created with, which can include write scopes — the executor's credentials follow the same rule.
  No credential appears in a log line or an error message: every error the service produces is built
  from a status code we recognise, never from a response body. See `service/README.md`.

## Data

- Cache locally; make **freshness visible** in the UI. A stale floor price shown as current is a bug.
- Treat floor prices, mint eligibility, and social signals as **hints, not facts**.
- The idle screensaver must never fetch or display private wallet data while the desktop is locked.

## Network exposure

- Keep device control and any local broker **on loopback or behind Tailscale**.
- Never expose an unauthenticated dashboard, MQTT broker, or API to the LAN or internet.

## Agent involvement

Agents summarise activity, watch collections, draft proposals, and — within policy — execute. What they
must never do is decide their own limits. Every agent output that informs a decision must cite its data
source and timestamp.

Untrusted marketplace content (listing titles, collection descriptions, scraped pages) is a live
prompt-injection surface. Policy holds regardless of what the agent is convinced of, which is precisely
why policy lives outside it.

If a hardware device is ever added as an approval surface, it is a **display and presence gate**, not a
key store — commodity microcontrollers have no certified secure element and must be assumed extractable
on physical possession.
