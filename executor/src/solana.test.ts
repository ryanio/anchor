/**
 * The Solana transaction guard, tested as the two promises it actually makes:
 *
 *   1. **It refuses a delegation.** An SPL `Approve`, `ApproveChecked`, `Revoke` or `SetAuthority`
 *      is caught whatever else the transaction is doing — and, crucially, *whether or not* the
 *      transaction uses address lookup tables, because the check reads instruction data rather than
 *      resolved accounts.
 *   2. **It is honest about the rest.** A transaction with lookup tables reports that its operand
 *      accounts were not checked, and a clean result never claims to be an approval.
 *
 * Everything here builds its own bytes. There is no fixture transaction and no captured mainnet
 * payload, so a test that passes is a statement about the parser rather than about one lucky sample.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BPF_UPGRADEABLE_LOADER,
  COMPUTE_BUDGET_PROGRAM,
  containsHumanOnlyInstruction,
  fromBase64,
  guardSolanaTransaction,
  MalformedTransaction,
  parseSolanaTransaction,
  SOLANA_CAIP2,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_INSTRUCTION,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  toBase64,
} from "./solana.ts";
import { encodeSolanaAddress, type SolanaAddress, solanaAddress, solanaAddressBytes } from "./types.ts";

// --- Building a transaction to inspect ---------------------------------------------------------

function compactU16(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    if (rest < 0x80) {
      out.push(rest);
      return out;
    }
    out.push((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
}

interface RawInstruction {
  readonly programIndex: number;
  readonly accounts?: readonly number[];
  readonly data: readonly number[];
}

interface RawLookup {
  readonly table: SolanaAddress;
  readonly writable: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

/** Serialize a transaction the way the runtime does, so the parser is tested against the format. */
function serialize(options: {
  version?: "legacy" | 0;
  signatures?: number;
  keys: readonly SolanaAddress[];
  instructions: readonly RawInstruction[];
  lookups?: readonly RawLookup[];
  trailing?: readonly number[];
}): Uint8Array {
  const version = options.version ?? 0;
  const signatures = options.signatures ?? 1;
  const bytes: number[] = [];

  bytes.push(...compactU16(signatures));
  for (let i = 0; i < signatures; i++) bytes.push(...new Array<number>(64).fill(0));

  if (version === 0) bytes.push(0x80);
  bytes.push(signatures, 0, 1); // header
  bytes.push(...compactU16(options.keys.length));
  for (const key of options.keys) bytes.push(...solanaAddressBytes(key));
  bytes.push(...new Array<number>(32).fill(7)); // recent blockhash

  bytes.push(...compactU16(options.instructions.length));
  for (const instruction of options.instructions) {
    bytes.push(instruction.programIndex);
    const accounts = instruction.accounts ?? [];
    bytes.push(...compactU16(accounts.length), ...accounts);
    bytes.push(...compactU16(instruction.data.length), ...instruction.data);
  }

  if (version === 0) {
    const lookups = options.lookups ?? [];
    bytes.push(...compactU16(lookups.length));
    for (const lookup of lookups) {
      bytes.push(...solanaAddressBytes(lookup.table));
      bytes.push(...compactU16(lookup.writable.length), ...lookup.writable);
      bytes.push(...compactU16(lookup.readonlyIndexes.length), ...lookup.readonlyIndexes);
    }
  }

  bytes.push(...(options.trailing ?? []));
  return Uint8Array.from(bytes);
}

const WALLET = solanaAddress("7ZLB8aQLp4Jyvq1EwuJMBxiMpPkxZMvN9KqL3uwpT1gN");
const MINT = solanaAddress("7ZLB8aQLp4PpY25QLqUc49fLA2TqyauvYQqdmST5ciMg");
const TABLE = solanaAddress("7ZLB8aQLp4QeDGDiCYsxV9T5q5JmVdVt4VC3SM9idxre");
const DELEGATE = solanaAddress("7ZLB8aQLp4LC8Q3Z1P7kZwz5XzNYhyGDUoZnTfWYrom4");

/** A plain SPL `TransferChecked` — the shape a legitimate withdrawal has. */
function transferChecked(over: Partial<Parameters<typeof serialize>[0]> = {}): Uint8Array {
  return serialize({
    keys: [WALLET, MINT, SPL_TOKEN_PROGRAM],
    instructions: [
      { programIndex: 2, accounts: [0, 1], data: [SPL_TOKEN_INSTRUCTION.transferChecked, 1, 0, 0, 0] },
    ],
    ...over,
  });
}

// --- Base58 round-trip -------------------------------------------------------------------------

describe("addresses survive the round trip", () => {
  test("the all-zero key encodes to the System Program id", () => {
    // A free check on the encoder: the System Program is 32 zero bytes, and its base58 spelling is
    // one of the most widely known constants there is. If this drifts, everything else is suspect.
    assert.equal(encodeSolanaAddress(new Uint8Array(32)), SYSTEM_PROGRAM);
  });

  test("every well-known program id decodes to 32 bytes and re-encodes unchanged", () => {
    for (const program of [
      SYSTEM_PROGRAM,
      SPL_TOKEN_PROGRAM,
      SPL_TOKEN_2022_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      BPF_UPGRADEABLE_LOADER,
    ]) {
      const bytes = solanaAddressBytes(program);
      assert.equal(bytes.length, 32);
      assert.equal(encodeSolanaAddress(bytes), program);
    }
  });

  test("base64 round-trips, and a non-base64 string is refused rather than coerced", () => {
    const bytes = transferChecked();
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
    assert.throws(() => fromBase64("not base64!"), MalformedTransaction);
  });
});

// --- Parsing -----------------------------------------------------------------------------------

describe("parsing a message", () => {
  test("reads a legacy transaction", () => {
    const message = parseSolanaTransaction(transferChecked({ version: "legacy" }));
    assert.equal(message.version, "legacy");
    assert.deepEqual([...message.staticKeys], [WALLET, MINT, SPL_TOKEN_PROGRAM]);
    assert.equal(message.instructions.length, 1);
    assert.equal(message.instructions[0]?.programId, SPL_TOKEN_PROGRAM);
    assert.equal(message.lookupAccountCount, 0);
  });

  test("reads a v0 transaction and counts what its lookup tables contribute", () => {
    const message = parseSolanaTransaction(
      transferChecked({ lookups: [{ table: TABLE, writable: [4, 9], readonlyIndexes: [11] }] }),
    );
    assert.equal(message.version, 0);
    assert.equal(message.lookups.length, 1);
    assert.equal(message.lookups[0]?.table, TABLE);
    // Three account slots this transaction does not name. That number is the size of what cannot
    // be checked from these bytes, which is why the parser reports it rather than discarding it.
    assert.equal(message.lookupAccountCount, 3);
  });

  test("refuses a program id that is not a static account key", () => {
    // The identity of such a program is on chain, not in the transaction. Every check in the guard
    // is keyed on the program id, so an unreadable one has to be a refusal, never a resolution.
    assert.throws(
      () =>
        parseSolanaTransaction(serialize({ keys: [WALLET], instructions: [{ programIndex: 5, data: [3] }] })),
      /not a static account key/,
    );
  });

  test("refuses a truncated transaction rather than guessing at the missing bytes", () => {
    const full = transferChecked();
    assert.throws(() => parseSolanaTransaction(full.subarray(0, full.length - 4)), MalformedTransaction);
  });

  test("refuses trailing bytes after the message", () => {
    assert.throws(() => parseSolanaTransaction(transferChecked({ trailing: [1, 2, 3] })), /trailing/);
  });

  test("refuses a non-canonical compact-u16 length", () => {
    // `0x80 0x00` is a zero written with a redundant continuation byte. Accepting two spellings of
    // one length is how two parsers end up disagreeing about where an instruction starts.
    const bytes = [...transferChecked()];
    assert.throws(
      () => parseSolanaTransaction(Uint8Array.from([0x80, 0x00, ...bytes.slice(1)])),
      MalformedTransaction,
    );
  });

  test("refuses a message version it does not understand", () => {
    const bytes = [...transferChecked()];
    bytes[65] = 0x81; // v1, which does not exist yet
    assert.throws(() => parseSolanaTransaction(Uint8Array.from(bytes)), /unsupported message version/);
  });
});

// --- The human-only refusal --------------------------------------------------------------------

describe("SPL delegation and authority transfer are refused", () => {
  const humanOnly = [
    ["Approve", SPL_TOKEN_INSTRUCTION.approve],
    ["ApproveChecked", SPL_TOKEN_INSTRUCTION.approveChecked],
    ["Revoke", SPL_TOKEN_INSTRUCTION.revoke],
    ["SetAuthority", SPL_TOKEN_INSTRUCTION.setAuthority],
  ] as const;

  for (const [name, tag] of humanOnly) {
    test(`${name} is a human-only finding`, () => {
      const guard = guardSolanaTransaction(
        serialize({
          keys: [WALLET, MINT, DELEGATE, SPL_TOKEN_PROGRAM],
          instructions: [{ programIndex: 3, accounts: [0, 1, 2], data: [tag, 255, 255, 255, 255] }],
        }),
      );
      assert.equal(guard.findings.length, 1);
      assert.equal(guard.findings[0]?.humanOnly, true);
      assert.match(guard.findings[0]?.detail ?? "", new RegExp(name));
    });
  }

  test("Token-2022 gets the same treatment as SPL Token", () => {
    const guard = guardSolanaTransaction(
      serialize({
        keys: [WALLET, SPL_TOKEN_2022_PROGRAM],
        instructions: [{ programIndex: 1, data: [SPL_TOKEN_INSTRUCTION.setAuthority] }],
      }),
    );
    assert.ok(guard.findings.some((finding) => finding.humanOnly));
  });

  test("a delegation hidden behind a legitimate transfer is still caught", () => {
    // The shape the attack takes: the transaction does the thing it was asked to do, and one more.
    const guard = guardSolanaTransaction(
      serialize({
        keys: [WALLET, MINT, DELEGATE, SPL_TOKEN_PROGRAM],
        instructions: [
          { programIndex: 3, accounts: [0, 1], data: [SPL_TOKEN_INSTRUCTION.transferChecked, 1] },
          { programIndex: 3, accounts: [0, 2], data: [SPL_TOKEN_INSTRUCTION.approve, 255] },
        ],
      }),
    );
    assert.ok(guard.findings.some((finding) => finding.humanOnly));
    assert.match(guard.findings[0]?.detail ?? "", /instruction 1/);
  });

  test("an address lookup table does not hide it — the check reads instruction data, not accounts", () => {
    // This is the load-bearing property of the whole module. An ALT changes what an account *index*
    // refers to; it cannot change the instruction's own data bytes, and the tag is the first of them.
    const withTables = serialize({
      keys: [WALLET, SPL_TOKEN_PROGRAM],
      instructions: [{ programIndex: 1, accounts: [200, 201], data: [SPL_TOKEN_INSTRUCTION.approve, 9] }],
      lookups: [{ table: TABLE, writable: [1, 2, 3], readonlyIndexes: [4] }],
    });
    const guard = guardSolanaTransaction(withTables);
    assert.ok(guard.findings.some((finding) => finding.humanOnly));
    assert.equal(containsHumanOnlyInstruction(withTables), true);
  });

  test("the BPF upgradeable loader is refused, even if someone allowlists it", () => {
    const guard = guardSolanaTransaction(
      serialize({
        keys: [WALLET, BPF_UPGRADEABLE_LOADER],
        instructions: [{ programIndex: 1, data: [4] }],
      }),
      { programAllowlist: [BPF_UPGRADEABLE_LOADER] },
    );
    assert.ok(guard.findings.some((finding) => finding.humanOnly));
    assert.match(guard.findings[0]?.detail ?? "", /upgradeable loader/);
  });

  test("a transaction that cannot be parsed is treated as containing one", () => {
    // Fail closed: "I could not read it" and "it is clean" must never be the same answer.
    assert.equal(containsHumanOnlyInstruction(Uint8Array.from([0, 1, 2])), true);
  });
});

// --- Default-deny ------------------------------------------------------------------------------

describe("unknown programs and unknown instructions are refused", () => {
  test("a program that is not allowlisted is refused rather than inspected", () => {
    const stranger = solanaAddress("7ZLB8aQLp4K1V4ns5b3yRm1YqdMVEMh73AotTsfsnQPC");
    const guard = guardSolanaTransaction(
      serialize({ keys: [WALLET, stranger], instructions: [{ programIndex: 1, data: [0] }] }),
    );
    assert.equal(guard.findings.length, 1);
    assert.equal(guard.findings[0]?.humanOnly, false);
    assert.match(guard.findings[0]?.detail ?? "", /not on the program allowlist/);
  });

  test("an unrecognised token instruction tag is refused, not assumed inert", () => {
    // Token-2022 multiplexes extensions behind tags this module does not enumerate. A denylist of
    // the three known-bad tags would wave those through; an allowlist of the four known-good ones
    // does not.
    const guard = guardSolanaTransaction(
      serialize({
        keys: [WALLET, SPL_TOKEN_2022_PROGRAM],
        instructions: [{ programIndex: 1, data: [38, 0, 0] }],
      }),
    );
    assert.equal(guard.findings.length, 1);
    assert.match(guard.findings[0]?.detail ?? "", /tag 38/);
  });

  test("a token instruction with no tag byte at all is refused", () => {
    const guard = guardSolanaTransaction(
      serialize({ keys: [WALLET, SPL_TOKEN_PROGRAM], instructions: [{ programIndex: 1, data: [] }] }),
    );
    assert.match(guard.findings[0]?.detail ?? "", /no tag byte/);
  });

  test("a plain TransferChecked through allowlisted programs produces no findings", () => {
    const guard = guardSolanaTransaction(transferChecked());
    assert.deepEqual(guard.findings, []);
  });
});

// --- Honesty ------------------------------------------------------------------------------------

describe("the guard says what it could not check", () => {
  test("a clean result still reports that a program id is not a promise about behaviour", () => {
    const guard = guardSolanaTransaction(transferChecked());
    assert.deepEqual(guard.findings, []);
    // An empty `findings` is "nothing forbidden was found", never "this is safe".
    assert.ok(guard.unverified.some((u) => /upgrade authority/.test(u)));
    assert.ok(guard.unverified.some((u) => /CPI/.test(u)));
  });

  test("a lookup table makes the unchecked operands explicit", () => {
    const guard = guardSolanaTransaction(
      transferChecked({ lookups: [{ table: TABLE, writable: [1], readonlyIndexes: [2] }] }),
    );
    assert.deepEqual(guard.findings, []);
    const note = guard.unverified.find((u) => /address lookup table/.test(u));
    assert.ok(note, "a transaction with an ALT must say its operands were not checked");
    assert.match(note, /2 account slot/);
    assert.match(note, /no destination, recipient or delegate operand in this message has been checked/);
  });

  test("closing an account is allowed but flagged, because it moves value that looks like rent", () => {
    // Not human-only: it is a transfer wearing a different hat. But a wrapped-SOL close sends the
    // whole balance to a destination that is an operand, so the guard cannot vouch for it.
    const guard = guardSolanaTransaction(
      serialize({
        keys: [WALLET, SPL_TOKEN_PROGRAM],
        instructions: [{ programIndex: 1, accounts: [0], data: [SPL_TOKEN_INSTRUCTION.closeAccount] }],
      }),
    );
    assert.deepEqual(guard.findings, []);
    assert.ok(guard.unverified.some((u) => /wrapped-SOL/.test(u)));
  });
});

describe("CAIP-2 identifiers", () => {
  test("mainnet is the documented Privy value, and the clusters are distinct", () => {
    assert.equal(SOLANA_CAIP2.mainnet, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(new Set(Object.values(SOLANA_CAIP2)).size, 3);
  });
});
