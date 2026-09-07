/**
 * The vocabulary of policy-bound execution: what an agent may ask for, and what a simulation of
 * that request looks like before anyone signs anything.
 *
 * Nothing in this file decides anything. It is deliberately inert — a request is a *statement of
 * intent*, and constructing one confers no authority whatsoever. See `decision.ts` for the half of
 * the model that carries authority, and note that no type here can be turned into one there.
 */

// --- Chains and addresses ----------------------------------------------------------------------

/**
 * Address architecture. The question "is this a valid address" has no chain-free answer, and
 * neither does "is this address on my allowlist".
 *
 * Mirrors `ChainArch` in `service/src/chains.ts` deliberately rather than importing it: the
 * executor has zero runtime dependencies (AGENTS.md) and the service's copy reaches
 * `@opensea/api-types` for its chain union. The *rule* is shared; the code is not, and this comment
 * is the acknowledgement that it is a restatement rather than an accident.
 */
export type ChainArch = "evm" | "svm";

/**
 * Chains whose addresses are not EVM-shaped. Everything else on OpenSea's list is EVM.
 *
 * Deliberately a list of the exceptions rather than a copy of all 29 slugs — a copy would rot, and
 * the executor cannot derive the list from the SDK without taking a dependency. The failure mode is
 * bounded: an unknown chain is assumed EVM, and a non-EVM address on it then fails to parse as one,
 * so the mistake surfaces as a refusal rather than as a silently accepted address. The one case
 * that would slip through is a future non-EVM chain that also uses 20-byte hex addresses. Nothing
 * like that exists on OpenSea's list today; if one appears, it belongs here.
 */
const NON_EVM_CHAINS: ReadonlyMap<string, ChainArch> = new Map([["solana", "svm"]]);

/** Chain slugs are lowercase ASCII identifiers — `ethereum`, `base`, `bera_chain`, `solana`. */
const CHAIN_SLUG_RE = /^[a-z0-9_]{1,32}$/;

/**
 * Normalise a chain slug, or throw.
 *
 * Lowercased on purpose, and unlike an address that is safe: a slug is an identifier, not a key.
 * `"Solana"` and `"solana"` naming different allowlist entries would be a confusion bug of exactly
 * the kind this module exists to prevent.
 */
export function chainSlug(raw: string): string {
  const slug = raw.toLowerCase();
  if (!CHAIN_SLUG_RE.test(slug)) throw new TypeError(`not a chain slug: ${JSON.stringify(raw)}`);
  return slug;
}

export function chainArch(chain: string): ChainArch {
  return NON_EVM_CHAINS.get(chainSlug(chain)) ?? "evm";
}

declare const ADDRESS_BRAND: unique symbol;

/**
 * A checked, lowercased EVM address: `0x` followed by 40 hex characters.
 *
 * Lowercasing is safe here and only here. EVM hex is case-insensitive — EIP-55 casing is a
 * checksum, not an identity — so normalising makes allowlist comparison a plain string equality
 * rather than a per-call-site guess. See {@link SolanaAddress} for why the same move is a
 * correctness bug on the other side.
 */
export type EvmAddress = string & { readonly [ADDRESS_BRAND]: "evm" };

/**
 * A checked Solana address: base58 decoding to exactly 32 bytes, never `0x`-prefixed.
 *
 * **Never normalised.** Base58 is case-sensitive: `A` and `a` are different digits and decode to
 * different keys, so lowercasing a Solana address does not produce another spelling of the same
 * account — it produces a different account, or nothing at all. The parser therefore preserves the
 * string verbatim, and every comparison downstream is exact.
 *
 * Length alone is not a check: base58 is not fixed-width, so a 32-byte key is 32–44 characters and
 * a 44-character string can decode to 33 bytes. The parser decodes.
 */
export type SolanaAddress = string & { readonly [ADDRESS_BRAND]: "svm" };

/**
 * Any address this workspace understands.
 *
 * A union of two *nominally distinct* branded types, not a widened string: `EvmAddress` is not
 * assignable to `SolanaAddress` or the reverse, so a function with genuinely EVM-only work to do —
 * ABI encoding, say — says so in its signature and the compiler enforces it.
 */
export type Address = EvmAddress | SolanaAddress;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode base58 to bytes, or `null` when the string is not base58 at all.
 *
 * The same twenty lines as `service/src/chains.ts`, restated rather than imported because the
 * executor takes no dependency on the service and neither workspace may depend on the other. Said
 * out loud because a silent copy is how two validators drift into disagreeing about what an address
 * is, and that disagreement is one an attacker gets to choose between.
 */
function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

/** The 32 raw bytes behind a Solana address, for byte-wise comparison against a program id. */
export function solanaAddressBytes(value: SolanaAddress): Uint8Array {
  const bytes = decodeBase58(value);
  if (bytes === null || bytes.length !== 32) throw new TypeError("not a Solana address");
  return bytes;
}

/** Encode 32 bytes as a Solana address. The inverse of {@link solanaAddressBytes}. */
export function encodeSolanaAddress(bytes: Uint8Array): SolanaAddress {
  if (bytes.length !== 32) throw new TypeError(`a Solana address is 32 bytes, got ${bytes.length}`);
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leading = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += "1";
  }
  const body = digits
    .reverse()
    .map((digit) => BASE58_ALPHABET[digit] ?? "")
    .join("");
  return (leading + body) as SolanaAddress;
}

/** Non-throwing EVM parse. Lowercases, because EIP-55 casing is a checksum and not an identity. */
export function tryEvmAddress(raw: string): EvmAddress | null {
  if (!EVM_ADDRESS_RE.test(raw)) return null;
  return raw.toLowerCase() as EvmAddress;
}

/** Non-throwing Solana parse. Preserves case, because base58 case is part of the value. */
export function trySolanaAddress(raw: string): SolanaAddress | null {
  if (decodeBase58(raw)?.length !== 32) return null;
  return raw as SolanaAddress;
}

export function evmAddress(raw: string): EvmAddress {
  const parsed = tryEvmAddress(raw);
  if (parsed === null) throw new TypeError(`not an EVM address: ${JSON.stringify(raw)}`);
  return parsed;
}

export function solanaAddress(raw: string): SolanaAddress {
  const parsed = trySolanaAddress(raw);
  if (parsed === null) throw new TypeError(`not a Solana address: ${JSON.stringify(raw)}`);
  return parsed;
}

/**
 * Parse an address of either architecture, deciding which from the string itself.
 *
 * The two spaces are disjoint, and not by luck: base58's alphabet omits `0`, so a `0x`-prefixed
 * string is never valid base58, and a 40-character base58 string decodes to about 29 bytes rather
 * than 32. No string parses as both, so there is no ambiguity to resolve with a guess. Anything
 * that is neither is a throw, never a coercion.
 */
export function address(raw: string): Address {
  const parsed = tryAddress(raw);
  if (parsed === null) throw new TypeError(`not an address on any supported chain: ${JSON.stringify(raw)}`);
  return parsed;
}

/** Non-throwing {@link address}, for parsing untrusted input where `null` is the right answer. */
export function tryAddress(raw: string): Address | null {
  return tryEvmAddress(raw) ?? trySolanaAddress(raw);
}

/** Which architecture an already-parsed address belongs to. Exact, the spaces being disjoint. */
export function archOf(value: Address): ChainArch {
  return value.startsWith("0x") ? "evm" : "svm";
}

/** Narrowing predicates, so an EVM-only code path can prove it is on one. */
export function isEvmAddress(value: Address): value is EvmAddress {
  return archOf(value) === "evm";
}

export function isSolanaAddress(value: Address): value is SolanaAddress {
  return archOf(value) === "svm";
}

/**
 * An address *and the chain it lives on*. The unit an allowlist is written in.
 *
 * A bare address is not something an allowlist can safely hold. The same 20 hex bytes name a
 * different contract on every EVM chain, and a `CREATE2` deployment puts an attacker's code at a
 * chosen address on a chain the user never configured — so an allowlist compared on the address
 * alone allows a contract nobody approved. Comparison here is on the pair, and there is no accessor
 * that compares one half of it.
 *
 * Constructing one checks that the address could belong to that chain, so a mismatched pair does
 * not exist to be compared in the first place.
 */
export interface ChainAddress {
  readonly chain: string;
  readonly address: Address;
}

export function chainAddress(chain: string, raw: string | Address): ChainAddress {
  const slug = chainSlug(chain);
  const parsed = address(raw);
  const expected = chainArch(slug);
  if (archOf(parsed) !== expected) {
    throw new TypeError(
      `${JSON.stringify(raw)} is not an address on ${slug}: that chain is ${expected}, ` +
        `and this address is ${archOf(parsed)}`,
    );
  }
  return { chain: slug, address: parsed };
}

/** Non-throwing {@link chainAddress}. */
export function tryChainAddress(chain: string, raw: string): ChainAddress | null {
  try {
    return chainAddress(chain, raw);
  } catch {
    return null;
  }
}

/**
 * Exact equality on the pair. Both halves, always.
 *
 * This is the comparison every allowlist in the workspace runs, which is why it is one function
 * rather than an inline `===` at each site. An EVM entry and a Solana entry can never be equal
 * because their address spaces are disjoint; two EVM entries for the same address on *different
 * chains* are likewise never equal, and that is the case a bare-string allowlist got wrong.
 */
export function sameChainAddress(a: ChainAddress, b: ChainAddress): boolean {
  return a.chain === b.chain && a.address === b.address;
}

export function allowlistHas(allowlist: readonly ChainAddress[], candidate: ChainAddress): boolean {
  return allowlist.some((entry) => sameChainAddress(entry, candidate));
}

/** Render a pair for a log line or a denial. Never bare, so a log is unambiguous about the chain. */
export function formatChainAddress(value: ChainAddress): string {
  return `${value.chain}:${value.address}`;
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
 * The actions that confer *standing authority over assets* rather than moving a bounded amount.
 *
 * This is the test that decides membership, and it is worth stating precisely because the list is
 * no longer one item. An action belongs here when all three hold:
 *
 * 1. **It moves no value**, so every spend cap in docs/autonomy.md is blind to it.
 * 2. **It grants an authority that outlives the transaction**, so the blast radius is not the value
 *    of this action but the value of everything the authority reaches, now and later.
 * 3. **Revoking it is a separate action nobody can guarantee happens.**
 *
 * `setApprovalForAll` is the EVM member and the reason the class exists (docs/security.md). Solana
 * has no such call, which is emphatically not the same as being safe — it has two of its own, and
 * the second is worse than the EVM one:
 *
 * - **`approve-delegate`** — the SPL Token `Approve` / `ApproveChecked` instruction names a
 *   *delegate* on a token account with an approved amount. It is the closest analogue of an ERC-20
 *   allowance, it persists until revoked, and a delegate approved for `u64::MAX` is unlimited
 *   authority over that account's balance. A bounded amount is still in this class: the bound is
 *   enforced by the token program against a delegate Anchor does not control, and "small allowance
 *   now, top it up later" is a delegation, not a spend.
 * - **`set-authority`** — the SPL Token `SetAuthority` instruction reassigns a token account's
 *   owner or close authority, or a mint's mint and freeze authority. This is strictly worse than an
 *   allowance: it is not a limit on spending the account, it *is* the account. The same reasoning
 *   covers a program's upgrade authority, where handing it over means the program that was audited
 *   is no longer the program that runs.
 *
 * `Revoke` and "approve zero" are in the class too, for the same reason `setApprovalForAll(false)`
 * is: an interface that can express *toggling* a delegation can express turning it on, and the
 * refusal has to be about the verb rather than about the argument.
 *
 * **Closing an account is deliberately *not* here**, though it moves value and does not look like a
 * transfer — closing a wrapped-SOL account sends the whole lamport balance to a destination the
 * instruction names. It fails test 1: it is a transfer wearing a different hat, so it belongs under
 * the withdrawal-destination allowlist rather than under a blanket refusal, and `solana.ts` guards
 * it there. Neither is *arbitrary program invocation* here, because it is not an action kind at
 * all: it is the absence of one, and the type-level answer to it is that {@link ActionRequest} has
 * no member carrying instructions or bytes. See `solana.ts`.
 */
export const HUMAN_ONLY_ACTION_KINDS = ["set-approval-for-all", "approve-delegate", "set-authority"] as const;

export type HumanOnlyActionKind = (typeof HUMAN_ONLY_ACTION_KINDS)[number];

/**
 * Every action the executor can be *asked* about.
 *
 * The human-only kinds are in this union on purpose. It would be tempting to leave them out so they
 * are unrepresentable, but an agent that cannot name the action it wants will encode it as
 * something else — a "transfer", an opaque call — and the denial becomes an accident of parsing
 * rather than a rule. Modelling them makes the refusal total, exhaustive over the union, and
 * directly testable.
 */
export type ActionKind = "buy" | "accept-offer" | "cancel-own-listing" | "transfer" | HumanOnlyActionKind;

/**
 * The actions that may *ever* be delegated to an agent.
 *
 * Every {@link HumanOnlyActionKind} is excluded at the type level, which means a policy's action
 * allowlist cannot be configured to contain one — not by a typo, not by a future edit, not by a
 * well-meaning refactor. The exclusion is derived from {@link HUMAN_ONLY_ACTION_KINDS} rather than
 * spelled out again, so the list has exactly one definition and the runtime check in `policy.ts`
 * reads from the same constant the type does. Adding a member is a one-line change that tightens
 * both at once; there is no way to tighten one and forget the other.
 */
export type DelegableActionKind = Exclude<ActionKind, HumanOnlyActionKind>;

/** Runtime counterpart of the type-level exclusion, for limits that arrived as JSON. */
export function isHumanOnlyActionKind(kind: string): kind is HumanOnlyActionKind {
  return (HUMAN_ONLY_ACTION_KINDS as readonly string[]).includes(kind);
}

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

/**
 * What a transfer is moving.
 *
 * A discriminated union rather than a `tokenId` with an optional `amount`, because they are not the
 * same product (docs/tokens.md): one non-fungible thing has an id and no quantity, and a fungible
 * balance has a quantity and no id. An SPL transfer expressed as `tokenId: "1"` is a lie that
 * typechecks, and a `quantity` field that is always `1` for NFTs is the same lie facing the other
 * way. `decimals` travels with the amount because a raw `u64` is meaningless without it, and a
 * caller that has to guess the scale is a caller that will guess wrong by three orders of magnitude.
 */
export type TransferSubject =
  | { readonly asset: "non-fungible"; readonly tokenId: string }
  | { readonly asset: "fungible"; readonly amount: bigint; readonly decimals: number };

export function tokenIdSubject(tokenId: string): TransferSubject {
  return { asset: "non-fungible", tokenId };
}

export function amountSubject(amount: bigint, decimals: number): TransferSubject {
  if (amount < 0n) throw new RangeError("a transfer amount must not be negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 32) {
    throw new RangeError(`not a token decimals value: ${decimals}`);
  }
  return { asset: "fungible", amount, decimals };
}

/** Move an asset out of the account. `to` must be on the withdrawal allowlist. */
export interface TransferRequest extends RequestEnvelope {
  readonly kind: "transfer";
  /** The collection (EVM) or the mint (Solana). */
  readonly contract: Address;
  readonly subject: TransferSubject;
  readonly to: Address;
  /** What the outgoing asset is worth, for cap accounting. Value leaving is value spent. */
  readonly valuation: Money;
}

/**
 * Grant or revoke blanket operator rights over a collection — EVM's `setApprovalForAll`.
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

/**
 * Name a delegate on a token account — Solana's SPL `Approve` / `ApproveChecked` / `Revoke`.
 *
 * Representable, never allowable, for the reasons in {@link HUMAN_ONLY_ACTION_KINDS}. `amount` is
 * modelled even though no policy will ever read it, because `u64::MAX` is the shape the attack
 * actually takes and a denial that can quote the number is a better alert than one that cannot.
 */
export interface ApproveDelegateRequest extends RequestEnvelope {
  readonly kind: "approve-delegate";
  /** The mint. Named `contract` so every request has exactly one allowlist subject. */
  readonly contract: Address;
  readonly tokenAccount: Address;
  /** `null` for a `Revoke`, which is refused just as firmly — see the class definition. */
  readonly delegate: Address | null;
  readonly amount: bigint;
}

/** Which authority {@link SetAuthorityRequest} would reassign. Closed, so a new one is a compile error. */
export type AuthorityType =
  /** The token account's owner. Whoever holds it owns the balance outright. */
  | "account-owner"
  /** May close the account and choose where its lamports go. */
  | "close-account"
  /** May mint new supply. */
  | "mint-tokens"
  /** May freeze any holder's account, including this one. */
  | "freeze-account"
  /** A program's upgrade authority: the power to replace the code at an unchanged address. */
  | "program-upgrade";

/**
 * Reassign an authority — Solana's SPL `SetAuthority`, and a program's upgrade authority.
 *
 * Representable, never allowable. Worse than an allowance rather than a variant of one: this does
 * not bound what a delegate may spend, it hands over the account.
 */
export interface SetAuthorityRequest extends RequestEnvelope {
  readonly kind: "set-authority";
  /** The mint, token account, or program whose authority would move. */
  readonly contract: Address;
  readonly authorityType: AuthorityType;
  /** `null` relinquishes the authority permanently, which is irreversible and still human-only. */
  readonly newAuthority: Address | null;
}

export type ActionRequest =
  | BuyRequest
  | AcceptOfferRequest
  | CancelOwnListingRequest
  | TransferRequest
  | SetApprovalForAllRequest
  | ApproveDelegateRequest
  | SetAuthorityRequest;

/**
 * The contract a request touches, scoped to its chain. Every action names exactly one.
 *
 * Returns a {@link ChainAddress} rather than a bare address so an allowlist comparison cannot be
 * written without the chain. Throws when the request's own chain and address disagree — which is
 * malformed input, not a policy question, and `policy.ts` turns it into a `"malformed-request"`
 * denial rather than letting it escape as an exception.
 */
export function subjectContract(request: ActionRequest): ChainAddress {
  return chainAddress(request.chain, request.contract);
}

/** Every address a request names, in field order. Used to check them all against its chain. */
function addressFields(request: ActionRequest): { field: string; value: Address | null }[] {
  const common = [
    { field: "account", value: request.account },
    { field: "contract", value: request.contract },
  ];
  switch (request.kind) {
    case "buy":
    case "accept-offer":
    case "cancel-own-listing":
      return [...common, { field: "marketplace", value: request.marketplace }];
    case "transfer":
      return [...common, { field: "to", value: request.to }];
    case "set-approval-for-all":
      return [...common, { field: "operator", value: request.operator }];
    case "approve-delegate":
      return [
        ...common,
        { field: "tokenAccount", value: request.tokenAccount },
        { field: "delegate", value: request.delegate },
      ];
    case "set-authority":
      return [...common, { field: "newAuthority", value: request.newAuthority }];
  }
}

/**
 * Why this request cannot be evaluated at all, or `null` when it is well formed.
 *
 * Checked before any policy rule, because an inconsistent request is not a policy question. The
 * substantive check is that **every address the request names belongs to the architecture of the
 * chain the request declares** — a Solana account paired with `chain: "ethereum"` is either a typo
 * or an attempt to have an EVM allowlist entry vouch for a Solana address, and neither should reach
 * a rule. It fails closed either way, since a mismatched pair matches no allowlist entry, but a
 * denial that names the field is worth more than a denial that says "not allowlisted".
 */
export function describeMalformation(request: ActionRequest): string | null {
  let arch: ChainArch;
  try {
    arch = chainArch(request.chain);
  } catch {
    return `chain ${JSON.stringify(request.chain)} is not a chain slug`;
  }
  for (const { field, value } of addressFields(request)) {
    if (value === null) continue;
    if (archOf(value) !== arch) {
      return `${field} is a ${archOf(value)} address but the request is on ${request.chain}, which is ${arch}`;
    }
  }
  return null;
}

// --- Simulation ------------------------------------------------------------------------------

/** One expected asset movement, from the point of view of the agent's account. */
export interface AssetDelta {
  /** `"out"` leaves the account, `"in"` arrives. */
  readonly direction: "out" | "in";
  readonly value: Money;
  /**
   * Who is on the other side, scoped to its chain. For an `out` delta this is the destination the
   * withdrawal allowlist is checked against, which is exactly why it is a {@link ChainAddress} and
   * not a bare one: a bridge or a swap can land value on a chain the request never named, and an
   * allowlist entry for `ethereum:0xvault` must not vouch for `base:0xvault`.
   */
  readonly counterparty: ChainAddress;
  /** `"native"`, `"erc20"`, `"erc721"`, `"spl"`, … — descriptive, for the audit log. */
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

/**
 * Every distinct destination an outgoing delta lands at, chain and all.
 *
 * Deduplicated on the *pair*: the same address on two chains is two destinations, and collapsing
 * them would let one allowlisted entry vouch for both.
 */
export function outgoingDestinations(simulation: Simulation): ChainAddress[] {
  const seen = new Map<string, ChainAddress>();
  for (const delta of simulation.deltas) {
    if (delta.direction === "out") seen.set(formatChainAddress(delta.counterparty), delta.counterparty);
  }
  return [...seen.values()];
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
