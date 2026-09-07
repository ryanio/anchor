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
- **Token approvals are their own action class.** `setApprovalForAll` moves no funds and slips past a
  spend cap, yet hands over everything. It is never delegated to the agent.
- **A kill switch must work from the phone, without the desktop.**

The full model — control surface, value tiers from $100 to $100k+, vendor versus onchain enforcement,
and the named residual risks — is in [autonomy.md](autonomy.md).

## Tokens and credentials

- Use the **least-privilege scoped token** the API offers.
- Store tokens in the **OS keyring**. Never in a config file, a theme file, an environment file that
  gets committed, or an agent prompt.
- `.env` is gitignored and must stay that way.

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
