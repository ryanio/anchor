/**
 * ## REFERENCE PARTS — THESE DO NOT TOUCH A NETWORK, A KEY, OR A CHAIN
 *
 * A simulator and a signer that exist so the pipeline in `executor.ts` can be exercised end to end
 * in tests and read as documentation. Neither is suitable for anything else, and both say so at
 * run time in the `source`/`signer` fields they stamp on their output.
 */
import { isUsableApproval, type ApprovedAction } from "./decision.ts";
import type { Signer, Simulator, SubmissionReceipt } from "./executor.ts";
import {
  money,
  type ActionRequest,
  type AssetDelta,
  type Simulation,
} from "./types.ts";

/**
 * A simulator that simply believes the request.
 *
 * **This is not a simulation.** A real one decodes calldata and computes the resulting state, which
 * is the entire point of the control — "never sign a payload whose effects haven't been computed"
 * (docs/autonomy.md). This one derives the deltas from the request's own claims, which means it can
 * never catch a request that lies. It exists so tests have a cooperative baseline to vary from; the
 * interesting tests hand the policy a simulation that *disagrees* with the request.
 */
export class DeclaredIntentSimulator implements Simulator {
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async simulate(request: ActionRequest): Promise<Simulation> {
    return {
      requestId: request.id,
      ok: true,
      deltas: declaredDeltas(request),
      simulatedAt: this.#now(),
      source: "declared-intent (NOT a real simulation)",
    };
  }
}

function declaredDeltas(request: ActionRequest): AssetDelta[] {
  switch (request.kind) {
    case "buy":
      return [
        {
          direction: "out",
          value: request.maxPrice,
          counterparty: request.marketplace,
          assetType: "erc20",
        },
        {
          direction: "in",
          value: money(0n, request.maxPrice.denomination),
          counterparty: request.marketplace,
          assetType: "erc721",
        },
      ];
    case "accept-offer":
      return [
        {
          direction: "in",
          value: request.minProceeds,
          counterparty: request.marketplace,
          assetType: "erc20",
        },
        {
          direction: "out",
          value: money(0n, request.minProceeds.denomination),
          counterparty: request.marketplace,
          assetType: "erc721",
        },
      ];
    case "cancel-own-listing":
      return [];
    case "transfer":
      return [
        {
          direction: "out",
          value: request.valuation,
          counterparty: request.to,
          assetType: "erc721",
        },
      ];
    case "set-approval-for-all":
      // Modelled as moving nothing, which is exactly why a spend cap cannot see it and why it is
      // refused as its own action class rather than judged on value.
      return [];
  }
}

/**
 * A signer that refuses to be a signer.
 *
 * It performs the authenticity check a real backend must perform — that the approval was minted by
 * a policy authority and has not expired — and then does nothing, returning a receipt with
 * `broadcast: false` and no transaction hash. Every approval it sees is recorded on
 * {@link InertSigner.submitted} so tests can assert on what *would* have been signed.
 *
 * A real signer replaces this and lives behind the enclave or the account. It must keep the
 * `isUsableApproval` check: that check is what makes a forged or replayed approval fail closed.
 */
export class InertSigner implements Signer {
  readonly submitted: ApprovedAction[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async submit(approved: ApprovedAction): Promise<SubmissionReceipt> {
    const now = this.#now();

    // Fail closed. `approved` is typed as an ApprovedAction, but a caller can always reach this
    // with a cast, and a real signer is reachable across a process boundary where types are only a
    // convention. Identity is the check that survives both.
    if (!isUsableApproval(approved, now)) {
      throw new Error(
        "refusing to sign: approval was not minted by a policy authority, or has expired",
      );
    }

    this.submitted.push(approved);
    return {
      approvalId: approved.approvalId,
      requestId: approved.request.id,
      transactionHash: null,
      submittedAt: now,
      signer: "inert (nothing was broadcast)",
      broadcast: false,
    };
  }
}

/** A signer that always throws, for exercising the `failed` branch of the pipeline. */
export class FailingSigner implements Signer {
  readonly #message: string;

  constructor(message = "submission failed") {
    this.#message = message;
  }

  async submit(_approved: ApprovedAction): Promise<SubmissionReceipt> {
    throw new Error(this.#message);
  }
}
