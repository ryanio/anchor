/**
 * The vocabulary of policy-bound execution: what an agent may ask for, and what a simulation of
 * that request looks like before anyone signs anything.
 *
 * Nothing in this file decides anything. It is deliberately inert — a request is a *statement of
 * intent*, and constructing one confers no authority whatsoever. See `decision.ts` for the half of
 * the model that carries authority, and note that no type here can be turned into one there.
 */

// --- Addresses -------------------------------------------------------------------------------

declare const ADDRESS_BRAND: unique symbol;

/**
 * A checked, lowercased EVM address.
 *
 * Branded so a collection slug, an ENS name, or a user-supplied string cannot drift into a field
 * that an allowlist is compared against. Every `Address` in the system has been through
 * {@link address}, so allowlist comparison is a plain string equality on normalised values rather
 * than a per-call-site guess about casing.
 */
export type Address = string & { readonly [ADDRESS_BRAND]: true };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Parse and normalise an address. Throws on anything that is not one — never coerces. */
export function address(raw: string): Address {
  const parsed = tryAddress(raw);
  if (parsed === null) throw new TypeError(`not an EVM address: ${JSON.stringify(raw)}`);
  return parsed;
}

/** Non-throwing {@link address}, for parsing untrusted input where a `null` is the right answer. */
export function tryAddress(raw: string): Address | null {
  if (!ADDRESS_RE.test(raw)) return null;
  return raw.toLowerCase() as Address;
}

/** Case-insensitive membership, for allowlists that may have been typed by a human. */
export function allowlistHas(allowlist: readonly Address[], candidate: Address): boolean {
  return allowlist.some((entry) => entry === candidate);
}

// --- Money -----------------------------------------------------------------------------------

/**
 * An exact amount, in the smallest indivisible unit of its denomination (wei for ETH, cents for
 * USD, 1e-6 for USDC).
 *
 * `bigint`, never `number`: a spend cap compared with floating point is a spend cap with a rounding
 * bug, and rounding bugs in this file are indistinguishable from a policy hole.
 */
export interface Money {
  readonly amount: bigint;
  /** Free-form denomination tag, e.g. `"USD"`, `"ETH"`. Compared by exact string equality. */
  readonly denomination: string;
}

export function money(amount: bigint, denomination: string): Money {
  if (amount < 0n) throw new RangeError("Money.amount must not be negative");
  return { amount, denomination };
}

export const ZERO = (denomination: string): Money => money(0n, denomination);

/**
 * Add two amounts, refusing to mix denominations.
 *
 * There is no implicit conversion anywhere in this workspace. A policy denominated in USD cannot
 * evaluate a request denominated in ETH, and the honest answer is to *deny* rather than to invent
 * an exchange rate — a stale rate is a spend cap that silently changes size.
 */
export function addMoney(a: Money, b: Money): Money {
  if (a.denomination !== b.denomination) {
    throw new TypeError(`cannot add ${a.denomination} to ${b.denomination}`);
  }
  return { amount: a.amount + b.amount, denomination: a.denomination };
}

export function formatMoney(m: Money): string {
  return `${m.amount} ${m.denomination}`;
}

// --- Actions ---------------------------------------------------------------------------------

/**
 * Every action the executor can be *asked* about.
 *
 * `set-approval-for-all` is in this union on purpose. It would be tempting to leave it out so it is
 * unrepresentable, but an agent that cannot name the action it wants will encode it as something
 * else — a "transfer", an opaque call — and the denial becomes an accident of parsing rather than a
 * rule. Modelling it makes the refusal total, exhaustive over the union, and directly testable.
 */
export type ActionKind = "buy" | "accept-offer" | "cancel-own-listing" | "transfer" | "set-approval-for-all";

/**
 * The actions that may *ever* be delegated to an agent.
 *
 * `set-approval-for-all` is excluded at the type level, which means a policy's action allowlist
 * cannot be configured to contain it — not by a typo, not by a future edit, not by a well-meaning
 * refactor. Token approvals are a human-only action class (docs/security.md); this is that rule
 * expressed as a type rather than as a comment.
 */
export type DelegableActionKind = Exclude<ActionKind, "set-approval-for-all">;

/** Fields every request carries, whatever it is asking for. */
export interface RequestEnvelope {
  /** Caller-generated unique id. Replaying one is a denial, not a second execution. */
  readonly id: string;
  /** Unix milliseconds when the agent formed the intent. */
  readonly requestedAt: number;
  readonly chain: string;
  /** The agent-operated account this would act from. Never a key — an identifier. */
  readonly account: Address;
  /**
   * Free text from the agent explaining itself.
   *
   * Policy never reads this field. It exists for the audit log and the human notification, and it
   * is the most likely place for prompt-injected marketplace content to arrive, so no policy
   * predicate is allowed to depend on it. Untrusted content must not be able to widen a limit.
   */
  readonly rationale?: string;
}

/** Buy a specific listed token. `maxPrice` is the ceiling the signer must not exceed. */
export interface BuyRequest extends RequestEnvelope {
  readonly kind: "buy";
  readonly contract: Address;
  readonly tokenId: string;
  readonly maxPrice: Money;
  readonly marketplace: Address;
}

/** Accept a standing offer on a token the account owns. Value flows in, the token flows out. */
export interface AcceptOfferRequest extends RequestEnvelope {
  readonly kind: "accept-offer";
  readonly contract: Address;
  readonly tokenId: string;
  readonly offerId: string;
  readonly minProceeds: Money;
  readonly marketplace: Address;
}

/** Cancel a listing this account created. No value moves; still logged and still policy-gated. */
export interface CancelOwnListingRequest extends RequestEnvelope {
  readonly kind: "cancel-own-listing";
  readonly contract: Address;
  readonly tokenId: string;
  readonly listingId: string;
  readonly marketplace: Address;
}

/** Move an asset out of the account. `to` must be on the withdrawal allowlist. */
export interface TransferRequest extends RequestEnvelope {
  readonly kind: "transfer";
  readonly contract: Address;
  readonly tokenId: string;
  readonly to: Address;
  /** What the outgoing asset is worth, for cap accounting. Value leaving is value spent. */
  readonly valuation: Money;
}

/**
 * Grant or revoke blanket operator rights over a collection.
 *
 * Representable, never allowable. Present so that {@link ActionKind} is honest about what an
 * on-chain account can do and so the refusal has somewhere to land.
 */
export interface SetApprovalForAllRequest extends RequestEnvelope {
  readonly kind: "set-approval-for-all";
  readonly contract: Address;
  readonly operator: Address;
  readonly approved: boolean;
}

export type ActionRequest =
  | BuyRequest
  | AcceptOfferRequest
  | CancelOwnListingRequest
  | TransferRequest
  | SetApprovalForAllRequest;

/** The contract a request touches. Every action names exactly one, for allowlist purposes. */
export function subjectContract(request: ActionRequest): Address {
  return request.contract;
}

// --- Simulation ------------------------------------------------------------------------------

/** One expected asset movement, from the point of view of the agent's account. */
export interface AssetDelta {
  /** `"out"` leaves the account, `"in"` arrives. */
  readonly direction: "out" | "in";
  readonly value: Money;
  /** Who is on the other side. For an `out` delta this is the destination that matters. */
  readonly counterparty: Address;
  /** `"native"`, `"erc20"`, `"erc721"`, … — descriptive, for the audit log. */
  readonly assetType: string;
}

/**
 * The computed effect of a request, produced by something that actually understands the calldata.
 *
 * Policy refuses to decide without one: "never sign a payload whose effects haven't been computed"
 * (docs/autonomy.md). A simulation that disagrees with the request is a denial, not a negotiation —
 * the request is the agent's claim, the simulation is the evidence, and policy trusts the evidence.
 */
export interface Simulation {
  readonly requestId: string;
  readonly ok: boolean;
  /** Why the simulation failed, when `ok` is false. */
  readonly failure?: string;
  readonly deltas: readonly AssetDelta[];
  readonly simulatedAt: number;
  /** Which simulator produced this, verbatim, for the log. */
  readonly source: string;
}

/** Total value leaving the account in a given denomination. Unlike denominations are not summed. */
export function outgoingValue(simulation: Simulation, denomination: string): Money {
  let total = 0n;
  for (const delta of simulation.deltas) {
    if (delta.direction !== "out") continue;
    if (delta.value.denomination !== denomination) continue;
    total += delta.value.amount;
  }
  return { amount: total, denomination };
}

/** Denominations present among outgoing deltas — used to catch a unit the policy cannot judge. */
export function outgoingDenominations(simulation: Simulation): Set<string> {
  const seen = new Set<string>();
  for (const delta of simulation.deltas) {
    if (delta.direction === "out") seen.add(delta.value.denomination);
  }
  return seen;
}

/** Every distinct destination an outgoing delta lands at. */
export function outgoingDestinations(simulation: Simulation): Address[] {
  const seen = new Set<Address>();
  for (const delta of simulation.deltas) {
    if (delta.direction === "out") seen.add(delta.counterparty);
  }
  return [...seen];
}

/** Total value arriving, in a given denomination. */
export function incomingValue(simulation: Simulation, denomination: string): Money {
  let total = 0n;
  for (const delta of simulation.deltas) {
    if (delta.direction !== "in") continue;
    if (delta.value.denomination !== denomination) continue;
    total += delta.value.amount;
  }
  return { amount: total, denomination };
}
