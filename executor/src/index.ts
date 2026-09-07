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
 */

export * from "./decision.ts";
export * from "./executor.ts";
export * from "./inert.ts";
export * from "./policy.ts";
export * from "./types.ts";
