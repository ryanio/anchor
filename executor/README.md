# executor

The **policy-bound execution seam** — roadmap step 6.

Anchor's agent is meant to act while holding real value. The safety property is not "the agent cannot
transact"; it is that **the agent never holds unbounded authority** (docs/security.md). This
workspace is the abstraction that makes that true by construction, and makes the enforcement backend
— a vendor policy engine (Privy, Turnkey) or an onchain module (a Safe allowance module, ERC-4337
session keys) — a configuration choice rather than an architectural one.

> **Nothing here signs or submits anything.** The `PolicyEngine`, `DeclaredIntentSimulator` and
> `InertSigner` in this package are reference implementations: they document the intended semantics
> in a form that runs and can be tested. They hold no key, reach no network, and provide **no
> security property**, because they run in the same process as the thing they judge. Real
> enforcement lives where the agent cannot reach it.

## The pipeline

```
  request   →   simulate   →   decide    →   submit   →   result
  (agent)       Simulator      Policy-       Signer       ExecutionResult
                               Authority
```

Four parties, four interfaces, split along exactly those lines so that holding one does not get you
the next.

| Interface | Who implements it | Who holds it |
|---|---|---|
| `Executor` | `PolicyBoundExecutor` (composition) | the agent |
| `Simulator` | Tenderly, an `eth_call` fork, a bundler | the executor |
| `PolicyAuthority` | Privy / Turnkey / Safe module — `PolicyEngine` here | the executor, remotely |
| `Signer` | the enclave or the smart account | the executor, remotely |

## Why the agent cannot approve its own request

AGENTS.md invariant 1: *the thing that requests cannot be the thing that decides.* That is easy to
say and easy to lose to a refactor, so it is encoded three independent ways.

**1 · Decisions flow outward only.** `PolicyDecision` appears in every *return* type on `Executor`
and in no *parameter* type. There is no method that accepts a decision, an approval, a policy, or a
"trusted" flag. "Here is my own approval, please submit it" is not a sentence the API can express.

**2 · `ApprovedAction` is unforgeable at compile time.** It carries a property keyed by a
`unique symbol` that `decision.ts` declares and deliberately does not export. A `unique symbol` is
nominally typed and a key that cannot be named cannot appear in an object literal, so this fails to
compile anywhere in the codebase:

```ts
const forged: ApprovedAction = { approvalId: "mine", request, simulation, ceiling, /* … */ };
//    ~~~~~~ Property '[POLICY_WITNESS]' is missing in type '{ … }'
```

**3 · `ApprovedAction` is unforgeable at run time.** TypeScript is defeatable with a cast, so the
brand is backed by identity: `mintApproval` is the only function that adds an object to a
module-private `WeakSet`, and `Signer.submit` checks membership before doing anything. The witness
property has no runtime representation at all — there is nothing on the object to copy — so a spread,
a `structuredClone`, or a trip through JSON all produce something the signer refuses. **Authority
does not survive being written down.**

`Signer.submit` takes an `ApprovedAction` and nothing else. A compromised agent holding a `Signer`
reference still has nothing it can pass to it.

What none of this defends against is a caller that constructs its own `PolicyEngine` and evaluates
against limits it wrote. That is not a type problem — it is why real enforcement runs *outside the
agent's process*. The types make the seam impossible to cross by accident; process and key custody
make it impossible to cross on purpose.

## Controls implemented by the reference engine

Straight from docs/autonomy.md:

- **Per-transaction cap**, and **rolling 24h / 7d caps**. The cumulative ones matter more — a hundred
  small transfers is the obvious way around a single-transaction limit, and there is a test that
  fires a hundred of them.
- **Contract allowlist.** Including against a freshly deployed "helpful" contract.
- **Action allowlist.** `buy`, `accept-offer`, `cancel-own-listing`, `transfer`.
- **Withdrawal destination allowlist.** Only pre-registered addresses. The list is constructor state;
  nothing on any interface can widen it at run time.
- **Mandatory simulation.** A request is the agent's claim; the simulation is the evidence. Where
  they disagree the answer is always to deny — never to prefer the claim.
- **Kill switch.** `revoke()` denies everything afterwards, ahead of every other check.

Two accounting decisions worth knowing about:

- **Caps charge gross outflow, not net.** Netting would let an attacker send real value out and book
  something they valued themselves coming in, arriving at a charge of zero. A wash trade is the
  standard way to drain a wallet that counts net flow.
- **Budget is reserved at approval, not at settlement.** Otherwise an agent that simply never settles
  would hold unlimited live approvals — the many-small-transactions evasion wearing a different hat.
  `settle(approval, "failed")` releases the reservation.

## `setApprovalForAll`

A human-only action class, never delegated (docs/security.md). It is enforced at three levels:

- **Type level.** `PolicyLimits.allowedActions` is typed `DelegableActionKind`, which is
  `Exclude<ActionKind, "set-approval-for-all">`. It cannot be configured onto an allowlist — the
  compiler refuses.
- **Run time.** `PolicyEngine` throws at construction if limits loaded from JSON contain it anyway.
- **Decision.** It is denied with its own reason code, `"human-only-action"`, checked before the
  action allowlist so the refusal is countable rather than lost among ordinary denials.

It is *representable* in `ActionRequest` on purpose. An agent that cannot name the action it wants
will encode it as something else, and the denial becomes an accident of parsing rather than a rule.
There is no fixture for it: the request is built inline in the tests that prove it is refused, so it
cannot be lifted into working code.

## Kill switch

`Executor.revoke(reason)` is one-way from the agent's side. There is no `reinstate` on `Executor` or
on `PolicyAuthority` — restoring authority is a human action, lives only on the concrete backend, and
in a real deployment belongs behind the same time-lock as a withdrawal-allowlist change.

In a real backend `revoke` is a session-key revocation or a policy set to zero, and it must work from
the user's phone without the desktop being reachable.

## Not implemented yet

Named so the gap is visible rather than assumed: velocity limits and cooldowns, auto-pause on a
cluster of policy rejections, time-locks above a threshold, human co-sign at tier 3+, and persistence
of the spend ledger (it is in memory, so a restart currently forgets the day's spend — which a real
backend must not do).

## Development

Zero runtime dependencies, native Node TypeScript execution, no build step.

```bash
npm install        # dev only: @types/node + typescript
npm run typecheck
npm test           # node --test
```

Some tests are compile-time assertions written as `@ts-expect-error`. A `@ts-expect-error` on a line
that stops being an error is itself a compile error, so if someone removes the witness from
`ApprovedAction` — making self-approval possible again — `npm run typecheck` fails. The invariant is
enforced by CI rather than by a comment asking nicely.
