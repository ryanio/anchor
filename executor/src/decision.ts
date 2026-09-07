/**
 * Policy decisions, and the one thing in this workspace that carries authority.
 *
 * ## The property this file exists to enforce
 *
 * **The thing that requests cannot be the thing that decides.** (AGENTS.md invariant 1.)
 *
 * That is easy to say and easy to lose to a refactor, so it is encoded three ways here, each of
 * which independently blocks the mistake:
 *
 * 1. **Decisions flow outward only.** No function anywhere in this workspace *accepts* a
 *    {@link PolicyDecision} or an {@link ApprovedAction} from the agent's side of the boundary and
 *    acts on it. `Executor` (executor.ts) returns decisions and never takes one as a parameter, so
 *    "here is my own approval, please submit it" is not a sentence the API can express. The only
 *    consumer of an `ApprovedAction` is `Signer.submit`, and the only producer is a
 *    `PolicyAuthority`. Requesters hold the first half of that pipe; they never hold the second.
 *
 * 2. **The approval type is unforgeable at compile time.** {@link ApprovedAction} carries a
 *    property keyed by `POLICY_WITNESS`, a `unique symbol` that is declared here and deliberately
 *    *not exported*. A `unique symbol` is nominally typed — no other symbol, however constructed,
 *    is assignable to it — and a key that cannot be named cannot appear in an object literal. So
 *    `const fake: ApprovedAction = { request, ... }` does not typecheck in this module or any
 *    other, and no amount of spreading a real approval's own enumerable properties reproduces it.
 *
 * 3. **The approval object is unforgeable at run time.** TypeScript is defeatable with a cast, so
 *    the compile-time brand is backed by identity: {@link mintApproval} is the only function that
 *    adds an object to the module-private `MINTED` WeakSet, and {@link isMintedApproval} is the
 *    only way to pass `Signer.submit`'s entry check. `{} as ApprovedAction` typechecks under
 *    `as unknown as` and is still rejected at the signer. Note that `POLICY_WITNESS` has no runtime
 *    representation at all — the property exists only in the type — so there is nothing on the
 *    object to copy, and an approval that is cloned or serialised (structuredClone, JSON, an IPC
 *    hop) loses its identity and is refused. Authority does not survive being written down.
 *
 * What none of this defends against is a caller who imports the concrete `PolicyEngine` and
 * evaluates against a policy it wrote itself. That is not a type problem — it is why the
 * enforcement backend runs *outside the agent's process*, in an enclave or on chain
 * (docs/autonomy.md). The types make the in-process seam impossible to cross by accident; process
 * and key custody make it impossible to cross on purpose.
 */
import type { ActionRequest, Money, Simulation } from "./types.ts";

// --- The witness -----------------------------------------------------------------------------

/**
 * The unforgeable brand on an approval.
 *
 * `declare const` means this has no runtime value — it is a type-level key only, and never appears
 * on a real object. Not exported, on purpose: an unexported `unique symbol` cannot be named as a
 * computed key by any other module, which is precisely what makes {@link ApprovedAction}
 * unconstructable from outside.
 */
declare const POLICY_WITNESS: unique symbol;

/** Objects this module has minted. Identity-based, so nothing copied or cloned is in it. */
const MINTED = new WeakSet<object>();

// --- Denials ---------------------------------------------------------------------------------

/**
 * Why a request was refused. A closed union, not free text, because these are counted: a cluster of
 * rejections is an incident signal, and you cannot alert on a string that varies by phrasing
 * (docs/autonomy.md, "velocity and cooldown").
 */
export type DenyReason =
  /** Authority is revoked. The kill switch has been pulled. */
  | "revoked"
  /** `setApprovalForAll` — or anything else that is never delegable. */
  | "human-only-action"
  /** The action kind is not on this policy's action allowlist. */
  | "action-not-allowed"
  /** The contract is not on the contract allowlist. */
  | "contract-not-allowlisted"
  /** A transfer destination is not a pre-registered withdrawal address. */
  | "destination-not-allowlisted"
  /** Over the per-transaction cap. */
  | "per-transaction-cap"
  /** Over the rolling 24-hour cap. */
  | "rolling-24h-cap"
  /** Over the rolling 7-day cap. */
  | "rolling-7d-cap"
  /** The request is denominated in units this policy cannot evaluate. */
  | "denomination-mismatch"
  /** The simulation failed, or was not produced at all. */
  | "simulation-failed"
  /** The simulation's effects contradict what the request claimed. */
  | "simulation-mismatch"
  /** This request id has already been decided. Replay is not a second execution. */
  | "duplicate-request"
  /** Proceeds below the floor this policy will accept an offer at. */
  | "below-minimum-proceeds"
  /** The request is malformed in a way that makes it un-evaluable. */
  | "malformed-request";

export interface Denied {
  readonly outcome: "deny";
  readonly reason: DenyReason;
  /** Human-readable detail for the log and the notification. Never machine-parsed. */
  readonly detail: string;
  readonly requestId: string;
  readonly decidedAt: number;
  readonly policyVersion: string;
}

// --- Approvals -------------------------------------------------------------------------------

/**
 * A signed-off intent: the *only* object a {@link import("./executor.ts").Signer} will act on.
 *
 * Cannot be constructed outside this module — see the file header. Carries the simulation it was
 * judged against and a hard `ceiling`, so a signer can re-check the payload it is handed rather
 * than trusting that the request it also received is the one that was approved.
 */
export interface ApprovedAction {
  readonly [POLICY_WITNESS]: true;
  readonly approvalId: string;
  readonly request: ActionRequest;
  readonly simulation: Simulation;
  /** Upper bound on value that may leave the account. A signer must refuse to exceed it. */
  readonly ceiling: Money;
  /** Unix ms after which this approval is void. Approvals are short-lived by design. */
  readonly expiresAt: number;
  readonly decidedAt: number;
  readonly policyVersion: string;
}

export interface Allowed {
  readonly outcome: "allow";
  readonly approval: ApprovedAction;
  readonly requestId: string;
  readonly decidedAt: number;
  readonly policyVersion: string;
}

export type PolicyDecision = Allowed | Denied;

// --- Minting and checking --------------------------------------------------------------------

/** Everything an approval needs, minus the witness the caller cannot supply. */
export type ApprovalFields = Omit<ApprovedAction, typeof POLICY_WITNESS>;

/**
 * The single mint site for authority in this workspace.
 *
 * Exported so a policy backend in another module (PolicyEngine here, a Privy or Safe adapter later)
 * can produce approvals — the *backend* is pluggable, the mint is not. Anything that calls this is
 * by definition a policy authority and belongs outside the agent's trust boundary; anything that
 * merely wants to make a request has no reason to import it.
 *
 * The cast below is the one place a witness is asserted, and it is why the WeakSet exists: the
 * compile-time brand alone would be defeatable by any other cast, so the object's *identity* is
 * what `Signer.submit` actually checks.
 */
export function mintApproval(fields: ApprovalFields): ApprovedAction {
  const approval = { ...fields } as ApprovedAction;
  MINTED.add(approval);
  return approval;
}

/**
 * Runtime authenticity check. `true` only for an object this module minted, by identity.
 *
 * False for a cast, a literal, a clone, a `structuredClone`, or anything that made a trip through
 * JSON — which is the intended behaviour, not a limitation. If an approval needs to cross a process
 * boundary, the receiving side must re-evaluate policy, not re-hydrate an approval.
 */
export function isMintedApproval(candidate: unknown): candidate is ApprovedAction {
  return typeof candidate === "object" && candidate !== null && MINTED.has(candidate);
}

/** An approval is usable only if it was minted here and has not expired. */
export function isUsableApproval(candidate: unknown, now: number): candidate is ApprovedAction {
  return isMintedApproval(candidate) && candidate.expiresAt > now;
}

// --- Constructors for the deny path ------------------------------------------------------------

export function deny(
  reason: DenyReason,
  detail: string,
  context: { requestId: string; decidedAt: number; policyVersion: string },
): Denied {
  return {
    outcome: "deny",
    reason,
    detail,
    requestId: context.requestId,
    decidedAt: context.decidedAt,
    policyVersion: context.policyVersion,
  };
}

export function allow(approval: ApprovedAction): Allowed {
  return {
    outcome: "allow",
    approval,
    requestId: approval.request.id,
    decidedAt: approval.decidedAt,
    policyVersion: approval.policyVersion,
  };
}
