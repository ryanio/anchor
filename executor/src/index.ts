/**
 * `@anchor/executor` — the policy-bound execution seam (roadmap step 6).
 *
 * The agent imports {@link Executor} and the request types. Nothing it imports from here lets it
 * decide whether its own request is allowed; see `decision.ts` for how that is enforced by the
 * shape of the types rather than by convention.
 *
 * The reference `PolicyEngine`, `DeclaredIntentSimulator` and `InertSigner` are exported for tests
 * and for reading. They enforce nothing and sign nothing — real backends implement the same
 * interfaces from behind an enclave or an onchain account.
 *
 * `privy.ts` is the first such backend: a `PolicyAuthority` and `Signer` backed by Privy server
 * wallets, where the key lives in an enclave this machine cannot reach and the policy is enforced at
 * signing time. See `executor/README.md` for what a user must set up before it does anything.
 */

export * from "./credentials.ts";
export * from "./decision.ts";
export * from "./evm.ts";
export * from "./executor.ts";
export * from "./inert.ts";
export * from "./policy.ts";
export * from "./privy.ts";
export * from "./privy-api.ts";
export * from "./solana.ts";
export * from "./types.ts";
