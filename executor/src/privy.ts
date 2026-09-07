/**
 * The Privy backend: the first {@link PolicyAuthority} and {@link Signer} in this repository that
 * are backed by something the agent's process cannot reach.
 *
 * ## What is actually enforced, and where
 *
 * Privy holds the key. It is reconstituted only inside their enclave, it never exists on this
 * machine, and every signing request is checked against a **policy stored with Privy** before they
 * will sign. That check is the enforcement. Nothing in this file can widen it, and nothing in this
 * file can bypass it — a `POST` that Privy's policy engine refuses comes back as an error, not as a
 * transaction.
 *
 * That leaves this module three jobs, and it is worth being precise about which is which:
 *
 * 1. **Audit the remote policy at startup** ({@link auditRemotePolicy}). Anchor fetches the policy
 *    from Privy and refuses to start if it grants more than the local configuration claims — a
 *    blanket allow rule, a contract Anchor's allowlist does not contain, a rule that would permit
 *    `setApprovalForAll`. This is the check that makes the local mirror below trustworthy as a
 *    *description*: it can never describe more authority than Privy will actually grant.
 *
 * 2. **Pre-filter locally** ({@link PrivyPolicyAuthority}). A local {@link PolicyEngine} mirror
 *    evaluates first, so a request that is obviously out of bounds is denied with a machine-readable
 *    {@link import("./decision.ts").DenyReason} and never leaves the machine. **The mirror is not
 *    the enforcement.** It runs in the agent's process, so a compromised process can rewrite it; its
 *    value is that it produces reasons, counts rejections, and keeps the rolling-window accounting
 *    that Privy's rule language cannot express (see "What Privy cannot express" below). If the
 *    mirror is bypassed entirely, the worst outcome is a request Privy then refuses.
 *
 * 3. **Submit through Privy** ({@link PrivySigner}), where the real decision happens.
 *
 * ## The type-level guarantee is unchanged
 *
 * {@link import("./decision.ts").ApprovedAction} is still minted in exactly one place —
 * `mintApproval`, called by the policy authority. `PrivyPolicyAuthority` does not mint approvals
 * itself; it delegates to the mirror engine, which does. Nothing crosses a network boundary as an
 * approval: an approval's authority lives in a `WeakSet` and does not survive serialisation, which
 * is why the wire protocol here carries *transactions*, never approvals. A response from Privy
 * cannot become an `ApprovedAction`, because there is no code path from JSON to the mint.
 *
 * ## What Privy cannot express
 *
 * Privy's policy rules evaluate **one request at a time**: `field`/`operator`/`value` conditions
 * over the transaction and its decoded calldata. There is no cumulative-spend or rate-limit rule
 * type, so the rolling 24-hour and 7-day caps from docs/autonomy.md have no remote equivalent — and
 * those are the caps that matter most, because a hundred small transfers is the obvious way around a
 * per-transaction limit. The mirror keeps that ledger, and this file does not pretend otherwise:
 * against an attacker who has fully replaced the Anchor process, the rolling caps do not hold. The
 * per-transaction cap, the contract allowlist and the `setApprovalForAll` refusal do.
 */
import { type ApprovedAction, isUsableApproval, type PolicyDecision } from "./decision.ts";
import { caip2, containsSetApprovalForAll, encodeSafeTransferFrom, tokenIdToBigInt } from "./evm.ts";
import type {
  ExecutorStatus,
  PolicyAuthority,
  RevocationReceipt,
  Settlement,
  Signer,
  SubmissionReceipt,
} from "./executor.ts";
import { PolicyEngine, type PolicyLimits } from "./policy.ts";
import type { PrivyPolicyCondition, PrivyPolicyDocument, PrivyWalletApi } from "./privy-api.ts";
import { type ActionRequest, type Address, allowlistHas, type Simulation, tryAddress } from "./types.ts";

// --- Auditing the remote policy ----------------------------------------------------------------

/**
 * The RPC methods an Anchor-shaped policy is expected to permit.
 *
 * Anything else in an ALLOW rule is a finding, because the interesting attacks are all methods
 * rather than parameters. `exportPrivateKey` hands over the key. `personal_sign` and
 * `eth_signTypedData_v4` produce a signed Seaport order, which moves an asset without ever being a
 * transaction a `value` condition could bound — an approval-shaped hole with a different name.
 * `*` is all of the above. A user who genuinely needs one widens
 * {@link PrivyPolicyAuthorityOptions.additionalAllowedMethods} deliberately, in code, in a diff.
 */
const EXPECTED_METHODS: readonly string[] = ["eth_sendTransaction", "eth_signTransaction"];

/** Privy's function-name conditions name the function; this is the one that is never allowed. */
const SET_APPROVAL_FOR_ALL_FN = "setapprovalforall";

/**
 * What a read of the remote policy establishes, and what it could not establish.
 *
 * Separated from the throwing wrapper so the result is inspectable in a test and printable by an
 * operator: "here is what Privy will actually allow" is the single most useful thing to see before
 * pointing this at a funded wallet.
 */
export interface PolicyAudit {
  /** Contracts some ALLOW rule permits as a transaction destination. */
  readonly allowlistedContracts: readonly Address[];
  /**
   * Addresses some ALLOW rule permits as the `to` *parameter* of a decoded call — where an ERC-721
   * withdrawal's real destination lives, since the transaction's own `to` is the collection.
   */
  readonly allowlistedCalldataDestinations: readonly Address[];
  /**
   * The tightest native-value ceiling any ALLOW rule imposes, in wei, or `null` when no rule
   * constrains value at all. `null` is a finding, not a default.
   */
  readonly nativeValueCeilingWei: bigint | null;
  /** Reasons this policy is not safe to run against. Non-empty means refuse to start. */
  readonly findings: readonly string[];
  /** Facts the audit could not check, stated rather than quietly assumed. */
  readonly unverified: readonly string[];
}

function conditionValues(condition: PrivyPolicyCondition): string[] {
  const raw = condition.value;
  return (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
}

/**
 * Parse a Privy condition value as an integer.
 *
 * Privy's OpenAPI types condition values as strings, and numeric comparisons are conventionally
 * written as hex quantities (`"0x2386f26fc10000"`), so both forms have to be read. Anything else
 * returns `null`, which the caller turns into a finding rather than a default.
 */
function safeBigInt(raw: string): bigint | null {
  const text = raw.trim();
  try {
    if (/^0x[0-9a-fA-F]{1,64}$/.test(text)) return BigInt(text);
    if (/^[0-9]{1,80}$/.test(text)) return BigInt(text);
  } catch {
    return null;
  }
  return null;
}

/**
 * Read a remote Privy policy and report what it grants.
 *
 * Deliberately pessimistic about anything it does not understand. An unrecognised `field_source`, an
 * operator it cannot bound (`in_condition_set` resolves against a list this client never sees), or a
 * rule shape from a future policy version all produce a finding rather than being skipped — an audit
 * that ignores the parts it cannot read is an audit that passes everything.
 *
 * Note there is no `default_action` to check. Privy's engine defaults to DENY when no rule resolves,
 * and a method with no rule at all is denied, so the audit's job is entirely about what the ALLOW
 * rules *widen*. DENY rules are ignored on purpose: they only ever narrow, and DENY beats ALLOW.
 */
export function auditRemotePolicy(
  policy: PrivyPolicyDocument,
  limits: PolicyLimits,
  extraMethods: readonly string[] = [],
): PolicyAudit {
  const findings: string[] = [];
  const unverified: string[] = [];
  const contracts = new Set<Address>();
  const calldataDestinations = new Set<Address>();
  const permitted = new Set([...EXPECTED_METHODS, ...extraMethods]);
  let ceiling: bigint | null = null;

  if (policy.version !== "1.0") {
    findings.push(
      `policy version ${JSON.stringify(policy.version)} is not the "1.0" schema this audit understands`,
    );
  }
  if (policy.chain_type !== "ethereum") {
    findings.push(`policy chain_type is ${JSON.stringify(policy.chain_type)}, not "ethereum"`);
  }

  for (const rule of policy.rules) {
    const label = JSON.stringify(rule.name || rule.method);
    if (rule.action !== "ALLOW") continue;

    if (!permitted.has(rule.method)) {
      findings.push(
        `rule ${label} allows ${rule.method}, which Anchor does not send and cannot bound — ` +
          "a signed message can move an asset without ever being a transaction a value cap sees",
      );
      continue;
    }
    if (rule.conditions.length === 0) {
      findings.push(`rule ${label} allows ${rule.method} with no conditions at all`);
      continue;
    }

    let boundsDestination = false;
    for (const condition of rule.conditions) {
      const field = condition.field.toLowerCase();
      const values = conditionValues(condition);

      if (condition.field_source === "ethereum_transaction" && field === "to") {
        if (condition.operator !== "eq" && condition.operator !== "in") {
          findings.push(
            `rule ${label} bounds the destination with ${JSON.stringify(condition.operator)}, ` +
              "which resolves against a list this client cannot read",
          );
          continue;
        }
        boundsDestination = true;
        for (const value of values) {
          const parsed = tryAddress(value);
          if (parsed === null) findings.push(`rule ${label} allows a destination that is not an address`);
          else contracts.add(parsed);
        }
        continue;
      }

      if (condition.field_source === "ethereum_transaction" && field === "value") {
        if (condition.operator !== "lte" && condition.operator !== "lt") continue;
        const parsed = values[0] === undefined ? null : safeBigInt(values[0]);
        if (parsed === null) {
          findings.push(`rule ${label} has a value cap this audit cannot read`);
        } else {
          const bound = condition.operator === "lt" ? parsed - 1n : parsed;
          ceiling = ceiling === null || bound < ceiling ? bound : ceiling;
        }
        continue;
      }

      if (condition.field_source === "ethereum_calldata") {
        if (field === "function_name") {
          for (const value of values) {
            if (value.toLowerCase() === SET_APPROVAL_FOR_ALL_FN) {
              findings.push(`rule ${label} allows the setApprovalForAll function`);
            }
          }
          continue;
        }
        // `safeTransferFrom.to`, `transfer.to` — the decoded destination parameter, which is where
        // an ERC-721 withdrawal's real recipient is, the transaction's own `to` being the token.
        if (field.endsWith(".to") && (condition.operator === "eq" || condition.operator === "in")) {
          for (const value of values) {
            const parsed = tryAddress(value);
            if (parsed !== null) calldataDestinations.add(parsed);
          }
        }
      }
    }

    if (!boundsDestination) {
      findings.push(`rule ${label} allows ${rule.method} without constraining the destination`);
    }
  }

  // Stated because it is the audit's own permissive edge, and an audit that hides its weak spot is
  // marketing. Allowlists are unioned across every ALLOW rule rather than correlated per rule: two
  // rules — one permitting contract A alongside vault X, another permitting contract B alongside
  // vault Y — read here as "A or B, to X or Y". Privy still evaluates each rule as written, so this
  // never permits something Privy would refuse; it means the audit is looser than Privy, not that
  // Privy is looser than the audit. One ALLOW rule keeps the two identical.
  if (policy.rules.filter((rule) => rule.action === "ALLOW").length > 1) {
    unverified.push(
      "more than one ALLOW rule: this audit unions their allowlists rather than correlating them " +
        "per rule, so it describes a slightly wider policy than Privy will actually enforce",
    );
  }

  // The local mirror must never describe more authority than Privy will grant.
  for (const contract of limits.contractAllowlist) {
    if (!allowlistHas([...contracts], contract)) {
      findings.push(`local allowlist contains ${contract}, which the Privy policy does not allow`);
    }
  }

  // Withdrawals are the control that makes a large balance survivable, so "Privy does not bound the
  // destination" is a finding rather than a note — the local mirror alone enforcing it would mean
  // the single most important limit lives in the process an attacker owns.
  if (limits.withdrawalAllowlist.length > 0) {
    if (calldataDestinations.size === 0) {
      findings.push(
        "the Privy policy does not bound a decoded `to` parameter, so withdrawal destinations are " +
          "enforced only by the local mirror — add an ethereum_calldata condition on " +
          "safeTransferFrom's `to` parameter",
      );
    }
    for (const destination of limits.withdrawalAllowlist) {
      if (!allowlistHas([...calldataDestinations], destination)) {
        findings.push(
          `local withdrawal allowlist contains ${destination}, which the Privy policy does not allow`,
        );
      }
    }
  }

  if (ceiling === null) {
    findings.push("no ALLOW rule bounds the transaction's native value");
  } else if (limits.denomination === "wei") {
    if (limits.perTransaction > ceiling) {
      findings.push(
        `local per-transaction cap ${limits.perTransaction} wei exceeds the Privy ceiling of ` +
          `${ceiling} wei`,
      );
    }
  } else {
    unverified.push(
      `local caps are denominated in ${limits.denomination} and Privy's ceiling is ${ceiling} wei; ` +
        "the two cannot be compared without an exchange rate, and this repository does not invent one",
    );
  }

  // Stated every time, because it is the gap most likely to be assumed away. Privy's cumulative
  // spend caps ("aggregations") are capped at a 72-hour rolling window, so the 7-day cap in
  // docs/autonomy.md has no remote equivalent at all — and aggregations only observe
  // `eth_signTransaction` and `eth_signUserOperation`, so a wallet driven with `eth_sendTransaction`
  // (which is what PrivySigner uses) accrues no aggregate spend whatsoever.
  unverified.push(
    "rolling 24h and 7d caps are enforced only by the local mirror: Privy aggregations do not " +
      "observe eth_sendTransaction, and their rolling window tops out at 72 hours",
  );

  return {
    allowlistedContracts: [...contracts],
    allowlistedCalldataDestinations: [...calldataDestinations],
    nativeValueCeilingWei: ceiling,
    findings,
    unverified,
  };
}

export class RemotePolicyRejected extends Error {
  readonly findings: readonly string[];

  constructor(audit: PolicyAudit) {
    super(
      `refusing to start against this Privy policy:\n  - ${audit.findings.join("\n  - ")}\n` +
        "Fix the policy in Privy, or narrow the local limits to match it.",
    );
    this.name = "RemotePolicyRejected";
    this.findings = audit.findings;
  }
}

// --- Building the transaction ------------------------------------------------------------------

/** An EVM transaction, as far as this workspace models one. `value` is wei. */
export interface EvmTransaction {
  readonly to: Address;
  readonly value: bigint;
  readonly data: string;
  readonly chainId: number;
}

/**
 * Turns an approved action into calldata.
 *
 * A separate interface because {@link ActionRequest} deliberately carries *intent* — a contract, a
 * token, a ceiling — and not calldata. An agent that could hand the signer arbitrary bytes would
 * have defeated the contract allowlist by construction, so the bytes are assembled here, from the
 * approved request, by something the agent does not supply.
 */
export interface TransactionBuilder {
  build(approved: ApprovedAction): Promise<EvmTransaction>;
}

export class UnsupportedAction extends Error {
  constructor(kind: string) {
    super(
      `no transaction builder for ${kind}. Marketplace actions need a signed order payload ` +
        "(Seaport fulfilment data), which ActionRequest does not model — see executor/README.md.",
    );
    this.name = "UnsupportedAction";
  }
}

/**
 * Builds ERC-721 withdrawals, and refuses everything else.
 *
 * `transfer` is the one action whose calldata is fully determined by the request: the collection,
 * the token, and a destination that policy has already checked against the withdrawal allowlist.
 * `buy`, `accept-offer` and `cancel-own-listing` all need a marketplace order payload that Anchor
 * does not have yet, and this class says so loudly rather than guessing at one.
 */
export class Erc721TransferBuilder implements TransactionBuilder {
  readonly #chainId: number;

  constructor(chainId: number) {
    this.#chainId = chainId;
  }

  async build(approved: ApprovedAction): Promise<EvmTransaction> {
    const request = approved.request;
    if (request.kind !== "transfer") throw new UnsupportedAction(request.kind);
    return {
      to: request.contract,
      value: 0n,
      data: encodeSafeTransferFrom(request.account, request.to, tokenIdToBigInt(request.tokenId)),
      chainId: this.#chainId,
    };
  }
}

// --- The signer ----------------------------------------------------------------------------------

export interface PrivySignerOptions {
  readonly api: PrivyWalletApi;
  /** Privy's wallet id, e.g. `qhpwcjt6pmxvpm5ngjb8spwj`. Not an address, and not a key. */
  readonly walletId: string;
  readonly builder: TransactionBuilder;
  readonly chainId: number;
  readonly now?: () => number;
}

/**
 * Submits approved actions to Privy for signing and broadcast.
 *
 * Everything this class checks, Privy checks again — that is the point, and it is why the checks
 * here are cheap and total rather than clever. What they buy is a *local* refusal with a clear
 * message for the cases where a bug on this side would otherwise be caught only by a remote 4xx.
 */
export class PrivySigner implements Signer {
  readonly #api: PrivyWalletApi;
  readonly #walletId: string;
  readonly #builder: TransactionBuilder;
  readonly #chainId: number;
  readonly #now: () => number;

  constructor(options: PrivySignerOptions) {
    this.#api = options.api;
    this.#walletId = options.walletId;
    this.#builder = options.builder;
    this.#chainId = options.chainId;
    this.#now = options.now ?? Date.now;
  }

  async submit(approved: ApprovedAction): Promise<SubmissionReceipt> {
    const now = this.#now();

    // Fail closed, exactly as InertSigner does. `approved` is typed, but a real signer is reachable
    // from code a cast can get to, and identity is the check that survives one.
    if (!isUsableApproval(approved, now)) {
      throw new Error("refusing to sign: approval was not minted by a policy authority, or has expired");
    }

    // Belt and braces. Policy denies this three checks earlier; if it ever reaches a signer, that is
    // a bug worth failing loudly on rather than a case worth handling gracefully.
    if (approved.request.kind === "set-approval-for-all") {
      throw new Error("refusing to sign: setApprovalForAll is never delegated");
    }

    const tx = await this.#builder.build(approved);

    // The builder is a collaborator, not a trusted one. Re-check its output against the approval.
    if (tx.to !== approved.request.contract) {
      throw new Error("refusing to sign: built transaction does not target the approved contract");
    }
    if (tx.chainId !== this.#chainId) {
      throw new Error("refusing to sign: built transaction is for a different chain");
    }
    if (containsSetApprovalForAll(tx.data)) {
      throw new Error("refusing to sign: calldata is a blanket operator approval");
    }
    // Compare against the ceiling only when the units actually match. A policy denominated in
    // USD-cents cannot bound a wei value without an exchange rate, and inventing one would make the
    // cap silently change size (types.ts, `addMoney`). Privy's own value condition bounds that case.
    if (approved.ceiling.denomination === "wei" && tx.value > approved.ceiling.amount) {
      throw new Error("refusing to sign: transaction value exceeds the approved ceiling");
    }

    const hash = await this.#api.sendTransaction({
      walletId: this.#walletId,
      caip2: caip2(tx.chainId),
      transaction: {
        to: tx.to,
        value: `0x${tx.value.toString(16)}`,
        data: tx.data,
        chain_id: tx.chainId,
      },
      // Derived from the approval, so a retried submission is the same transaction rather than a
      // second one. Approval ids are unique per decision and never reused.
      idempotencyKey: `anchor-${approved.approvalId}`,
    });

    return {
      approvalId: approved.approvalId,
      requestId: approved.request.id,
      transactionHash: hash,
      submittedAt: now,
      signer: `privy:${this.#walletId}`,
      broadcast: true,
    };
  }
}

// --- The policy authority ------------------------------------------------------------------------

export interface PrivyPolicyAuthorityOptions {
  readonly api: PrivyWalletApi;
  /** The Privy policy this authority mirrors and, on revocation, empties. */
  readonly policyId: string;
  /**
   * The local mirror's limits. Audited against the remote policy by {@link connectPrivyAuthority};
   * constructing this class directly skips that audit, which is why the factory is the documented
   * entry point.
   */
  readonly limits: PolicyLimits;
  readonly policyVersion?: string;
  readonly now?: () => number;
  /**
   * RPC methods to accept in the remote policy beyond the two Anchor sends.
   *
   * A deliberate widening, in code, in a diff, with a reviewer — not a config toggle. Adding
   * `personal_sign` here says "I have read what a signed Seaport order can do and I want it anyway."
   */
  readonly additionalAllowedMethods?: readonly string[];
}

/**
 * A {@link PolicyAuthority} whose kill switch and enforcement are remote.
 *
 * See the file header for the division of labour. In one sentence: the mirror produces the *reason*,
 * Privy produces the *refusal*.
 */
export class PrivyPolicyAuthority implements PolicyAuthority {
  readonly #api: PrivyWalletApi;
  readonly #policyId: string;
  readonly #mirror: PolicyEngine;
  readonly #version: string;
  readonly #now: () => number;
  #remotelyRevoked = false;

  constructor(options: PrivyPolicyAuthorityOptions) {
    this.#api = options.api;
    this.#policyId = options.policyId;
    this.#version = options.policyVersion ?? `privy:${options.policyId}`;
    this.#now = options.now ?? Date.now;
    this.#mirror = new PolicyEngine({
      limits: options.limits,
      policyVersion: this.#version,
      now: this.#now,
    });
  }

  /**
   * Judge a request. Delegated to the mirror, unchanged.
   *
   * There is no remote call here, because Privy's policy engine has no dry-run endpoint: their
   * enforcement point *is* the signing request. Adding a speculative `POST` to find out would submit
   * the transaction, which is the opposite of a preflight. So the local answer is the fast answer,
   * and the authoritative answer arrives at {@link PrivySigner.submit}.
   *
   * Note what is *not* delegated anywhere: the mint. `ApprovedAction` is created inside the mirror
   * by `mintApproval` and never crosses a process boundary, so no response from Privy — however
   * hostile, however well-formed — can become an approval.
   */
  evaluate(request: ActionRequest, simulation: Simulation): Promise<PolicyDecision> {
    return this.#mirror.evaluate(request, simulation);
  }

  settle(approval: ApprovedAction, outcome: Settlement): Promise<void> {
    return this.#mirror.settle(approval, outcome);
  }

  /**
   * The kill switch, for real: the local mirror stops approving, and the Privy policy is emptied.
   *
   * Order matters. The local flag flips first and unconditionally, so that even if the network is
   * gone, this process stops minting approvals immediately. The remote call is what actually removes
   * authority — a policy with no rules resolves to DENY for every request — and if it fails, this
   * method throws rather than returning a receipt, because a receipt would be a claim that authority
   * was revoked when it may not have been.
   *
   * Retrying is safe: emptying an already-empty policy is a no-op, and the local flag is idempotent.
   */
  async revoke(reason: string): Promise<RevocationReceipt> {
    const receipt = await this.#mirror.revoke(reason);
    if (this.#remotelyRevoked) return receipt;

    try {
      await this.#api.replacePolicyRules({ policyId: this.#policyId, rules: [] });
    } catch (error) {
      throw new Error(
        "local authority is revoked, but Privy did not confirm the policy change — the wallet " +
          `may still sign. Retry, or empty the policy in Privy's dashboard. (${describe(error)})`,
      );
    }
    this.#remotelyRevoked = true;
    return receipt;
  }

  status(): Promise<ExecutorStatus> {
    return this.#mirror.status();
  }
}

/** An error's name and message, with no chance of a `cause` chain carrying a header into a log. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

/**
 * The documented way to build a Privy-backed authority: fetch the policy, audit it, then construct.
 *
 * Fails closed. A policy Anchor cannot read, or one that grants more than the local limits claim, is
 * a refusal to start — not a warning. Starting anyway would mean the status screen and the audit log
 * describe limits that are not the limits actually in force, and a policy nobody can read is
 * indistinguishable from no policy.
 */
export async function connectPrivyAuthority(
  options: PrivyPolicyAuthorityOptions,
): Promise<{ authority: PrivyPolicyAuthority; audit: PolicyAudit }> {
  const policy = await options.api.getPolicy(options.policyId);
  const audit = auditRemotePolicy(policy, options.limits, options.additionalAllowedMethods ?? []);
  if (audit.findings.length > 0) throw new RemotePolicyRejected(audit);
  return { authority: new PrivyPolicyAuthority(options), audit };
}
