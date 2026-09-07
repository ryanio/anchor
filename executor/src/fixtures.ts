/**
 * Fixtures for this workspace's tests.
 *
 * Not exported from `index.ts` — nothing outside the test suite should import these. Every address
 * here is a deliberately unmistakable fake, and there is no `set-approval-for-all` fixture on
 * purpose: that request is built inline, once, in the test that proves it is refused (AGENTS.md
 * invariant 3 — never in a fixture that could be copy-pasted into production).
 */
import { address, money, type Address, type Money } from "./types.ts";
import type { PolicyLimits } from "./policy.ts";
import type {
  AcceptOfferRequest,
  BuyRequest,
  CancelOwnListingRequest,
  TransferRequest,
} from "./types.ts";

/** Obviously-fake, well-formed addresses. */
const fake = (label: string): Address => address(`0x${label.padEnd(40, "0")}`);

export const ACCOUNT = fake("acc0");
export const COLLECTION = fake("c011ec");
export const OTHER_COLLECTION = fake("badc011ec");
export const MARKETPLACE = fake("fee");
export const COLD_VAULT = fake("de5b");
export const ATTACKER = fake("bad");

export const DENOM = "USD-cents";
export const usd = (cents: bigint): Money => money(cents, DENOM);

/** A controllable clock, so rolling-window tests are deterministic rather than slow. */
export function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Tier-1-ish limits: $25 per transaction, $50 a day, $200 a week. */
export function limits(overrides: Partial<PolicyLimits> = {}): PolicyLimits {
  return {
    denomination: DENOM,
    perTransaction: 2_500n,
    rolling24h: 5_000n,
    rolling7d: 20_000n,
    allowedActions: ["buy", "accept-offer", "cancel-own-listing", "transfer"],
    contractAllowlist: [COLLECTION],
    withdrawalAllowlist: [COLD_VAULT],
    minAcceptOfferProceeds: 0n,
    approvalTtlMs: 60_000,
    ...overrides,
  };
}

const envelope = (id: string, at: number) => ({
  id,
  requestedAt: at,
  chain: "ethereum",
  account: ACCOUNT,
});

export function buy(id: string, cents: bigint, at = 0, over: Partial<BuyRequest> = {}): BuyRequest {
  return {
    ...envelope(id, at),
    kind: "buy",
    contract: COLLECTION,
    tokenId: "1",
    maxPrice: usd(cents),
    marketplace: MARKETPLACE,
    ...over,
  };
}

export function acceptOffer(
  id: string,
  cents: bigint,
  at = 0,
  over: Partial<AcceptOfferRequest> = {},
): AcceptOfferRequest {
  return {
    ...envelope(id, at),
    kind: "accept-offer",
    contract: COLLECTION,
    tokenId: "1",
    offerId: "offer-1",
    minProceeds: usd(cents),
    marketplace: MARKETPLACE,
    ...over,
  };
}

export function cancelOwnListing(
  id: string,
  at = 0,
  over: Partial<CancelOwnListingRequest> = {},
): CancelOwnListingRequest {
  return {
    ...envelope(id, at),
    kind: "cancel-own-listing",
    contract: COLLECTION,
    tokenId: "1",
    listingId: "listing-1",
    marketplace: MARKETPLACE,
    ...over,
  };
}

export function transfer(
  id: string,
  cents: bigint,
  to: Address = COLD_VAULT,
  at = 0,
  over: Partial<TransferRequest> = {},
): TransferRequest {
  return {
    ...envelope(id, at),
    kind: "transfer",
    contract: COLLECTION,
    tokenId: "1",
    to,
    valuation: usd(cents),
    ...over,
  };
}
