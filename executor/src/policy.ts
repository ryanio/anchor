/**
 * ## REFERENCE IMPLEMENTATION — NOT AN ENFORCEMENT BACKEND
 *
 * An in-memory {@link PolicyAuthority} that documents the intended semantics of Anchor's spend
 * controls in a form that runs and can be tested.
 *
 * **It signs nothing, submits nothing, and holds no key.** It runs in the same process as the thing
 * it judges, which means it provides *no security property at all* — a compromised process can
 * reach in and rewrite its limits. Real enforcement happens where the agent cannot reach it: inside
 * a vendor's secure enclave (Privy, Turnkey) or on chain in the account itself (a Safe allowance
 * module, ERC-4337 session keys). Those backends implement the same interface; this one exists so
 * the interface has a worked example and the rules have a regression suite.
 *
 * Use it for tests and for reading. Do not point it at a wallet with money in it.
 *
 * The rules implemented here are the ones in docs/autonomy.md:
 * per-transaction cap, rolling 24h and 7d caps, contract allowlist, action allowlist, withdrawal
 * destination allowlist, mandatory simulation, and a kill switch.
 */
import {
  type ApprovedAction,
  allow,
  type Denied,
  deny,
  mintApproval,
  type PolicyDecision,
} from "./decision.ts";
import type { ExecutorStatus, PolicyAuthority, RevocationReceipt, Settlement } from "./executor.ts";
import {
  type ActionRequest,
  allowlistHas,
  type ChainAddress,
  chainAddress,
  type DelegableActionKind,
  describeMalformation,
  formatChainAddress,
  type HumanOnlyActionKind,
  incomingValue,
  isHumanOnlyActionKind,
  money,
  outgoingDenominations,
  outgoingDestinations,
  outgoingValue,
  type Simulation,
  sameChainAddress,
  subjectContract,
} from "./types.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * A policy's limits. Mirrors a tier row from the value ladder in docs/autonomy.md.
 *
 * Every amount is in `denomination`'s smallest unit. There is no conversion: a request denominated
 * in anything else is denied rather than converted, because a policy whose effective size depends
 * on an exchange rate is not a policy.
 */
export interface PolicyLimits {
  /** Accounting unit for every cap here. Compared by exact string equality. */
  readonly denomination: string;
  /** Maximum value that may leave the account in one transaction. */
  readonly perTransaction: bigint;
  /** Maximum value that may leave in any rolling 24 hours. */
  readonly rolling24h: bigint;
  /** Maximum value that may leave in any rolling 7 days. */
  readonly rolling7d: bigint;
  /**
   * Which actions may be delegated at all.
   *
   * Typed as {@link DelegableActionKind}, which excludes every human-only kind — EVM's
   * `set-approval-for-all` and Solana's `approve-delegate` and `set-authority`. You cannot put one
   * on this list; the compiler refuses (docs/security.md, and `HUMAN_ONLY_ACTION_KINDS` in
   * types.ts). This is that rule expressed where it cannot be forgotten.
   */
  readonly allowedActions: readonly DelegableActionKind[];
  /**
   * Contracts the agent may touch, each scoped to its chain. Anything else, including a new
   * "helpful" contract, is denied — and including the *same* address on a chain that is not the one
   * it was allowlisted for, which a bare-string allowlist would have permitted.
   */
  readonly contractAllowlist: readonly ChainAddress[];
  /**
   * Pre-registered withdrawal destinations, each scoped to its chain. The single control that makes
   * a large balance survivable: almost every catastrophic outcome routes through "funds left to an
   * attacker's address". Changing this list is a human action with a time-lock — never something the
   * agent or this class can do at run time.
   */
  readonly withdrawalAllowlist: readonly ChainAddress[];
  /** Floor on offer proceeds the agent may accept. `0n` disables the check. */
  readonly minAcceptOfferProceeds: bigint;
  /** How long a minted approval stays usable. Short by design. */
  readonly approvalTtlMs: number;
}

export interface PolicyEngineOptions {
  readonly limits: PolicyLimits;
  /** Version string carried on every decision, so a log can be replayed against known rules. */
  readonly policyVersion?: string;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

interface LedgerEntry {
  readonly approvalId: string;
  readonly amount: bigint;
  readonly at: number;
  state: "reserved" | "committed" | "released";
}

/**
 * In-memory reference policy engine. See the file header: this enforces nothing in production.
 */
export class PolicyEngine implements PolicyAuthority {
  readonly #limits: PolicyLimits;
  readonly #version: string;
  readonly #now: () => number;
  readonly #ledger: LedgerEntry[] = [];
  readonly #seenRequestIds = new Set<string>();
  readonly #approvalCharges = new Map<string, LedgerEntry>();
  #revoked = false;
  #revokedReason: string | undefined;
  #approvalCounter = 0;

  constructor(options: PolicyEngineOptions) {
    const limits = options.limits;

    // Defensive runtime check to match the type-level one. `allowedActions` is typed so that no
    // human-only kind can appear, but limits loaded from JSON at run time have not been through the
    // compiler, and this is the one mistake we will not accept as a possibility. Both checks read
    // the same `HUMAN_ONLY_ACTION_KINDS` constant, so neither can be tightened without the other.
    for (const action of limits.allowedActions as readonly string[]) {
      if (isHumanOnlyActionKind(action)) {
        throw new Error(`${action} is a human-only action class and can never be on an action allowlist`);
      }
    }
    if (limits.perTransaction < 0n || limits.rolling24h < 0n || limits.rolling7d < 0n) {
      throw new RangeError("caps must not be negative");
    }

    this.#limits = limits;
    this.#version = options.policyVersion ?? "reference-in-memory/1";
    this.#now = options.now ?? Date.now;
  }

  // --- Decision --------------------------------------------------------------------------------

  async evaluate(request: ActionRequest, simulation: Simulation): Promise<PolicyDecision> {
    const now = this.#now();
    const ctx = { requestId: request.id, decidedAt: now, policyVersion: this.#version };
    const no = (reason: Parameters<typeof deny>[0], detail: string): Denied => deny(reason, detail, ctx);

    // 1. Kill switch first. A revoked policy answers nothing else.
    if (this.#revoked) {
      return no("revoked", `authority revoked: ${this.#revokedReason ?? "no reason recorded"}`);
    }

    // 2. Replay. A decided request id is spent, whatever the outcome was.
    if (this.#seenRequestIds.has(request.id)) {
      return no("duplicate-request", `request id ${request.id} has already been decided`);
    }

    // 3. Human-only action classes. Checked before everything else that could refuse them so the
    //    denial has its own reason code and its own alert, rather than being lost among ordinary
    //    "not allowed" noise — a request for one of these is a signal about the agent, not about
    //    the request. Checked ahead of the well-formedness check too: a malformed request for a
    //    delegation is still a request for a delegation, and that is the more useful thing to know.
    if (isHumanOnlyActionKind(request.kind)) {
      this.#seenRequestIds.add(request.id);
      return no("human-only-action", humanOnlyDetail(request.kind));
    }

    this.#seenRequestIds.add(request.id);

    // 4. Well-formedness. Every address a request names must belong to the chain it declares.
    //    A Solana account on `chain: "ethereum"` is either a typo or an attempt to have an EVM
    //    allowlist entry vouch for a Solana address; either way it is not a policy question.
    const malformation = describeMalformation(request);
    if (malformation !== null) return no("malformed-request", malformation);

    // 5. Action allowlist.
    if (!this.#limits.allowedActions.includes(request.kind)) {
      return no("action-not-allowed", `action ${request.kind} is not on the action allowlist`);
    }

    // 6. Contract allowlist, compared on the (chain, address) pair. The same 20 hex bytes name a
    //    different contract on every EVM chain, so an allowlist entry for one chain must never
    //    match an address on another.
    const subject = subjectContract(request);
    if (!allowlistHas(this.#limits.contractAllowlist, subject)) {
      return no(
        "contract-not-allowlisted",
        `contract ${formatChainAddress(subject)} is not on the contract allowlist`,
      );
    }

    // 7. Simulation is mandatory. Never judge a payload whose effects have not been computed.
    if (!simulation.ok) {
      return no("simulation-failed", simulation.failure ?? "simulation did not succeed");
    }
    if (simulation.requestId !== request.id) {
      return no(
        "simulation-mismatch",
        `simulation is for request ${simulation.requestId}, not ${request.id}`,
      );
    }

    // 8. Units. Refuse to judge value the caps cannot be compared against.
    const denom = this.#limits.denomination;
    for (const seen of outgoingDenominations(simulation)) {
      if (seen !== denom) {
        return no(
          "denomination-mismatch",
          `simulation moves ${seen} out but this policy is denominated in ${denom}`,
        );
      }
    }
    const declaredDenom = declaredDenomination(request);
    if (declaredDenom !== null && declaredDenom !== denom) {
      return no("denomination-mismatch", `request is denominated in ${declaredDenom}, policy in ${denom}`);
    }

    // 9. Does the simulation agree with what the agent claimed it was doing?
    const mismatch = this.#checkSimulationAgreement(request, simulation, denom);
    if (mismatch !== null) return no("simulation-mismatch", mismatch);

    // 10. Offer floor. Selling far below what the policy considers worth transacting is either a
    //     mispriced offer or a manipulated one; either way it is not the agent's call.
    if (request.kind === "accept-offer") {
      const proceeds = incomingValue(simulation, denom).amount;
      if (proceeds < this.#limits.minAcceptOfferProceeds) {
        return no(
          "below-minimum-proceeds",
          `${proceeds} ${denom} is below the minimum acceptable proceeds of ` +
            `${this.#limits.minAcceptOfferProceeds}`,
        );
      }
    }

    // 11. Withdrawal destinations. Only for actions that actually move an asset to a third party
    //    the user chose — a marketplace sale is not a withdrawal, a transfer out is.
    //
    //    Both checks compare (chain, address) pairs. The simulation's destinations especially: a
    //    bridge or a cross-chain swap can land value on a chain the request never named, and an
    //    allowlist entry for the cold vault on one chain must not vouch for the same bytes on
    //    another — nobody controls the private key of an address they were merely given.
    if (request.kind === "transfer") {
      const declared = chainAddress(request.chain, request.to);
      if (!allowlistHas(this.#limits.withdrawalAllowlist, declared)) {
        return no(
          "destination-not-allowlisted",
          `${formatChainAddress(declared)} is not a pre-registered withdrawal address`,
        );
      }
      for (const destination of outgoingDestinations(simulation)) {
        if (!allowlistHas(this.#limits.withdrawalAllowlist, destination)) {
          return no(
            "destination-not-allowlisted",
            `simulation sends value to ${formatChainAddress(destination)}, which is not pre-registered`,
          );
        }
      }
    }

    // 12. Caps, charged on GROSS value leaving the account.
    //
    // Not net. Netting would let an attacker send $10k out and book an incoming asset they
    // valued themselves, arriving at a charge of zero — a wash trade is the standard way to drain
    // a wallet that only counts net flow. What leaves is what is charged, whatever comes back.
    const chargeable = outgoingValue(simulation, denom).amount;

    if (chargeable > this.#limits.perTransaction) {
      return no(
        "per-transaction-cap",
        `${chargeable} ${denom} exceeds the per-transaction cap of ${this.#limits.perTransaction}`,
      );
    }

    // Cumulative caps matter more than the per-transaction one: a hundred small transfers is the
    // obvious way around a single-transaction limit. Reserved-but-unsettled spend counts, so
    // holding approvals open does not create headroom.
    const spent24h = this.#spentWithin(DAY_MS, now);
    if (spent24h + chargeable > this.#limits.rolling24h) {
      return no(
        "rolling-24h-cap",
        `${chargeable} ${denom} would take rolling 24h spend to ${spent24h + chargeable}, ` +
          `over the cap of ${this.#limits.rolling24h}`,
      );
    }

    const spent7d = this.#spentWithin(WEEK_MS, now);
    if (spent7d + chargeable > this.#limits.rolling7d) {
      return no(
        "rolling-7d-cap",
        `${chargeable} ${denom} would take rolling 7d spend to ${spent7d + chargeable}, ` +
          `over the cap of ${this.#limits.rolling7d}`,
      );
    }

    // Allowed. Mint the approval and reserve the budget in the same step, so there is no window in
    // which an approval exists but is not accounted for.
    const approvalId = `approval-${++this.#approvalCounter}`;
    const entry: LedgerEntry = { approvalId, amount: chargeable, at: now, state: "reserved" };
    this.#ledger.push(entry);
    this.#approvalCharges.set(approvalId, entry);
    this.#prune(now);

    return allow(
      mintApproval({
        approvalId,
        request,
        simulation,
        ceiling: money(chargeable, denom),
        expiresAt: now + this.#limits.approvalTtlMs,
        decidedAt: now,
        policyVersion: this.#version,
      }),
    );
  }

  async settle(approval: ApprovedAction, outcome: Settlement): Promise<void> {
    const entry = this.#approvalCharges.get(approval.approvalId);
    if (!entry) return;
    if (entry.state !== "reserved") return; // settling twice must not double-release.
    entry.state = outcome === "committed" ? "committed" : "released";
  }

  // --- Kill switch -----------------------------------------------------------------------------

  /**
   * Revoke all delegated authority. Idempotent; the first reason recorded is the one kept.
   *
   * In a real backend this is a session-key revocation or a policy set to zero, and it must work
   * from the user's phone without the desktop being reachable. Here it flips a flag, and every
   * subsequent `evaluate` denies with `"revoked"` before looking at anything else.
   */
  async revoke(reason: string): Promise<RevocationReceipt> {
    const at = this.#now();
    if (!this.#revoked) {
      this.#revoked = true;
      this.#revokedReason = reason;
    }
    return {
      revoked: true,
      reason: this.#revokedReason ?? reason,
      revokedAt: at,
      policyVersion: this.#version,
    };
  }

  /**
   * Restore authority after a revocation.
   *
   * Deliberately **not** on {@link PolicyAuthority} or {@link import("./executor.ts").Executor}: an
   * agent holding either interface has a kill switch and no way to undo it. Reinstatement is a
   * human action, performed against the concrete backend, and in a real deployment it belongs
   * behind the same time-lock as a withdrawal-allowlist change.
   */
  reinstateByHuman(operatorNote: string): void {
    if (operatorNote.trim() === "") {
      throw new Error("reinstatement requires an operator note for the audit log");
    }
    this.#revoked = false;
    this.#revokedReason = undefined;
  }

  // --- Reporting -------------------------------------------------------------------------------

  async status(): Promise<ExecutorStatus> {
    const now = this.#now();
    const denom = this.#limits.denomination;
    return {
      revoked: this.#revoked,
      ...(this.#revokedReason === undefined ? {} : { revokedReason: this.#revokedReason }),
      policyVersion: this.#version,
      denomination: denom,
      perTransactionCap: money(this.#limits.perTransaction, denom),
      rolling24hCap: money(this.#limits.rolling24h, denom),
      rolling24hSpent: money(this.#spentWithin(DAY_MS, now), denom),
      rolling7dCap: money(this.#limits.rolling7d, denom),
      rolling7dSpent: money(this.#spentWithin(WEEK_MS, now), denom),
      allowedActions: [...this.#limits.allowedActions],
      contractAllowlistSize: this.#limits.contractAllowlist.length,
      withdrawalAllowlistSize: this.#limits.withdrawalAllowlist.length,
    };
  }

  // --- Internals -------------------------------------------------------------------------------

  /** Reserved and committed spend inside a rolling window ending now. Released spend is free. */
  #spentWithin(windowMs: number, now: number): bigint {
    const cutoff = now - windowMs;
    let total = 0n;
    for (const entry of this.#ledger) {
      if (entry.state === "released") continue;
      if (entry.at <= cutoff) continue;
      total += entry.amount;
    }
    return total;
  }

  /** Drop entries that can no longer affect any window. Keeps a long-lived engine bounded. */
  #prune(now: number): void {
    const cutoff = now - WEEK_MS;
    let keep = 0;
    for (const entry of this.#ledger) {
      if (entry.at > cutoff) this.#ledger[keep++] = entry;
      else this.#approvalCharges.delete(entry.approvalId);
    }
    this.#ledger.length = keep;
  }

  /**
   * Cross-check the simulation against the request's own claims.
   *
   * The request is the agent's assertion; the simulation is the evidence. Where they disagree, the
   * answer is always to deny — never to prefer the assertion, and never to "fix up" the request.
   * Returns a reason string on mismatch, or `null` when they agree.
   */
  #checkSimulationAgreement(request: ActionRequest, simulation: Simulation, denom: string): string | null {
    const out = outgoingValue(simulation, denom).amount;
    const incoming = incomingValue(simulation, denom).amount;

    switch (request.kind) {
      case "buy": {
        if (out > request.maxPrice.amount) {
          return `simulation spends ${out} ${denom}, above the declared max price of ${request.maxPrice.amount}`;
        }
        if (!simulation.deltas.some((d) => d.direction === "in")) {
          return "a buy that receives nothing is not a buy";
        }
        return null;
      }
      case "accept-offer": {
        if (incoming < request.minProceeds.amount) {
          return `simulation yields ${incoming} ${denom}, below the declared minimum proceeds of ${request.minProceeds.amount}`;
        }
        if (!simulation.deltas.some((d) => d.direction === "out")) {
          return "accepting an offer must part with the token";
        }
        return null;
      }
      case "cancel-own-listing": {
        if (out > 0n) {
          return `cancelling a listing must not move value, but the simulation sends ${out} ${denom}`;
        }
        return null;
      }
      case "transfer": {
        if (out > request.valuation.amount) {
          return `simulation moves ${out} ${denom}, above the declared valuation of ${request.valuation.amount}`;
        }
        const declared = chainAddress(request.chain, request.to);
        for (const destination of outgoingDestinations(simulation)) {
          if (!sameChainAddress(destination, declared)) {
            return (
              `simulation sends to ${formatChainAddress(destination)}, but the request declared ` +
              formatChainAddress(declared)
            );
          }
        }
        return null;
      }
      case "set-approval-for-all":
      case "approve-delegate":
      case "set-authority": {
        // Unreachable: rejected far earlier. Present so the switch stays exhaustive, and so adding
        // a new action kind is a compile error here rather than a silent pass.
        return "human-only actions are never evaluated";
      }
    }
  }
}

/**
 * Why a human-only action was refused, in words a notification can carry.
 *
 * One arm per kind rather than one shared sentence: these are different hazards, the operator
 * reading the alert needs to know which one arrived, and an exhaustive switch means a new member of
 * `HUMAN_ONLY_ACTION_KINDS` cannot be added without someone writing down why it is on the list.
 */
function humanOnlyDetail(kind: HumanOnlyActionKind): string {
  switch (kind) {
    case "set-approval-for-all":
      return (
        "setApprovalForAll is never delegated to an agent. It moves no funds, slips past every " +
        "spend cap, and hands over the whole collection. A human performs this action directly or " +
        "it does not happen."
      );
    case "approve-delegate":
      return (
        "an SPL token delegate is never named by an agent. Approve moves no funds, so no spend cap " +
        "sees it, and it grants standing authority over the token account's balance that outlives " +
        "this transaction — u64::MAX is unlimited, and a smaller amount is still a delegation. " +
        "Revoking is a separate action nobody can guarantee happens."
      );
    case "set-authority":
      return (
        "SetAuthority is never delegated to an agent. It does not bound what someone may spend " +
        "from the account — it hands over the account, the mint, or the power to replace a " +
        "program's code at an unchanged address. A human performs this directly or it does not " +
        "happen."
      );
  }
}

/** The denomination a request declares, if it declares one. */
function declaredDenomination(request: ActionRequest): string | null {
  switch (request.kind) {
    case "buy":
      return request.maxPrice.denomination;
    case "accept-offer":
      return request.minProceeds.denomination;
    case "transfer":
      return request.valuation.denomination;
    case "cancel-own-listing":
    case "set-approval-for-all":
    case "approve-delegate":
    case "set-authority":
      return null;
  }
}

/** Convenience for the value-ladder tiers in docs/autonomy.md. Amounts are in USD cents. */
export function tierLimits(
  tier: 1 | 2 | 3,
  lists: {
    contractAllowlist: readonly ChainAddress[];
    withdrawalAllowlist: readonly ChainAddress[];
  },
): PolicyLimits {
  const shared = {
    denomination: "USD-cents",
    allowedActions: ["buy", "accept-offer", "cancel-own-listing", "transfer"],
    minAcceptOfferProceeds: 0n,
    approvalTtlMs: 60_000,
    ...lists,
  } satisfies Omit<PolicyLimits, "perTransaction" | "rolling24h" | "rolling7d">;

  switch (tier) {
    case 1:
      return { ...shared, perTransaction: 2_500n, rolling24h: 5_000n, rolling7d: 20_000n };
    case 2:
      return { ...shared, perTransaction: 15_000n, rolling24h: 30_000n, rolling7d: 120_000n };
    case 3:
      return { ...shared, perTransaction: 100_000n, rolling24h: 200_000n, rolling7d: 800_000n };
  }
}

export { DAY_MS, WEEK_MS };
