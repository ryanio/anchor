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
 *    `setApprovalForAll` on EVM or an SPL delegation on Solana, or (on either) an allowlist that is
 *    not scoped to one chain. This is the check that makes the local mirror below trustworthy as a
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
 *
 * ## Solana, and where the vendor is weaker than on EVM
 *
 * A Privy policy has one `chain_type` and a wallet supports one policy, so an EVM wallet and a
 * Solana wallet are two wallets, two policies, and two of these authorities. {@link auditRemotePolicy}
 * dispatches on the architecture of the *local* limits and checks the policy's claim against it.
 *
 * Three differences are worth knowing before trusting the Solana side, and none of them is a detail:
 *
 * 1. **Privy cannot name `Approve` or `SetAuthority` in a rule.** Their Solana condition sources are
 *    `solana_program_instruction` (`programId` only), `solana_system_program_instruction`, and
 *    `solana_token_program_instruction`, whose decoder covers `Transfer`, `TransferChecked`, `Burn`,
 *    `MintTo`, `CloseAccount` and `InitializeAccount3`. The two instructions Anchor treats as
 *    human-only are not in that set and no other source reaches them. There is no equivalent of the
 *    EVM `function_name` condition that lets a policy refuse `setApprovalForAll` by name. The only
 *    remote control is an ALLOW rule that pins `instructionName` to a permitted list, so that
 *    default-deny catches the rest — which works, and which vanishes silently if that one condition
 *    is omitted. The audit therefore treats its absence as a finding.
 * 2. **There is no aggregation primitive at all.** On EVM the cumulative caps are limited to a
 *    72-hour window on two methods; on Solana Privy's stateful policies support no Solana method
 *    whatsoever, so there is no remote cumulative cap of any window.
 * 3. **Address lookup tables defeat address conditions.** Privy document that a condition needing an
 *    address a v0 transaction loads from an ALT causes evaluation to *fail*, rejecting the
 *    transaction. Fail-closed, and therefore safe — but it means a remote withdrawal-destination
 *    allowlist and a marketplace-built swap are close to mutually exclusive today.
 *
 * {@link PrivySolanaSigner} adds a local check Privy cannot do: it parses the transaction and
 * refuses any SPL delegation or authority transfer, an unallowlisted program, or an unrecognised
 * token instruction. See `solana.ts` for what that can and cannot establish.
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
import type {
  PrivyPolicyCondition,
  PrivyPolicyDocument,
  PrivyPolicyRule,
  PrivyWalletApi,
} from "./privy-api.ts";
import {
  guardSolanaTransaction,
  SOLANA_CAIP2,
  type SolanaCluster,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  type TransactionGuardResult,
  toBase64,
} from "./solana.ts";
import {
  type ActionRequest,
  allowlistHas,
  type ChainAddress,
  type ChainArch,
  chainAddress,
  chainArch,
  type EvmAddress,
  formatChainAddress,
  isEvmAddress,
  isHumanOnlyActionKind,
  type Simulation,
  type SolanaAddress,
  tryEvmAddress,
  trySolanaAddress,
} from "./types.ts";

// --- Auditing the remote policy ----------------------------------------------------------------

/**
 * The RPC methods an Anchor-shaped policy is expected to permit, per architecture.
 *
 * Anything else in an ALLOW rule is a finding, because the interesting attacks are all methods
 * rather than parameters. `exportPrivateKey` and `exportSeedPhrase` hand over the key. `*` is all of
 * the above. The signing methods are the subtle ones and they exist on both sides: EVM's
 * `personal_sign` and `eth_signTypedData_v4` produce a signed Seaport order, and Solana's
 * `signMessage` produces an off-chain signature — either moves an asset without ever being a
 * transaction that a `value` or `programId` condition could bound. An approval-shaped hole with a
 * different name, twice. A user who genuinely needs one widens
 * {@link PrivyPolicyAuthorityOptions.additionalAllowedMethods} deliberately, in code, in a diff.
 *
 * All values verified against Privy's policy documentation; see `executor/README.md`.
 */
const EXPECTED_METHODS: Readonly<Record<ChainArch, readonly string[]>> = {
  evm: ["eth_sendTransaction", "eth_signTransaction"],
  svm: ["signAndSendTransaction", "signTransaction"],
};

/** The `chain_type` Privy uses for each architecture. Privy also has tron, sui and xrpl. */
const EXPECTED_CHAIN_TYPE: Readonly<Record<ChainArch, string>> = { evm: "ethereum", svm: "solana" };

/** Privy's function-name conditions name the function; this is the one that is never allowed. */
const SET_APPROVAL_FOR_ALL_FN = "setapprovalforall";

/**
 * The SPL Token instructions a Privy rule may name and still be a policy Anchor will run against.
 *
 * Privy's `solana_token_program_instruction` source decodes exactly six instructions — `Transfer`,
 * `TransferChecked`, `Burn`, `MintTo`, `CloseAccount` and `InitializeAccount3`. `Burn` and `MintTo`
 * are supply operations and no Anchor action needs them, so they are off this list; the rest are the
 * ones a wallet actually sends.
 *
 * The set matters far more than it looks. See {@link auditSolanaRule}: this is the *only* lever
 * Privy gives a Solana policy for keeping `Approve` and `SetAuthority` out.
 */
const PERMITTED_TOKEN_INSTRUCTIONS: ReadonlySet<string> = new Set([
  "transfer",
  "transferchecked",
  "closeaccount",
  "initializeaccount3",
]);

/** A ceiling on native value, with the unit it is expressed in. Never compared across units. */
export interface NativeValueCeiling {
  readonly amount: bigint;
  readonly unit: "wei" | "lamports";
}

/**
 * What a read of the remote policy establishes, and what it could not establish.
 *
 * Separated from the throwing wrapper so the result is inspectable in a test and printable by an
 * operator: "here is what Privy will actually allow" is the single most useful thing to see before
 * pointing this at a funded wallet.
 */
export interface PolicyAudit {
  /** Which architecture this policy was read as. Derived from its `chain_type`. */
  readonly arch: ChainArch;
  /**
   * Subjects some ALLOW rule permits: an EVM transaction destination, or a Solana program id.
   *
   * Scoped to the chain the local limits describe, because a Privy EVM policy that does not bound
   * `chain_id` says nothing about which chain its `to` allowlist applies to — which is itself a
   * finding below.
   */
  readonly allowlistedContracts: readonly ChainAddress[];
  /**
   * Addresses some ALLOW rule permits as the *decoded destination parameter* of a call — where a
   * withdrawal's real recipient lives, since the EVM transaction's own `to` is the collection and
   * the Solana instruction's program id is the token program.
   */
  readonly allowlistedCalldataDestinations: readonly ChainAddress[];
  /**
   * Program ids a Solana policy permits an instruction to invoke. Empty for an EVM policy.
   *
   * Separate from {@link allowlistedContracts} because on Solana they are different questions: the
   * program is *which code runs*, the mint is *which asset moves*, and a policy can bound one
   * without bounding the other. Conflating them is how a "the token program is allowlisted" reads
   * as "only my token can leave".
   */
  readonly allowlistedPrograms: readonly SolanaAddress[];
  /**
   * The tightest native-value ceiling any ALLOW rule imposes, or `null` when no rule constrains
   * value at all. `null` is a finding, not a default.
   */
  readonly nativeValueCeiling: NativeValueCeiling | null;
  /** Reasons this policy is not safe to run against. Non-empty means refuse to start. */
  readonly findings: readonly string[];
  /** Facts the audit could not check, stated rather than quietly assumed. */
  readonly unverified: readonly string[];
}

/** Everything an audit needs beyond the policy document itself. */
export interface PolicyAuditOptions {
  readonly limits: PolicyLimits;
  /**
   * The chain slug the local limits describe.
   *
   * Required, and not inferable from the policy: a Privy policy's `chain_type` says `ethereum`, not
   * *which* EVM chain, so the audit cannot pair a `to` allowlist with a chain without being told.
   */
  readonly chain: string;
  readonly additionalAllowedMethods?: readonly string[];
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

/** Mutable state one audit accumulates while walking a policy's ALLOW rules. */
interface AuditPass {
  readonly findings: string[];
  readonly unverified: string[];
  /** Keyed by `chain:address` so the pair, not the address, is what deduplicates. */
  readonly contracts: Map<string, ChainAddress>;
  readonly destinations: Map<string, ChainAddress>;
  readonly programs: Map<string, SolanaAddress>;
  ceiling: NativeValueCeiling | null;
}

function newPass(): AuditPass {
  return {
    findings: [],
    unverified: [],
    contracts: new Map(),
    destinations: new Map(),
    programs: new Map(),
    ceiling: null,
  };
}

function remember(into: Map<string, ChainAddress>, entry: ChainAddress): void {
  into.set(formatChainAddress(entry), entry);
}

/**
 * Tighten a ceiling. `lt` is one less than `lte`, and the tightest of all rules wins.
 *
 * "Tightest" is a comparison, so it is only meaningful within one unit. One policy has one
 * `chain_type` and therefore one unit, so a mixed pass should be unreachable — which is exactly why
 * it is a finding rather than an assumption. A silently wrong comparison here would produce a
 * ceiling smaller than any rule actually imposes, and a cap that is wrong in the *permissive*
 * direction is the kind that never gets noticed.
 */
function tighten(pass: AuditPass, operator: string, raw: string | undefined, unit: "wei" | "lamports"): void {
  const parsed = raw === undefined ? null : safeBigInt(raw);
  if (parsed === null) {
    pass.findings.push("a rule has a value cap this audit cannot read");
    return;
  }
  const amount = operator === "lt" ? parsed - 1n : parsed;
  const current = pass.ceiling;
  if (current !== null && current.unit !== unit) {
    pass.findings.push(
      `this policy bounds value in both ${current.unit} and ${unit}, which cannot be compared — ` +
        "one policy governs one chain type and should express one unit",
    );
    return;
  }
  if (current === null || amount < current.amount) pass.ceiling = { amount, unit };
}

/** `eq` and `in` are the only operators whose permitted set this client can enumerate. */
function bounds(condition: PrivyPolicyCondition): boolean {
  return condition.operator === "eq" || condition.operator === "in";
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
 *
 * The architecture is taken from the *local* configuration and the policy's `chain_type` is checked
 * against it, rather than the other way round: a policy that claims to be for a different chain than
 * the limits describe is a finding, not an instruction to audit it differently.
 */
export function auditRemotePolicy(policy: PrivyPolicyDocument, options: PolicyAuditOptions): PolicyAudit {
  const arch = chainArch(options.chain);
  const pass = newPass();

  if (policy.version !== "1.0") {
    pass.findings.push(
      `policy version ${JSON.stringify(policy.version)} is not the "1.0" schema this audit understands`,
    );
  }
  if (policy.chain_type !== EXPECTED_CHAIN_TYPE[arch]) {
    pass.findings.push(
      `policy chain_type is ${JSON.stringify(policy.chain_type)}, but the local limits are for ` +
        `${options.chain}, which needs ${JSON.stringify(EXPECTED_CHAIN_TYPE[arch])}`,
    );
  }

  const permitted = new Set([...EXPECTED_METHODS[arch], ...(options.additionalAllowedMethods ?? [])]);
  for (const rule of policy.rules) {
    if (rule.action !== "ALLOW") continue;
    const label = JSON.stringify(rule.name || rule.method);

    if (!permitted.has(rule.method)) {
      pass.findings.push(
        `rule ${label} allows ${rule.method}, which Anchor does not send and cannot bound — ` +
          "a signed message can move an asset without ever being a transaction a value cap sees",
      );
      continue;
    }
    if (rule.conditions.length === 0) {
      pass.findings.push(`rule ${label} allows ${rule.method} with no conditions at all`);
      continue;
    }

    if (arch === "evm") auditEvmRule(rule, label, options.chain, pass);
    else auditSolanaRule(rule, label, options.chain, pass);
  }

  finishAudit(policy, options, arch, pass);

  return {
    arch,
    allowlistedContracts: [...pass.contracts.values()],
    allowlistedCalldataDestinations: [...pass.destinations.values()],
    allowlistedPrograms: [...pass.programs.values()],
    nativeValueCeiling: pass.ceiling,
    findings: pass.findings,
    unverified: pass.unverified,
  };
}

/**
 * One ALLOW rule of an `ethereum` policy.
 *
 * Unchanged in substance from the EVM-only version, with one addition: a rule that does not bound
 * `chain_id` is now a finding. Privy's `chain_type` is `ethereum`, not a chain — so without that
 * condition an allowlisted `to` is allowlisted on *every* EVM chain the wallet can be asked to
 * broadcast on, and a `CREATE2` deployment puts an attacker's code at that address on one the user
 * never configured. The local mirror checks the chain; the remote policy has to as well, or the
 * check lives only in the process an attacker owns.
 */
function auditEvmRule(rule: PrivyPolicyRule, label: string, chain: string, pass: AuditPass): void {
  let boundsDestination = false;
  let boundsChain = false;

  for (const condition of rule.conditions) {
    const field = condition.field.toLowerCase();
    const values = conditionValues(condition);

    if (condition.field_source === "ethereum_transaction" && field === "to") {
      if (!bounds(condition)) {
        pass.findings.push(
          `rule ${label} bounds the destination with ${JSON.stringify(condition.operator)}, ` +
            "which resolves against a list this client cannot read",
        );
        continue;
      }
      boundsDestination = true;
      for (const value of values) {
        const parsed = tryEvmAddress(value);
        if (parsed === null) pass.findings.push(`rule ${label} allows a destination that is not an address`);
        else remember(pass.contracts, chainAddress(chain, parsed));
      }
      continue;
    }

    if (condition.field_source === "ethereum_transaction" && field === "chain_id") {
      if (bounds(condition)) boundsChain = true;
      continue;
    }

    if (condition.field_source === "ethereum_transaction" && field === "value") {
      if (condition.operator !== "lte" && condition.operator !== "lt") continue;
      tighten(pass, condition.operator, values[0], "wei");
      continue;
    }

    if (condition.field_source === "ethereum_calldata") {
      if (field === "function_name") {
        for (const value of values) {
          if (value.toLowerCase() === SET_APPROVAL_FOR_ALL_FN) {
            pass.findings.push(`rule ${label} allows the setApprovalForAll function`);
          }
        }
        continue;
      }
      // `safeTransferFrom.to`, `transfer.to` — the decoded destination parameter, which is where an
      // ERC-721 withdrawal's real recipient is, the transaction's own `to` being the token.
      if (field.endsWith(".to") && bounds(condition)) {
        for (const value of values) {
          const parsed = tryEvmAddress(value);
          if (parsed !== null) remember(pass.destinations, chainAddress(chain, parsed));
        }
      }
    }
  }

  if (!boundsDestination) {
    pass.findings.push(`rule ${label} allows ${rule.method} without constraining the destination`);
  }
  if (!boundsChain) {
    pass.findings.push(
      `rule ${label} does not bound ethereum_transaction.chain_id, so its destination allowlist ` +
        `applies on every EVM chain rather than only on ${chain}`,
    );
  }
}

/**
 * One ALLOW rule of a `solana` policy — and the place where the vendor gap is worst.
 *
 * ## Why the `instructionName` condition is load-bearing
 *
 * Privy's Solana policy engine exposes three condition sources: `solana_program_instruction`
 * (`programId` only), `solana_system_program_instruction`, and `solana_token_program_instruction`,
 * whose decoder covers exactly `Transfer`, `TransferChecked`, `Burn`, `MintTo`, `CloseAccount` and
 * `InitializeAccount3`.
 *
 * **`Approve`, `ApproveChecked` and `SetAuthority` are not in that set, and no other source
 * reaches them.** There is no Solana equivalent of the `ethereum_calldata` + `function_name`
 * condition that lets an EVM policy name `setApprovalForAll` and refuse it. So a rule that permits
 * the SPL Token program by `programId` alone permits *every* instruction to it — including the two
 * that Anchor treats as human-only, and including the one that hands over the account.
 *
 * The only lever left is Privy's default-deny: an ALLOW rule that also pins `instructionName` to a
 * permitted set refuses anything outside it, because no rule then resolves and the engine denies.
 * That inverts the control — it is an allowlist of instructions rather than a denial of three — and
 * it is strictly better, but it is fragile in a way the EVM version is not: **omit that one
 * condition and the refusal is gone with no error anywhere.** Hence a finding rather than a note.
 */
function auditSolanaRule(rule: PrivyPolicyRule, label: string, chain: string, pass: AuditPass): void {
  const programs: SolanaAddress[] = [];
  const instructionNames = new Set<string>();
  let boundsProgram = false;
  let boundsInstruction = false;

  for (const condition of rule.conditions) {
    const field = condition.field.toLowerCase();
    const values = conditionValues(condition);

    if (condition.field_source === "solana_program_instruction" && field === "programid") {
      if (!bounds(condition)) {
        pass.findings.push(
          `rule ${label} bounds programId with ${JSON.stringify(condition.operator)}, ` +
            "which resolves against a list this client cannot read",
        );
        continue;
      }
      boundsProgram = true;
      for (const value of values) {
        const parsed = trySolanaAddress(value);
        if (parsed === null) pass.findings.push(`rule ${label} allows a program id that is not an address`);
        else {
          programs.push(parsed);
          pass.programs.set(parsed, parsed);
        }
      }
      continue;
    }

    if (condition.field_source === "solana_token_program_instruction") {
      if (field === "instructionname") {
        if (!bounds(condition)) {
          pass.findings.push(
            `rule ${label} bounds instructionName with ${JSON.stringify(condition.operator)}, ` +
              "which resolves against a list this client cannot read",
          );
          continue;
        }
        boundsInstruction = true;
        for (const value of values) {
          const name = value.toLowerCase();
          instructionNames.add(name);
          if (!PERMITTED_TOKEN_INSTRUCTIONS.has(name)) {
            pass.findings.push(
              `rule ${label} allows the SPL token instruction ${JSON.stringify(value)}, which is ` +
                "not one Anchor sends",
            );
          }
        }
        continue;
      }
      // `TransferChecked.mint` is the only condition that can bound *which token* leaves, and it is
      // therefore the Solana analogue of the EVM contract allowlist.
      if (field === "transferchecked.mint" && bounds(condition)) {
        for (const value of values) {
          const parsed = trySolanaAddress(value);
          if (parsed !== null) remember(pass.contracts, chainAddress(chain, parsed));
        }
        continue;
      }
      if (
        (field === "transfer.destination" || field === "transferchecked.destination") &&
        bounds(condition)
      ) {
        for (const value of values) {
          const parsed = trySolanaAddress(value);
          if (parsed !== null) remember(pass.destinations, chainAddress(chain, parsed));
        }
      }
      continue;
    }

    if (condition.field_source === "solana_system_program_instruction") {
      if (field === "transfer.to" && bounds(condition)) {
        for (const value of values) {
          const parsed = trySolanaAddress(value);
          if (parsed !== null) remember(pass.destinations, chainAddress(chain, parsed));
        }
        continue;
      }
      if (field === "transfer.lamports" && (condition.operator === "lte" || condition.operator === "lt")) {
        tighten(pass, condition.operator, values[0], "lamports");
      }
    }
  }

  if (!boundsProgram) {
    pass.findings.push(
      `rule ${label} allows ${rule.method} without a solana_program_instruction programId ` +
        "condition, so it permits an instruction to any program at all — and anything can deploy " +
        "a Solana program",
    );
  }

  const touchesToken = programs.some(
    (program) => program === SPL_TOKEN_PROGRAM || program === SPL_TOKEN_2022_PROGRAM,
  );
  if (touchesToken && !boundsInstruction) {
    pass.findings.push(
      `rule ${label} permits the SPL token program by program id alone. Privy's Solana policy ` +
        "engine has no condition that can name Approve, ApproveChecked or SetAuthority, so this " +
        "rule allows an agent to delegate the token account or hand it over outright. Add a " +
        "solana_token_program_instruction instructionName condition listing only the instructions " +
        "you send — that is the only remote control there is.",
    );
  }
  // Unconditional, and not weakened by `TransferChecked` also being on the list. The unchecked
  // `Transfer` instruction has no mint parameter at all, so a `TransferChecked.mint` condition
  // beside it constrains only the checked variant — the policy looks like it bounds which token can
  // leave, and does not. Two instructions on one list, one of them uncheckable, is worse than
  // either alone, because the presence of the other is what makes it look covered.
  if (touchesToken && instructionNames.has("transfer")) {
    pass.findings.push(
      `rule ${label} permits the unchecked SPL Transfer instruction, which carries no mint, so no ` +
        "condition can bound which token leaves the wallet. Send TransferChecked instead.",
    );
  }
}

/** The cross-checks and caveats that are the same whatever the architecture. */
function finishAudit(
  policy: PrivyPolicyDocument,
  options: PolicyAuditOptions,
  arch: ChainArch,
  pass: AuditPass,
): void {
  const limits = options.limits;

  // Stated because it is the audit's own permissive edge, and an audit that hides its weak spot is
  // marketing. Allowlists are unioned across every ALLOW rule rather than correlated per rule: two
  // rules — one permitting contract A alongside vault X, another permitting contract B alongside
  // vault Y — read here as "A or B, to X or Y". Privy still evaluates each rule as written, so this
  // never permits something Privy would refuse; it means the audit is looser than Privy, not that
  // Privy is looser than the audit. One ALLOW rule keeps the two identical.
  if (policy.rules.filter((rule) => rule.action === "ALLOW").length > 1) {
    pass.unverified.push(
      "more than one ALLOW rule: this audit unions their allowlists rather than correlating them " +
        "per rule, so it describes a slightly wider policy than Privy will actually enforce",
    );
  }

  // The local mirror must never describe more authority than Privy will grant.
  const audited = [...pass.contracts.values()];
  for (const contract of limits.contractAllowlist) {
    if (contract.chain !== options.chain) {
      pass.findings.push(
        `local allowlist contains ${formatChainAddress(contract)}, which is not on ${options.chain} — ` +
          "one Privy policy governs one wallet on one chain type, so a second chain needs its own " +
          "wallet, its own policy, and its own audit",
      );
      continue;
    }
    if (!allowlistHas(audited, contract)) {
      pass.findings.push(
        `local allowlist contains ${formatChainAddress(contract)}, which the Privy policy does not allow`,
      );
    }
  }

  // Withdrawals are the control that makes a large balance survivable, so "Privy does not bound the
  // destination" is a finding rather than a note — the local mirror alone enforcing it would mean
  // the single most important limit lives in the process an attacker owns.
  if (limits.withdrawalAllowlist.length > 0) {
    if (pass.destinations.size === 0) {
      pass.findings.push(
        arch === "evm"
          ? "the Privy policy does not bound a decoded `to` parameter, so withdrawal destinations " +
              "are enforced only by the local mirror — add an ethereum_calldata condition on " +
              "safeTransferFrom's `to` parameter"
          : "the Privy policy does not bound a decoded destination, so withdrawal destinations are " +
              "enforced only by the local mirror — add a solana_token_program_instruction " +
              "condition on TransferChecked.destination",
      );
    }
    const destinations = [...pass.destinations.values()];
    for (const destination of limits.withdrawalAllowlist) {
      if (destination.chain !== options.chain) continue; // already reported above, per contract.
      if (!allowlistHas(destinations, destination)) {
        pass.findings.push(
          `local withdrawal allowlist contains ${formatChainAddress(destination)}, which the Privy ` +
            "policy does not allow",
        );
      }
    }
  }

  const ceiling = pass.ceiling;
  if (ceiling === null) {
    pass.findings.push("no ALLOW rule bounds the transaction's native value");
  } else if (limits.denomination === ceiling.unit) {
    if (limits.perTransaction > ceiling.amount) {
      pass.findings.push(
        `local per-transaction cap ${limits.perTransaction} ${ceiling.unit} exceeds the Privy ` +
          `ceiling of ${ceiling.amount} ${ceiling.unit}`,
      );
    }
  } else {
    pass.unverified.push(
      `local caps are denominated in ${limits.denomination} and Privy's ceiling is ` +
        `${ceiling.amount} ${ceiling.unit}; the two cannot be compared without an exchange rate, ` +
        "and this repository does not invent one",
    );
  }

  if (arch === "evm") {
    // Stated every time, because it is the gap most likely to be assumed away. Privy's cumulative
    // spend caps ("aggregations") are capped at a 72-hour rolling window, so the 7-day cap in
    // docs/autonomy.md has no remote equivalent at all — and aggregations only observe
    // `eth_signTransaction` and `eth_signUserOperation`, so a wallet driven with
    // `eth_sendTransaction` (which is what PrivySigner uses) accrues no aggregate spend whatsoever.
    pass.unverified.push(
      "rolling 24h and 7d caps are enforced only by the local mirror: Privy aggregations do not " +
        "observe eth_sendTransaction, and their rolling window tops out at 72 hours",
    );
  } else {
    // Worse than the EVM case, and worth saying separately rather than softening into the same
    // sentence. Privy's stateful policies ("aggregations") document exactly two supported methods,
    // `eth_signTransaction` and `eth_signUserOperation`. There is no Solana method on that list, so
    // there is no cumulative limit of any window to be had remotely — not 72 hours, not one hour.
    pass.unverified.push(
      "there is no remote cumulative cap of any kind on Solana: Privy aggregations support only " +
        "eth_signTransaction and eth_signUserOperation, so both the 24h and the 7d caps are " +
        "enforced solely by the local mirror",
    );
    // The one Privy documents themselves, and the reason a real swap and a destination allowlist
    // are close to mutually exclusive today. Fail-closed, which is the right direction — but a
    // control that rejects the legitimate transaction is a control users route around.
    pass.unverified.push(
      "Privy's Solana policy evaluation cannot resolve address lookup tables: if a condition needs " +
        "an address that a v0 transaction loads from an ALT, evaluation fails and the transaction " +
        "is rejected. A destination allowlist therefore only works when the destination is in the " +
        "transaction's static account keys, which a marketplace-built swap does not guarantee",
    );
  }
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
  readonly to: EvmAddress;
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
    // The addresses are typed as `Address`, a union across architectures, so this builder has to
    // prove it is on its own before it can ABI-encode anything. Before chains were first class this
    // check did not exist because it could not fail; now the compiler will not let it be skipped.
    if (!isEvmAddress(request.contract) || !isEvmAddress(request.account) || !isEvmAddress(request.to)) {
      throw new UnsupportedAction(`transfer on ${request.chain}`);
    }
    if (request.subject.asset !== "non-fungible") {
      throw new UnsupportedAction("transfer of a fungible balance (this builder writes ERC-721 calldata)");
    }
    return {
      to: request.contract,
      value: 0n,
      data: encodeSafeTransferFrom(request.account, request.to, tokenIdToBigInt(request.subject.tokenId)),
      chainId: this.#chainId,
    };
  }
}

/**
 * Why there is no `SolanaTransferBuilder`, and what it would take to write one.
 *
 * This is the one place where the Solana half genuinely could not be finished without a runtime
 * dependency, so it is a class that explains itself rather than a gap someone has to notice.
 *
 * Building an SPL transfer means producing a *compiled v0 message*, and three of its inputs are not
 * things this workspace can compute:
 *
 * 1. **The associated token accounts.** Both the source and the destination are program-derived
 *    addresses, and deriving one means hashing candidate seeds until the result is a point *not* on
 *    the ed25519 curve. That on-curve test is ed25519 field arithmetic — decompressing a point,
 *    checking it satisfies the curve equation — and it is the kind of code that is either correct
 *    or silently produces a plausible-looking address that nobody holds the key to. Hand-rolling it
 *    to move a user's tokens is not a trade worth making.
 * 2. **A recent blockhash**, which is a live RPC read, not a computation.
 * 3. **The address lookup tables** a marketplace-built transaction expects to reference.
 *
 * Contrast the read path in `solana.ts`, which needs none of that: parsing a message is compact-u16
 * plus fixed offsets, and every check the guard makes reads bytes that are already inline. Refusing
 * is cheap; constructing is not.
 *
 * The honest options, in the order Anchor should prefer them:
 *
 * - **Take the transaction from OpenSea.** `POST /api/v2/swap/execute` already returns an ordered
 *   list of executable transactions with the Solana instructions and lookup tables (docs/chains.md).
 *   Anchor would still have to compile and sign, so this removes the derivation but not the
 *   blockhash — worth checking whether the endpoint can return a compiled message.
 * - **Add `@solana/kit`** (the maintained successor to `@solana/web3.js`), which is tree-shakeable
 *   and would be scoped to address derivation and message compilation only. That is a runtime
 *   dependency and AGENTS.md says a human decides it — so nothing here adds one.
 *
 * Until one of those happens, a Solana `transfer` is approved by policy and then refused here, which
 * is the same shape `Erc721TransferBuilder` uses for marketplace actions: loudly unimplemented
 * rather than quietly guessed at.
 */
export class SolanaBuilderNotImplemented extends Error {
  constructor(chain: string) {
    super(
      `Anchor cannot build a ${chain} transaction. Compiling an SPL transfer needs associated ` +
        "token account derivation (ed25519 on-curve arithmetic) and a live blockhash, neither of " +
        "which this dependency-free workspace can do — see SolanaBuilderNotImplemented in privy.ts.",
    );
    this.name = "SolanaBuilderNotImplemented";
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

    // Belt and braces. Policy denies these three checks earlier; if one ever reaches a signer, that
    // is a bug worth failing loudly on rather than a case worth handling gracefully.
    if (isHumanOnlyActionKind(approved.request.kind)) {
      throw new Error(`refusing to sign: ${approved.request.kind} is never delegated`);
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

// --- The Solana signer ---------------------------------------------------------------------------

/** A compiled Solana transaction, ready to hand to Privy. */
export interface SolanaTransaction {
  readonly serialized: Uint8Array;
  readonly cluster: SolanaCluster;
}

/**
 * Produces the bytes a Solana signer submits.
 *
 * Same contract as {@link TransactionBuilder}, and the same reason for existing: an agent that could
 * hand the signer arbitrary bytes would have defeated every allowlist by construction, so the bytes
 * come from something the agent does not supply. There is no implementation in this repository yet —
 * see {@link SolanaBuilderNotImplemented} for exactly what is missing and why.
 */
export interface SolanaTransactionBuilder {
  build(approved: ApprovedAction): Promise<SolanaTransaction>;
}

/** The only builder shipped today: it explains itself and refuses. */
export class UnimplementedSolanaBuilder implements SolanaTransactionBuilder {
  async build(approved: ApprovedAction): Promise<SolanaTransaction> {
    throw new SolanaBuilderNotImplemented(approved.request.chain);
  }
}

/** How many guard results {@link PrivySolanaSigner.guarded} keeps. */
const GUARD_HISTORY = 64;

export interface PrivySolanaSignerOptions {
  readonly api: PrivyWalletApi;
  readonly walletId: string;
  readonly builder: SolanaTransactionBuilder;
  readonly cluster: SolanaCluster;
  /** Program ids an instruction may invoke. Defaults to `solana.ts`'s conservative list. */
  readonly programAllowlist?: readonly SolanaAddress[];
  readonly now?: () => number;
}

/**
 * Submits approved Solana actions to Privy, after reading the transaction it is about to sign.
 *
 * The EVM signer's last-line checks are a selector comparison and a `to` comparison. Here they are a
 * *parse*, and the difference is worth stating plainly rather than letting the symmetry imply more
 * than it delivers:
 *
 * - **What this catches, soundly:** an instruction to a program that is not allowlisted; any SPL
 *   `Approve`, `ApproveChecked`, `Revoke` or `SetAuthority`; a token instruction whose tag Anchor
 *   does not recognise; a program-id index that is not a static account key; a transaction whose fee
 *   payer is not the approved account. None of these depend on resolving an address lookup table,
 *   because all of them read program ids and instruction data, which are inline in the message.
 * - **What it cannot catch:** where the value actually goes. A v0 transaction's operand accounts can
 *   come from lookup tables whose contents are on chain, and Anchor does not read chain state. The
 *   withdrawal-destination allowlist is therefore *not* enforced against the transaction bytes here;
 *   it is enforced against the request and its simulation, upstream. Privy is no better off — their
 *   own documentation says a policy condition needing an ALT-resolved address fails evaluation.
 *
 * So: this signer can prove the transaction contains something forbidden. It cannot prove it is
 * safe, and the `guard` it stamps on the receipt says which of the two happened.
 */
export class PrivySolanaSigner implements Signer {
  readonly #api: PrivyWalletApi;
  readonly #walletId: string;
  readonly #builder: SolanaTransactionBuilder;
  readonly #cluster: SolanaCluster;
  readonly #programAllowlist: readonly SolanaAddress[] | undefined;
  readonly #now: () => number;
  /**
   * Recent guard results, newest last, for the audit log and for tests.
   *
   * Bounded, unlike `InertSigner.submitted` — that one is a test double and may grow forever, this
   * one runs for as long as the desktop is up. A ring of the last {@link GUARD_HISTORY} is enough
   * for "what did it just refuse and why"; the durable record belongs in the data service's log
   * (docs/autonomy.md, "observability"), not in a field on a signer.
   */
  readonly guarded: TransactionGuardResult[] = [];

  constructor(options: PrivySolanaSignerOptions) {
    this.#api = options.api;
    this.#walletId = options.walletId;
    this.#builder = options.builder;
    this.#cluster = options.cluster;
    this.#programAllowlist = options.programAllowlist;
    this.#now = options.now ?? Date.now;
  }

  async submit(approved: ApprovedAction): Promise<SubmissionReceipt> {
    const now = this.#now();

    if (!isUsableApproval(approved, now)) {
      throw new Error("refusing to sign: approval was not minted by a policy authority, or has expired");
    }
    if (isHumanOnlyActionKind(approved.request.kind)) {
      throw new Error(`refusing to sign: ${approved.request.kind} is never delegated`);
    }

    const tx = await this.#builder.build(approved);
    if (tx.cluster !== this.#cluster) {
      throw new Error("refusing to sign: built transaction is for a different cluster");
    }

    const guard = guardSolanaTransaction(tx.serialized, {
      ...(this.#programAllowlist === undefined ? {} : { programAllowlist: this.#programAllowlist }),
    });
    this.guarded.push(guard);
    if (this.guarded.length > GUARD_HISTORY) this.guarded.shift();
    if (guard.findings.length > 0) {
      const humanOnly = guard.findings.filter((finding) => finding.humanOnly);
      const reported = humanOnly.length > 0 ? humanOnly : guard.findings;
      throw new Error(`refusing to sign:\n  - ${reported.map((f) => f.detail).join("\n  - ")}`);
    }

    // The fee payer is static account key 0 in every Solana message, legacy or v0, and it is never
    // loaded from a lookup table — so unlike almost everything else about the accounts, this one can
    // be checked. It answers "is this a transaction from the account policy approved", which the
    // builder is a collaborator on rather than an authority for.
    const feePayer = guard.message.staticKeys[0];
    if (feePayer === undefined || feePayer !== approved.request.account) {
      throw new Error("refusing to sign: the transaction's fee payer is not the approved account");
    }

    const signature = await this.#api.sendSolanaTransaction({
      walletId: this.#walletId,
      caip2: SOLANA_CAIP2[this.#cluster],
      transaction: toBase64(tx.serialized),
      idempotencyKey: `anchor-${approved.approvalId}`,
    });

    return {
      approvalId: approved.approvalId,
      requestId: approved.request.id,
      transactionHash: signature,
      submittedAt: now,
      signer: `privy-solana:${this.#walletId}`,
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
  /**
   * The chain slug these limits describe — `ethereum`, `base`, `solana`.
   *
   * One Privy policy has one `chain_type`, and one wallet supports one policy, so a wallet and its
   * policy govern exactly one architecture. An Anchor setup that wants both EVM and Solana needs two
   * wallets, two policies, and two of these authorities. The audit says so rather than letting an
   * allowlist entry for the other chain quietly go unenforced.
   */
  readonly chain: string;
  readonly policyVersion?: string;
  readonly now?: () => number;
  /**
   * RPC methods to accept in the remote policy beyond the two Anchor sends for this architecture.
   *
   * A deliberate widening, in code, in a diff, with a reviewer — not a config toggle. Adding
   * `personal_sign` or `signMessage` here says "I have read what a signed order can do and I want it
   * anyway."
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
  const audit = auditRemotePolicy(policy, {
    limits: options.limits,
    chain: options.chain,
    ...(options.additionalAllowedMethods === undefined
      ? {}
      : { additionalAllowedMethods: options.additionalAllowedMethods }),
  });
  if (audit.findings.length > 0) throw new RemotePolicyRejected(audit);
  return { authority: new PrivyPolicyAuthority(options), audit };
}
