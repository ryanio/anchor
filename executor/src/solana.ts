/**
 * Reading a serialized Solana transaction, and refusing the ones that hand authority away.
 *
 * This is the Solana counterpart of `evm.ts`, and the differences matter more than the similarities.
 *
 * ## What a Solana transaction is, and why that is harder than calldata
 *
 * EVM calldata gives you a four-byte selector. `containsSetApprovalForAll` is a string comparison
 * against the first ten characters, and there is nothing else to know.
 *
 * A Solana transaction is a *message* with three moving parts:
 *
 * - an ordered array of **account keys** (32 bytes each),
 * - a list of **instructions**, each naming its program by an *index into that array*, plus more
 *   indices for its operands and an opaque `data` blob,
 * - in a **v0** (versioned) message, a list of **address table lookups**: references to on-chain
 *   *address lookup tables* (ALTs) whose entries are appended to the account array at execution
 *   time.
 *
 * That last part is the thing to understand before writing any guard. **An index in a v0 message
 * can refer to an account whose identity is not in the transaction.** The resolved account list is
 * `static keys ++ ALT writable ++ ALT readonly`, and the ALT halves come from accounts on chain
 * that this process has not read and that can be *extended between signing and execution*. So a
 * serialized v0 transaction does not, on its own, say who its instructions operate on.
 *
 * ## What this module can therefore verify, and what it cannot
 *
 * **Can, soundly, ALTs or not:**
 *
 * - The **program id of every instruction**, because a program id is read from the *static* key
 *   array. This module refuses outright — rather than assuming — when an instruction's program
 *   index falls outside the static keys, so it never has to be right about whether the runtime
 *   permits that.
 * - The **instruction data**, byte for byte, because it is inline in the message. For SPL Token and
 *   Token-2022 the first byte is the instruction tag, so `Approve` (4), `ApproveChecked` (13),
 *   `Revoke` (5) and `SetAuthority` (6) are as recognisable as an EVM selector; for the System
 *   Program the first four bytes are a little-endian discriminant, so `Assign` (1), `AssignWithSeed`
 *   (10) and `AuthorizeNonceAccount` (7) are too. Recognising any of them depends on resolving no
 *   account at all. **The human-only refusal is sound in the presence of lookup tables.** That is
 *   the one guarantee here worth relying on.
 * - The **static account keys** themselves, and how many operand slots resolve through an ALT.
 *
 * **Cannot, at all:**
 *
 * - **Who an instruction operates on, when its operands come from an ALT.** Not the recipient of a
 *   transfer, not the delegate of an approval, not the destination of a close. A withdrawal-
 *   destination allowlist cannot be enforced against an ALT-resolved account by reading bytes;
 *   it needs the table fetched from chain at the height the transaction will execute at, and even
 *   then it is a race. Anchor does not do this, and this module does not pretend to.
 * - **What a program will actually do.** An allowlisted program id is a statement about which code
 *   runs, not about what it does — and on Solana an upgradeable program's code can be replaced by
 *   its upgrade authority without the address changing (docs/chains.md). A program allowlist is a
 *   weaker guarantee than an immutable-contract allowlist, and calling it equivalent would be a lie.
 * - **Cross-program invocation.** A top-level instruction to an allowlisted program may invoke any
 *   other program from inside. Nothing in the serialized message shows that.
 *
 * ## So what is this for
 *
 * **A refusal filter, not a simulation.** It can prove a transaction contains something forbidden.
 * It can never prove a transaction is safe, and no caller should read a clean result as approval.
 * That is the same relationship `containsSetApprovalForAll` has to EVM calldata; it is only more
 * conspicuous here because there is more that cannot be checked.
 */
import { encodeSolanaAddress, type SolanaAddress, solanaAddress, solanaAddressBytes } from "./types.ts";

// --- Well-known program ids ----------------------------------------------------------------------

/**
 * Program ids Anchor recognises by name.
 *
 * These are public constants of the Solana ecosystem, not configuration. They are written as base58
 * and decoded at module load, so a typo is a startup crash rather than a program that silently never
 * matches — which for a *denylist* entry would be the dangerous direction of wrong.
 */
export const SYSTEM_PROGRAM = solanaAddress("11111111111111111111111111111111");
export const SPL_TOKEN_PROGRAM = solanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SPL_TOKEN_2022_PROGRAM = solanaAddress("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = solanaAddress("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const COMPUTE_BUDGET_PROGRAM = solanaAddress("ComputeBudget111111111111111111111111111111");
export const MEMO_PROGRAM = solanaAddress("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** The loader that owns upgradeable programs. Its `SetAuthority` and `Upgrade` replace live code. */
export const BPF_UPGRADEABLE_LOADER = solanaAddress("BPFLoaderUpgradeab1e11111111111111111111111");

/** The two token programs share an instruction encoding, so they share every check here. */
const TOKEN_PROGRAMS: readonly SolanaAddress[] = [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM];

/**
 * SPL Token instruction tags, as the first byte of `data`.
 *
 * Only the ones this module names are listed. The tag space is shared by Token-2022, which adds
 * further instructions above these and multiplexes extensions behind single tags — which is exactly
 * why the check below is an allowlist of tags rather than a denylist: an unrecognised tag on a token
 * program is refused, so a Token-2022 extension that hands authority away in a shape nobody here
 * anticipated is refused too.
 */
export const SPL_TOKEN_INSTRUCTION = {
  transfer: 3,
  approve: 4,
  revoke: 5,
  setAuthority: 6,
  mintTo: 7,
  burn: 8,
  closeAccount: 9,
  freezeAccount: 10,
  thawAccount: 11,
  transferChecked: 12,
  approveChecked: 13,
  burnChecked: 15,
  syncNative: 17,
} as const;

/**
 * The token-program instructions that delegate or reassign authority. Never signed, whatever else
 * the transaction is doing (docs/security.md; `HUMAN_ONLY_ACTION_KINDS` in types.ts).
 *
 * `revoke` is here for the same reason `setApprovalForAll(false)` is human-only: the refusal is
 * about the verb, because an agent that can toggle a delegation can toggle it on.
 */
const HUMAN_ONLY_TOKEN_TAGS: ReadonlyMap<number, string> = new Map([
  [SPL_TOKEN_INSTRUCTION.approve, "Approve — names a delegate over the token account's balance"],
  [SPL_TOKEN_INSTRUCTION.approveChecked, "ApproveChecked — names a delegate over the token account"],
  [SPL_TOKEN_INSTRUCTION.revoke, "Revoke — the other half of a delegation this agent may not make"],
  [SPL_TOKEN_INSTRUCTION.setAuthority, "SetAuthority — hands over the account or the mint outright"],
]);

/**
 * Token-program instructions an agent may sign, given everything else in the policy holds.
 *
 * Deliberately short. `mintTo`, `burn`, `freezeAccount` and `thawAccount` are absent because Anchor
 * has no action that needs them and a token program's *supply* controls are not a wallet's
 * business. `closeAccount` is present but separately guarded below — closing a wrapped-SOL account
 * moves its whole lamport balance to a destination the instruction names.
 */
const DELEGABLE_TOKEN_TAGS: ReadonlySet<number> = new Set([
  SPL_TOKEN_INSTRUCTION.transfer,
  SPL_TOKEN_INSTRUCTION.transferChecked,
  SPL_TOKEN_INSTRUCTION.closeAccount,
  SPL_TOKEN_INSTRUCTION.syncNative,
]);

/**
 * System Program instruction discriminants.
 *
 * Unlike SPL Token's single tag byte, these are **`u32` little-endian** — the System Program is a
 * bincode-encoded Rust enum, so `Assign` is `01 00 00 00` rather than `01`. Reading it as one byte
 * would classify `Assign` and a four-byte-truncated anything alike, which is the wrong direction of
 * wrong for a denial list.
 */
export const SYSTEM_INSTRUCTION = {
  createAccount: 0,
  assign: 1,
  transfer: 2,
  createAccountWithSeed: 3,
  advanceNonceAccount: 4,
  withdrawNonceAccount: 5,
  initializeNonceAccount: 6,
  authorizeNonceAccount: 7,
  allocate: 8,
  allocateWithSeed: 9,
  assignWithSeed: 10,
  transferWithSeed: 11,
  upgradeNonceAccount: 12,
} as const;

/**
 * System Program instructions that hand standing authority away. Never signed.
 *
 * **This is the class the SPL list alone misses, and it is the worst member of it.** A Privy wallet
 * account is an ordinary system-owned account, and `Assign` changes which *program owns it*. A
 * program that owns an account may debit its lamports with no signature from anyone — so one
 * `Assign` to an attacker's program converts the wallet's entire native balance into that program's
 * to spend, at a time it chooses. It passes every part of the membership test in
 * `HUMAN_ONLY_ACTION_KINDS`: no value moves in the transaction that does it, so no spend cap sees
 * it; the authority outlives the transaction; and taking it back requires the new owner program to
 * assign it back, which is not something anyone can guarantee. It is strictly worse than an SPL
 * delegate, which at least is bounded to one token account.
 *
 * `AssignWithSeed` is the same instruction reached through a derived address.
 *
 * `AuthorizeNonceAccount` hands over a durable nonce authority. A durable nonce is precisely the
 * mechanism that lets a signed transaction be held indefinitely and replayed at a moment of the
 * holder's choosing, so giving away the authority over one is giving away a standing capability —
 * the same shape, even though the immediate blast radius is smaller.
 */
const HUMAN_ONLY_SYSTEM_TAGS: ReadonlyMap<number, string> = new Map([
  [
    SYSTEM_INSTRUCTION.assign,
    "Assign — hands the account's owner program to someone else, and an owner program may debit " +
      "its lamports without a signature",
  ],
  [SYSTEM_INSTRUCTION.assignWithSeed, "AssignWithSeed — Assign, reached through a derived address"],
  [
    SYSTEM_INSTRUCTION.authorizeNonceAccount,
    "AuthorizeNonceAccount — hands over a durable nonce authority, the standing power to hold a " +
      "signed transaction and replay it later",
  ],
]);

/**
 * System Program instructions an agent may sign. As short as the token list, and for the reason.
 *
 * `Transfer` moves native SOL and is bounded by the spend caps, so it is delegable — but its
 * destination is an operand, which on a v0 message may be unreadable, so it is separately noted in
 * `unverified` exactly as `closeAccount` is. `CreateAccount` and `CreateAccountWithSeed` name an
 * owner program too, but for an account that does not exist yet and holds only the lamports this
 * transaction funds it with; that is bounded value movement, not a handover of something the wallet
 * already had. Everything else — the nonce lifecycle, `Allocate*`, `WithdrawNonceAccount` — is
 * absent because Anchor sends none of it, and an unrecognised discriminant is refused rather than
 * assumed inert.
 */
const DELEGABLE_SYSTEM_TAGS: ReadonlySet<number> = new Set([
  SYSTEM_INSTRUCTION.createAccount,
  SYSTEM_INSTRUCTION.createAccountWithSeed,
  SYSTEM_INSTRUCTION.transfer,
]);

/**
 * Programs an instruction may name by default.
 *
 * Being on this list is *permission to be inspected*, not permission to run — the System and token
 * programs are both here and both have their instructions classified below, because each of them
 * can hand an account away. Only Compute Budget, Memo and the Associated Token program are on it
 * unconditionally, and those three genuinely cannot: they set a fee limit, write a note, and create
 * an account at a derived address the caller does not choose.
 */
const DEFAULT_PROGRAM_ALLOWLIST: readonly SolanaAddress[] = [
  SYSTEM_PROGRAM,
  SPL_TOKEN_PROGRAM,
  SPL_TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
];

// --- Parsing ---------------------------------------------------------------------------------

export class MalformedTransaction extends Error {
  constructor(detail: string) {
    super(`not a Solana transaction: ${detail}`);
    this.name = "MalformedTransaction";
  }
}

/**
 * A cursor over the wire format, with every read bounds-checked.
 *
 * Written as a class so no read can forget to advance or forget to check. Every overrun is a throw:
 * a truncated transaction is malformed input, and guessing at the missing bytes is how a parser
 * ends up disagreeing with the runtime about what it just approved.
 */
class Reader {
  readonly #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get exhausted(): boolean {
    return this.#at >= this.#bytes.length;
  }

  get remaining(): number {
    return this.#bytes.length - this.#at;
  }

  u8(): number {
    if (this.#at >= this.#bytes.length) throw new MalformedTransaction("ran out of bytes");
    const value = this.#bytes[this.#at] ?? 0;
    this.#at += 1;
    return value;
  }

  peek(): number {
    if (this.#at >= this.#bytes.length) throw new MalformedTransaction("ran out of bytes");
    return this.#bytes[this.#at] ?? 0;
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.#at + length > this.#bytes.length) {
      throw new MalformedTransaction(`wanted ${length} bytes, ${this.remaining} left`);
    }
    const slice = this.#bytes.subarray(this.#at, this.#at + length);
    this.#at += length;
    return slice;
  }

  /**
   * `compact-u16` (Solana's "short vec" length prefix): up to three bytes, seven bits each,
   * little-endian, high bit set to continue.
   *
   * The encoding is *not* canonical by construction, so a length can be written several ways —
   * `0x80 0x00` is a zero with a redundant continuation byte. Non-canonical encodings are rejected
   * rather than accepted, because a parser that accepts two spellings of one length is a parser that
   * can be made to disagree with another parser about where an instruction starts.
   */
  compactU16(): number {
    let value = 0;
    for (let shift = 0; shift <= 14; shift += 7) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (shift > 0 && (byte & 0x7f) === 0) {
          throw new MalformedTransaction("non-canonical compact-u16 length");
        }
        if (value > 0xffff) throw new MalformedTransaction("compact-u16 out of range");
        return value;
      }
    }
    throw new MalformedTransaction("compact-u16 longer than three bytes");
  }
}

/** One instruction, as it appears in the message. Operand indices are left unresolved on purpose. */
export interface SolanaInstruction {
  /** Read from the static account keys. See the header for why it is never an ALT entry here. */
  readonly programId: SolanaAddress;
  /** Indices into the *resolved* account list, which this module does not construct. */
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

/** One address lookup table this message draws accounts from. */
export interface SolanaAddressTableLookup {
  readonly table: SolanaAddress;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

export interface SolanaMessage {
  /** `"legacy"`, or the version number of a versioned message. Anchor understands v0. */
  readonly version: "legacy" | 0;
  readonly numRequiredSignatures: number;
  readonly staticKeys: readonly SolanaAddress[];
  readonly recentBlockhash: SolanaAddress;
  readonly instructions: readonly SolanaInstruction[];
  readonly lookups: readonly SolanaAddressTableLookup[];
  /**
   * How many account slots this message draws from lookup tables.
   *
   * Not a curiosity: it is the size of what cannot be read from these bytes. Zero means the
   * resolved account list *is* the static list and an account-level check would be possible;
   * anything else means it is not.
   */
  readonly lookupAccountCount: number;
}

function readIndexes(reader: Reader): number[] {
  const count = reader.compactU16();
  const indexes: number[] = [];
  for (let i = 0; i < count; i++) indexes.push(reader.u8());
  return indexes;
}

/**
 * Parse a serialized transaction — signatures and all — into its message.
 *
 * Signatures are counted and skipped, never verified: verification would need the message hash and
 * ed25519, and it would answer a question nobody here is asking. Anchor never receives a signed
 * transaction it is meant to trust; Privy signs, inside an enclave, after its own policy check.
 */
export function parseSolanaTransaction(raw: Uint8Array): SolanaMessage {
  const reader = new Reader(raw);
  const signatureCount = reader.compactU16();
  reader.take(signatureCount * 64);
  return readMessage(reader, signatureCount);
}

/** Parse a bare message, with no signature prefix. */
export function parseSolanaMessage(raw: Uint8Array): SolanaMessage {
  return readMessage(new Reader(raw), null);
}

function readMessage(reader: Reader, signatureCount: number | null): SolanaMessage {
  // The version prefix is a byte with the high bit set; a legacy message starts straight into the
  // header, whose first byte is a signature count and so is always < 128.
  let version: "legacy" | 0 = "legacy";
  if ((reader.peek() & 0x80) !== 0) {
    const encoded = reader.u8() & 0x7f;
    if (encoded !== 0) throw new MalformedTransaction(`unsupported message version ${encoded}`);
    version = 0;
  }

  const numRequiredSignatures = reader.u8();
  reader.u8(); // readonly signed accounts
  reader.u8(); // readonly unsigned accounts

  if (signatureCount !== null && signatureCount !== numRequiredSignatures) {
    throw new MalformedTransaction(
      `${signatureCount} signature slots for a message requiring ${numRequiredSignatures}`,
    );
  }

  const keyCount = reader.compactU16();
  const staticKeys: SolanaAddress[] = [];
  for (let i = 0; i < keyCount; i++) staticKeys.push(encodeSolanaAddress(reader.take(32)));

  const recentBlockhash = encodeSolanaAddress(reader.take(32));

  const instructionCount = reader.compactU16();
  const instructions: SolanaInstruction[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIndex = reader.u8();
    const programId = staticKeys[programIndex];
    if (programId === undefined) {
      // Refuse rather than resolve. A program index outside the static keys would have to be looked
      // up in a table this process has not read, and an unreadable program id is the one thing this
      // module must never wave through — every check below is keyed on it.
      throw new MalformedTransaction(
        `instruction ${i} names its program by index ${programIndex}, which is not a static ` +
          "account key — its identity is not in this transaction and cannot be checked",
      );
    }
    const accountIndexes = readIndexes(reader);
    const data = reader.take(reader.compactU16());
    instructions.push({ programId, accountIndexes, data: Uint8Array.from(data) });
  }

  const lookups: SolanaAddressTableLookup[] = [];
  let lookupAccountCount = 0;
  if (version === 0) {
    const lookupCount = reader.compactU16();
    for (let i = 0; i < lookupCount; i++) {
      const table = encodeSolanaAddress(reader.take(32));
      const writableIndexes = readIndexes(reader);
      const readonlyIndexes = readIndexes(reader);
      lookupAccountCount += writableIndexes.length + readonlyIndexes.length;
      lookups.push({ table, writableIndexes, readonlyIndexes });
    }
  }

  if (!reader.exhausted) {
    throw new MalformedTransaction(`${reader.remaining} trailing bytes after the message`);
  }

  return {
    version,
    numRequiredSignatures,
    staticKeys,
    recentBlockhash,
    instructions,
    lookups,
    lookupAccountCount,
  };
}

// --- The guard -------------------------------------------------------------------------------

/** One reason a transaction is refused. `humanOnly` gets its own `DenyReason` upstream. */
export interface TransactionFinding {
  readonly humanOnly: boolean;
  readonly detail: string;
}

export interface TransactionGuardResult {
  readonly message: SolanaMessage;
  /** Non-empty means refuse. A finding is never advisory. */
  readonly findings: readonly TransactionFinding[];
  /**
   * What this pass could not establish, stated rather than quietly assumed.
   *
   * A clean `findings` with a non-empty `unverified` is the normal outcome for a real swap, and it
   * means "nothing forbidden was found in the parts that can be read" — not "this is safe".
   */
  readonly unverified: readonly string[];
}

export interface TransactionGuardOptions {
  /**
   * Program ids an instruction may invoke. Default-deny, because anything can deploy a program and
   * an unrecognised one is unbounded by construction (docs/tokens.md: "tokens are permissionless,
   * so allowlists invert").
   */
  readonly programAllowlist?: readonly SolanaAddress[];
}

function isTokenProgram(programId: SolanaAddress): boolean {
  return TOKEN_PROGRAMS.includes(programId);
}

/**
 * The System Program's `u32` little-endian discriminant, or `null` when the data is too short.
 *
 * Read as an unsigned 32-bit value rather than assembled with `|`, which would sign-extend anything
 * with the high bit set and turn a large discriminant negative — a negative number matches no entry
 * in either list, so it would land in the "unrecognised" branch by accident rather than by rule.
 */
function readSystemTag(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

/**
 * Inspect a serialized transaction and report every reason to refuse it.
 *
 * Read the module header before relying on this. In one sentence: it reads program ids and
 * instruction *data*, both of which are inline and unaffected by address lookup tables, and it
 * reads nothing about *which accounts* an instruction touches, because in a v0 message that is not
 * in the transaction.
 */
export function guardSolanaTransaction(
  raw: Uint8Array,
  options: TransactionGuardOptions = {},
): TransactionGuardResult {
  const message = parseSolanaTransaction(raw);
  return guardSolanaMessage(message, options);
}

export function guardSolanaMessage(
  message: SolanaMessage,
  options: TransactionGuardOptions = {},
): TransactionGuardResult {
  const allowlist = options.programAllowlist ?? DEFAULT_PROGRAM_ALLOWLIST;
  const findings: TransactionFinding[] = [];
  const unverified: string[] = [];

  message.instructions.forEach((instruction, index) => {
    const at = `instruction ${index}`;
    const program = instruction.programId;

    // The loader is checked ahead of the allowlist so that putting it on one by mistake still does
    // not get you a program upgrade. Replacing a program's code is `set-authority` by another route.
    if (program === BPF_UPGRADEABLE_LOADER) {
      findings.push({
        humanOnly: true,
        detail:
          `${at} invokes the BPF upgradeable loader, which upgrades program code or reassigns an ` +
          "upgrade authority. A program that can be replaced is not a program that was audited.",
      });
      return;
    }

    if (!allowlist.includes(program)) {
      findings.push({
        humanOnly: false,
        detail:
          `${at} invokes ${program}, which is not on the program allowlist. Anything can deploy a ` +
          "Solana program, so an unrecognised one is refused rather than inspected.",
      });
      return;
    }

    if (program === SYSTEM_PROGRAM) {
      const tag = readSystemTag(instruction.data);
      if (tag === null) {
        findings.push({
          humanOnly: false,
          detail: `${at} is a System Program instruction with no four-byte discriminant`,
        });
        return;
      }
      const humanOnly = HUMAN_ONLY_SYSTEM_TAGS.get(tag);
      if (humanOnly !== undefined) {
        findings.push({
          humanOnly: true,
          detail:
            `${at} is System ${humanOnly}. This is a human-only action class: it moves no value, ` +
            "so no spend cap can see it, and the authority it grants outlives the transaction.",
        });
        return;
      }
      if (!DELEGABLE_SYSTEM_TAGS.has(tag)) {
        findings.push({
          humanOnly: false,
          detail:
            `${at} is System Program instruction ${tag}, which Anchor does not recognise as one an ` +
            "agent sends. An unknown discriminant is refused rather than assumed inert.",
        });
        return;
      }
      if (tag === SYSTEM_INSTRUCTION.transfer) {
        // Same shape as closeAccount: bounded by the spend caps, but paid to an account named by
        // index, which a v0 message may resolve through a table these bytes do not contain.
        unverified.push(
          `${at} transfers native SOL to an account named by index; the destination is not checked ` +
            "here, and the withdrawal allowlist is enforced against the request upstream instead",
        );
      }
      return;
    }

    if (!isTokenProgram(program)) return;

    if (instruction.data.length === 0) {
      findings.push({ humanOnly: false, detail: `${at} is a token instruction with no tag byte` });
      return;
    }

    const tag = instruction.data[0] ?? 0;
    const humanOnly = HUMAN_ONLY_TOKEN_TAGS.get(tag);
    if (humanOnly !== undefined) {
      findings.push({
        humanOnly: true,
        detail:
          `${at} is SPL ${humanOnly}. This is a human-only action class: it moves no value, so no ` +
          "spend cap can see it, and the authority it grants outlives the transaction.",
      });
      return;
    }

    if (!DELEGABLE_TOKEN_TAGS.has(tag)) {
      findings.push({
        humanOnly: false,
        detail:
          `${at} is token instruction tag ${tag}, which Anchor does not recognise as one an agent ` +
          "sends. Token-2022 multiplexes extensions behind tags this list does not enumerate, so " +
          "an unknown tag is refused rather than assumed inert.",
      });
      return;
    }

    if (tag === SPL_TOKEN_INSTRUCTION.closeAccount) {
      // Not human-only: it is a transfer wearing a different hat (see HUMAN_ONLY_ACTION_KINDS).
      // But its destination is an operand, so on a v0 message it may be unreadable — and closing a
      // wrapped-SOL account sends the entire lamport balance there.
      unverified.push(
        `${at} closes a token account and sends its lamports to an account named by index; for a ` +
          "wrapped-SOL account that is the whole balance, and the destination is not checked here",
      );
    }
  });

  if (message.lookups.length > 0) {
    unverified.push(
      `${message.lookupAccountCount} account slot(s) resolve through ${message.lookups.length} ` +
        "address lookup table(s). Which accounts those indices name is on chain, not in this " +
        "transaction, and a table can be extended between signing and execution — so no " +
        "destination, recipient or delegate operand in this message has been checked. Program ids " +
        "and instruction data were, and are unaffected.",
    );
  }

  unverified.push(
    "an allowlisted program id says which code runs, not what it does: a Solana program deployed " +
      "with an upgrade authority can be replaced without its address changing, and a top-level " +
      "instruction may invoke any other program from inside via CPI",
  );

  return { message, findings, unverified };
}

/** True when a transaction contains an instruction that is never delegated. The Solana `containsSetApprovalForAll`. */
export function containsHumanOnlyInstruction(raw: Uint8Array): boolean {
  try {
    return guardSolanaTransaction(raw).findings.some((finding) => finding.humanOnly);
  } catch {
    // A transaction that cannot be parsed cannot be cleared either. Fail closed.
    return true;
  }
}

/** Base64, for the `params.transaction` Privy expects. `node:buffer` only — no dependency. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new MalformedTransaction("not base64");
  return new Uint8Array(Buffer.from(text, "base64"));
}

/**
 * CAIP-2 chain identifiers for Solana, as Privy's `signAndSendTransaction` documents them.
 *
 * Solana's CAIP-2 reference is the first 32 characters of the genesis hash, so these are opaque
 * constants rather than anything derivable. Verified against Privy's API reference for
 * `signAndSendTransaction`; see `executor/README.md`.
 */
export const SOLANA_CAIP2 = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const;

export type SolanaCluster = keyof typeof SOLANA_CAIP2;

export { DEFAULT_PROGRAM_ALLOWLIST, solanaAddressBytes };
