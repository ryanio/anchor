/**
 * The `Executor` seam — roadmap step 6.
 *
 * Anchor's agent talks to an `Executor`. Whether the enforcement behind it is a vendor policy
 * engine (Privy, Turnkey) or an onchain module (a Safe allowance module, ERC-4337 session keys with
 * scoped permissions) is a configuration detail, not an architectural one (docs/autonomy.md). This
 * file is the shape that makes that swap a constructor argument.
 *
 * ## The pipeline
 *
 * ```
 *   request  →  simulate  →  decide  →  submit  →  result
 *   (agent)     Simulator    Policy-    Signer     ExecutionResult
 *                            Authority
 * ```
 *
 * Each arrow is a different party, and the interfaces are split along exactly those lines so that
 * holding one does not get you the next:
 *
 * - The agent holds an {@link Executor}. Its methods take requests and return decisions. There is
 *   no method that *accepts* a decision, an approval, or a policy — so an agent cannot approve, and
 *   cannot widen what it is approved for. The API has no verb for it.
 * - {@link PolicyAuthority} is the only producer of an `ApprovedAction`. It lives behind the
 *   process/enclave/chain boundary in a real deployment.
 * - {@link Signer} is the only consumer of one, and it accepts *nothing else* — its parameter type
 *   is `ApprovedAction`, which by construction cannot be forged (see decision.ts). A signer with a
 *   raw `ActionRequest` in hand has no method to call.
 *
 * Note also what is absent: there is no `reinstate` on `Executor`. Revoking is something the agent
 * (or a watchdog, or the user's phone) may do; restoring authority is a human action and lives only
 * on the concrete backend's administrative surface, which the agent does not hold a reference to.
 * The kill switch is one-way from this side.
 */
import type { ApprovedAction, Denied, PolicyDecision } from "./decision.ts";
import type { ActionRequest, Money, Simulation } from "./types.ts";

// --- Simulation ------------------------------------------------------------------------------

/**
 * Computes what a request would actually do.
 *
 * Separate from the policy so a backend can pair its own policy with a trusted simulation provider
 * (Tenderly, an eth_call fork, a bundler's estimation). Policy denies when this is missing or
 * disagrees with the request.
 */
export interface Simulator {
  simulate(request: ActionRequest): Promise<Simulation>;
}

// --- Policy ----------------------------------------------------------------------------------

/** What the kill switch returns, so a caller can prove to a human that it took effect. */
export interface RevocationReceipt {
  readonly revoked: true;
  readonly reason: string;
  readonly revokedAt: number;
  readonly policyVersion: string;
}

/** A snapshot of remaining authority, for the UI and for the audit log. */
export interface ExecutorStatus {
  readonly revoked: boolean;
  readonly revokedReason?: string;
  readonly policyVersion: string;
  readonly denomination: string;
  readonly perTransactionCap: Money;
  readonly rolling24hCap: Money;
  readonly rolling24hSpent: Money;
  readonly rolling7dCap: Money;
  readonly rolling7dSpent: Money;
  readonly allowedActions: readonly string[];
  readonly contractAllowlistSize: number;
  readonly withdrawalAllowlistSize: number;
}

/** How a submission attempt ended, reported back so reserved budget can be committed or released. */
export type Settlement = "committed" | "failed";

/**
 * The deciding half of the seam. Implemented by whatever actually enforces policy.
 *
 * In a real deployment this is a remote object: an HTTPS call into a vendor's enclave, or an
 * eth_call against a Safe module. It is an interface here so those are drop-in, and so the
 * reference implementation in `policy.ts` can document the intended semantics in a form that runs.
 */
export interface PolicyAuthority {
  /**
   * Judge a request against its simulation.
   *
   * Takes a request and evidence; returns a verdict. It does not take a *proposed* verdict, a
   * policy override, a "trusted" flag, or anything else the requester could use to influence the
   * outcome beyond the facts of the request itself.
   */
  evaluate(request: ActionRequest, simulation: Simulation): Promise<PolicyDecision>;

  /**
   * Report what happened after an approval was handed to a signer.
   *
   * Budget is reserved at approval time, not at settlement — otherwise an agent that never settles
   * would have an unbounded number of live approvals, which is the many-small-transactions evasion
   * wearing a different hat. `"failed"` releases the reservation; `"committed"` makes it permanent.
   */
  settle(approval: ApprovedAction, outcome: Settlement): Promise<void>;

  /** The kill switch. Idempotent, and must not require the desktop to be healthy. */
  revoke(reason: string): Promise<RevocationReceipt>;

  status(): Promise<ExecutorStatus>;
}

// --- Signing ---------------------------------------------------------------------------------

export interface SubmissionReceipt {
  readonly approvalId: string;
  readonly requestId: string;
  /** `null` when nothing was broadcast — the inert reference signer always returns `null`. */
  readonly transactionHash: string | null;
  readonly submittedAt: number;
  /** Which signer produced this, verbatim, for the log. */
  readonly signer: string;
  /** True only when a real network accepted it. The inert signer sets this false. */
  readonly broadcast: boolean;
}

/**
 * The signing half of the seam.
 *
 * `submit` takes an {@link ApprovedAction} and nothing else. That single parameter type is the
 * enforcement: there is no overload that takes a bare request, no `force` flag, and no way to
 * assemble the argument without a policy authority having minted it. A compromised agent holding a
 * `Signer` reference still has nothing to pass it.
 */
export interface Signer {
  submit(approved: ApprovedAction): Promise<SubmissionReceipt>;
}

// --- Results ---------------------------------------------------------------------------------

export interface RejectedResult {
  readonly status: "rejected";
  readonly decision: Denied;
  readonly simulation: Simulation | null;
}

export interface SubmittedResult {
  readonly status: "submitted";
  readonly approvalId: string;
  readonly receipt: SubmissionReceipt;
  readonly simulation: Simulation;
}

/** Approved, then the submission itself failed. Distinct from `rejected`: policy said yes. */
export interface FailedResult {
  readonly status: "failed";
  readonly approvalId: string;
  readonly error: string;
  readonly simulation: Simulation;
}

export type ExecutionResult = RejectedResult | SubmittedResult | FailedResult;

// --- The interface the agent gets --------------------------------------------------------------

/**
 * Everything an agent is allowed to know how to do.
 *
 * Note the asymmetry, which is the whole design: `PolicyDecision` appears in every *return* type
 * and in no *parameter* type. Decisions leave this interface; they never enter it. An agent can
 * discover that it is not allowed to do something, and it can give up its own authority. It has no
 * vocabulary for granting itself anything.
 */
export interface Executor {
  /**
   * What would policy say? Simulates and evaluates, submits nothing.
   *
   * A `preflight` that returns `allow` is *not* a reusable permit: the approval it carries is
   * consumed by nothing, expires, and its reservation is released. Ask again at execution time.
   */
  preflight(request: ActionRequest): Promise<PolicyDecision>;

  /** Run the whole pipeline. The only method that can move value, and only if policy agrees. */
  execute(request: ActionRequest): Promise<ExecutionResult>;

  /** Pull the kill switch. One-way from here: reinstatement is a human action elsewhere. */
  revoke(reason: string): Promise<RevocationReceipt>;

  status(): Promise<ExecutorStatus>;
}

// --- The composition -----------------------------------------------------------------------

/**
 * Wires a simulator, a policy authority, and a signer into an {@link Executor}.
 *
 * This class holds references to all three, which is exactly why *it* is not the agent. It is the
 * assembly point, constructed once at startup by the host process; the agent receives it typed as
 * `Executor` and therefore sees only the request-side verbs. In a real deployment the policy
 * authority and signer are remote, so this object holds two network clients and no authority of its
 * own — it cannot approve, because approving is not something it knows how to do.
 */
export class PolicyBoundExecutor implements Executor {
  readonly #simulator: Simulator;
  readonly #policy: PolicyAuthority;
  readonly #signer: Signer;
  readonly #now: () => number;

  constructor(parts: {
    simulator: Simulator;
    policy: PolicyAuthority;
    signer: Signer;
    now?: () => number;
  }) {
    this.#simulator = parts.simulator;
    this.#policy = parts.policy;
    this.#signer = parts.signer;
    this.#now = parts.now ?? Date.now;
  }

  async preflight(request: ActionRequest): Promise<PolicyDecision> {
    const simulation = await this.#simulate(request);
    const decision = await this.#policy.evaluate(request, simulation);
    if (decision.outcome === "allow") {
      // A preflight must not quietly consume budget: release what evaluate() reserved.
      await this.#policy.settle(decision.approval, "failed");
    }
    return decision;
  }

  async execute(request: ActionRequest): Promise<ExecutionResult> {
    const simulation = await this.#simulate(request);
    const decision = await this.#policy.evaluate(request, simulation);

    if (decision.outcome === "deny") {
      return { status: "rejected", decision, simulation };
    }

    // The approval goes straight from the authority to the signer. It is never returned to the
    // caller of execute(), never logged in full, and never round-tripped — an approval that leaves
    // this method is one someone could try to replay.
    try {
      const receipt = await this.#signer.submit(decision.approval);
      await this.#policy.settle(decision.approval, "committed");
      return {
        status: "submitted",
        approvalId: decision.approval.approvalId,
        receipt,
        simulation,
      };
    } catch (error) {
      await this.#policy.settle(decision.approval, "failed");
      return {
        status: "failed",
        approvalId: decision.approval.approvalId,
        error: error instanceof Error ? error.message : String(error),
        simulation,
      };
    }
  }

  revoke(reason: string): Promise<RevocationReceipt> {
    return this.#policy.revoke(reason);
  }

  status(): Promise<ExecutorStatus> {
    return this.#policy.status();
  }

  /** A simulator that throws produces a failed simulation, which policy then denies on. */
  async #simulate(request: ActionRequest): Promise<Simulation> {
    try {
      return await this.#simulator.simulate(request);
    } catch (error) {
      return {
        requestId: request.id,
        ok: false,
        failure: error instanceof Error ? error.message : String(error),
        deltas: [],
        simulatedAt: this.#now(),
        source: "simulator-threw",
      };
    }
  }
}
