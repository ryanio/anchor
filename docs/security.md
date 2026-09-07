# Security model

These constraints define the project. Anything that violates one is out of scope, however convenient.

## Keys and signing

- **Private keys and seed phrases never touch this codebase**, an agent, device firmware, or a log file.
- Anchor **proposes**; it does not execute. There is no code path that submits an onchain transaction.
- Asset-moving actions require explicit **hardware-wallet approval** by a human. The intent queue hands
  off a prepared action; a wallet signs it.

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

Agents are useful for summarizing activity, watching collections, and drafting proposals. They are not
useful as autonomous traders, and Anchor will not ship that. Every agent output must cite its data
source and timestamp.

If a hardware device is ever added as an approval surface, it is a **display and presence gate**, not a
key store — commodity microcontrollers have no certified secure element and must be assumed extractable
on physical possession.
