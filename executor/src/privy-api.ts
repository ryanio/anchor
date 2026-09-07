/**
 * A hand-rolled client for the parts of Privy's REST API that Anchor uses.
 *
 * Privy ship a Node SDK. This is not it, and that is deliberate: the repo has zero runtime
 * dependencies on purpose (AGENTS.md), and the three endpoints below need `fetch` and `node:crypto`
 * and nothing else. Privy's own docs use raw `fetch` for the endpoints their SDK has not caught up
 * with, so a hand-rolled client is not swimming against the current here.
 *
 * ## What was verified, and where
 *
 * Every shape in this file was read off Privy's published documentation (docs.privy.io, including
 * the machine-readable `llms-full.txt` corpus and the OpenAPI fragments embedded in each API
 * reference page) rather than inferred:
 *
 * - Base URL `https://api.privy.io`, version segment `v1`, and HTTP Basic auth with the app id as
 *   username and the app secret as password, *plus* a mandatory `privy-app-id` header — requests
 *   missing either are rejected by Privy's middleware.
 *   (`/api-reference/introduction`)
 * - `POST /v1/wallets/{wallet_id}/rpc` with `{ method, caip2, params: { transaction } }`, and the
 *   transaction hash at `data.hash` in the response.
 *   (`/api-reference/wallets/ethereum/eth-send-transaction`)
 * - `GET /v1/policies/{policy_id}` and `PATCH /v1/policies/{policy_id}` — PATCH, not PUT, and the
 *   patch body accepts only `name`, `rules`, `owner`, `owner_id`; `version` and `chain_type` are
 *   immutable. A policy has **no `default_action` field**: "if no rules resolve, the policy will
 *   default to DENY", and a method with no matching rule is denied.
 *   (`/api-reference/policies/update`, `/controls/policies/overview`)
 * - `privy-authorization-signature`: required only when the wallet or policy has an owner. ECDSA
 *   P-256 over SHA-256, signing an RFC 8785 (JCS) canonicalisation of
 *   `{ version: 1, method, url, body, headers }` where `headers` holds only the `privy-`-prefixed
 *   headers actually sent. Signature is DER, base64-encoded; several are comma-separated for a
 *   quorum. Dashboard keys arrive as `wallet-auth:<base64 PKCS#8 DER>`.
 *   (`/controls/authorization-keys/using-owners/sign/direct-implementation`)
 * - `privy-idempotency-key`, at most 256 characters. Same key with a *different* body is a 400, and
 *   for `/rpc` both 4xx and 5xx responses are cached for 24 hours — which is why nothing here
 *   retries a POST.
 *   (`/api-reference/idempotency-keys`)
 * - A policy refusal is HTTP 400 with error code `policy_violation`.
 *   (`/basics/troubleshooting/error-handling/api-errors`)
 *
 * ## What was *not* verified
 *
 * Privy publish no error-response schema — every API-reference page documents only the 200 — so the
 * exact JSON envelope of an error body is unconfirmed. {@link readErrorCode} therefore reads
 * defensively from several plausible shapes and treats "no recognisable code" as a plain API error
 * rather than guessing. Numeric rate limits are likewise undocumented; the only confirmed fact is
 * that exceeding them yields a 429.
 *
 * ## Errors never carry the credential
 *
 * Same rule as the data service's OpenSea client, for the same reason: errors reach logs, JSON
 * responses and pasted issue reports. Nothing here builds a message out of a value we did not
 * choose. A thrown `fetch` failure contributes its error *name* and an errno-shaped code and
 * nothing else — transport libraries habitually embed the whole request, headers included, in their
 * message text, and the app secret is a header. A response body contributes only an error code that
 * matched `^[a-z][a-z0-9_]{0,63}$`. There is no path from a credential to a message.
 */
import { createPrivateKey, type KeyObject, randomUUID, sign } from "node:crypto";

const BASE = "https://api.privy.io";
const REQUEST_TIMEOUT_MS = 20_000;

// --- Wire types --------------------------------------------------------------------------------

/**
 * One policy condition.
 *
 * `field_source` is a large enum on Privy's side; the two that matter to Anchor are
 * `ethereum_transaction` — whose `field` is exactly one of `to`, `value`, `chain_id` — and
 * `ethereum_calldata`, whose `field` is a function name or `function_name.param_name` and which
 * requires an `abi`. Typed loosely as `string` because this client *reads* policies written
 * elsewhere: a policy using a source Anchor has never heard of must still parse, so that the audit
 * in `privy.ts` can report it rather than crash on it.
 */
export interface PrivyPolicyCondition {
  readonly field_source: string;
  readonly field: string;
  readonly operator: string;
  /** Privy's OpenAPI types this as `string | string[]`. Numbers are sent as hex strings. */
  readonly value: string | readonly string[];
  readonly abi?: unknown;
}

export interface PrivyPolicyRule {
  readonly name: string;
  readonly method: string;
  readonly conditions: readonly PrivyPolicyCondition[];
  readonly action: "ALLOW" | "DENY";
}

/** A policy as Privy returns it. Note the absence of `default_action`: default-deny is implicit. */
export interface PrivyPolicyDocument {
  readonly id?: string;
  readonly version: string;
  readonly name: string;
  readonly chain_type: string;
  readonly rules: readonly PrivyPolicyRule[];
}

/** The transaction fields Anchor sets. Privy accepts more; nothing here needs them. */
export interface PrivyTransactionInput {
  readonly to: string;
  /** Hex quantity, e.g. `0x2386f26fc10000`. Privy compares policy values in base units. */
  readonly value: string;
  readonly data: string;
  readonly chain_id: number;
}

export interface SendTransactionArgs {
  readonly walletId: string;
  /** CAIP-2 chain id, e.g. `eip155:1`. Required by Privy for `eth_sendTransaction`. */
  readonly caip2: string;
  readonly transaction: PrivyTransactionInput;
  /** At most 256 characters. Omitted rather than empty when absent. */
  readonly idempotencyKey?: string;
}

export interface SendSolanaTransactionArgs {
  readonly walletId: string;
  /** CAIP-2 chain id, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  readonly caip2: string;
  /** The serialized transaction, base64. Privy's `params.transaction` with `encoding: "base64"`. */
  readonly transaction: string;
  readonly idempotencyKey?: string;
}

/**
 * The slice of Privy that Anchor depends on.
 *
 * An interface rather than the class, so `privy.ts` — where the policy and signing logic lives —
 * cannot reach the credential, the headers, or `fetch`. It is also the seam the test suite
 * substitutes, which is why no test in this workspace needs a Privy account or a network.
 */
export interface PrivyWalletApi {
  getPolicy(policyId: string): Promise<PrivyPolicyDocument>;
  /** Replace a policy's rules wholesale. An empty array is the kill-switch state: nothing resolves. */
  replacePolicyRules(args: { policyId: string; rules: readonly PrivyPolicyRule[] }): Promise<void>;
  /** Sign and broadcast an EVM transaction. Returns the transaction hash. */
  sendTransaction(args: SendTransactionArgs): Promise<string>;
  /** Sign and broadcast a Solana transaction. Returns the signature, base58. */
  sendSolanaTransaction(args: SendSolanaTransactionArgs): Promise<string>;
}

// --- Errors ------------------------------------------------------------------------------------

export class PrivyApiError extends Error {
  readonly status: number;
  /** Privy's machine-readable error code, when the response carried one we could recognise. */
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code === null ? `Privy API ${status}` : `Privy API ${status} (${code})`);
    this.name = "PrivyApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The one that matters: Privy's policy engine refused to sign.
 *
 * This is the enforcement point. Anchor's local mirror can be wrong, disabled, or replaced by an
 * attacker who owns the desktop; this refusal happens in Privy's infrastructure, against a policy
 * that only a human with dashboard access can widen.
 */
export class PrivyPolicyViolation extends PrivyApiError {
  constructor(status: number) {
    super(status, "policy_violation");
    this.name = "PrivyPolicyViolation";
    this.message = "Privy refused to sign: the request is outside the wallet's policy";
  }
}

/** Only codes shaped like an identifier are repeated. A remote string is not a format string. */
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** 64 bytes of base58 — the base58 alphabet, at the two lengths 64 bytes can encode to. */
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

function readErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const nested = record.error;
  const candidates = [
    record.code,
    record.error_code,
    typeof nested === "string" ? nested : undefined,
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>).code : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && CODE_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Describe a thrown fetch failure without repeating anything it said.
 *
 * Copied in spirit from `service/src/opensea.ts`. The underlying `message` is dropped on purpose:
 * it may quote the request, and the app secret is in a header.
 */
function describeNetworkFailure(err: unknown): string {
  const name = err instanceof Error && /^[A-Za-z]+$/.test(err.name) ? err.name : "Error";
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : null;
  if (name === "TimeoutError" || name === "AbortError") {
    return `Privy request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return code ? `Privy request failed (${name}: ${code})` : `Privy request failed (${name})`;
}

// --- RFC 8785 canonical JSON -------------------------------------------------------------------

/**
 * JSON Canonicalization Scheme, enough of it for an authorization payload.
 *
 * `JSON.stringify` is not a substitute: JCS requires object keys sorted by UTF-16 code unit, which
 * is what a default `Array.prototype.sort` on strings does, and `JSON.stringify` preserves
 * insertion order instead. Getting this wrong produces a signature Privy rejects with no useful
 * diagnostic, so it is worth the twenty lines.
 *
 * Scope: the payloads signed here contain strings, safe integers, booleans, arrays and plain
 * objects. Non-finite numbers throw rather than serialise to something JCS does not define.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

/**
 * Load a Privy authorization key.
 *
 * The dashboard issues these as `wallet-auth:<base64 PKCS#8 DER>`; a key generated with
 * `openssl ecparam -name prime256v1 -genkey` arrives as PEM. Both are accepted, because a user who
 * pasted the wrong one of the two should get a working client rather than a confusing error.
 */
export function loadAuthorizationKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("wallet-auth:") ? trimmed.slice("wallet-auth:".length) : trimmed;
  if (stripped.includes("-----BEGIN")) return createPrivateKey(stripped);
  const wrapped = stripped.replace(/\s+/g, "").replace(/(.{1,64})/g, "$1\n");
  return createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${wrapped}-----END PRIVATE KEY-----\n`);
}

interface SignaturePayload {
  readonly version: 1;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** Sign an authorization payload: P-256 over SHA-256, DER signature, base64-encoded. */
export function signAuthorizationPayload(key: KeyObject, payload: SignaturePayload): string {
  return sign("sha256", Buffer.from(canonicalize(payload), "utf8"), key).toString("base64");
}

// --- The client --------------------------------------------------------------------------------

export interface PrivyClientOptions {
  readonly appId: string;
  readonly appSecret: string;
  /**
   * PEM or `wallet-auth:`-prefixed P-256 key, when the wallet or policy has an owner. Omit when
   * neither does — Privy requires no signature in that case, and sending one is not an improvement.
   */
  readonly authorizationKey?: string;
  /** Seam for tests. Defaults to the global `fetch`; production never passes this. */
  readonly fetchImpl?: typeof fetch;
  /** Seam for tests: makes the idempotency key deterministic. */
  readonly newIdempotencyKey?: () => string;
}

export class PrivyClient implements PrivyWalletApi {
  readonly #appId: string;
  readonly #authorization: string;
  readonly #signingKey: KeyObject | null;
  readonly #fetch: typeof fetch;
  readonly #newIdempotencyKey: () => string;

  constructor(options: PrivyClientOptions) {
    this.#appId = options.appId;
    // Built once and never logged, never returned, never interpolated into a message.
    this.#authorization = `Basic ${Buffer.from(`${options.appId}:${options.appSecret}`).toString("base64")}`;
    this.#signingKey =
      options.authorizationKey === undefined ? null : loadAuthorizationKey(options.authorizationKey);
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#newIdempotencyKey = options.newIdempotencyKey ?? (() => randomUUID());
  }

  async getPolicy(policyId: string): Promise<PrivyPolicyDocument> {
    return (await this.#request("GET", `/v1/policies/${segment(policyId)}`)) as PrivyPolicyDocument;
  }

  async replacePolicyRules(args: { policyId: string; rules: readonly PrivyPolicyRule[] }): Promise<void> {
    await this.#request("PATCH", `/v1/policies/${segment(args.policyId)}`, { rules: args.rules });
  }

  async sendTransaction(args: SendTransactionArgs): Promise<string> {
    const body = {
      method: "eth_sendTransaction",
      caip2: args.caip2,
      params: { transaction: args.transaction },
    };
    // One key per call, reused across nothing: this client does not retry a POST, because Privy
    // caches 4xx and 5xx responses against an idempotency key for 24 hours, so a retry with the
    // same key replays the failure and a retry with a different key is a second transaction.
    const idempotencyKey = (args.idempotencyKey ?? this.#newIdempotencyKey()).slice(0, 256);
    const response = (await this.#request(
      "POST",
      `/v1/wallets/${segment(args.walletId)}/rpc`,
      body,
      idempotencyKey,
    )) as { data?: { hash?: unknown; user_operation_hash?: unknown } };

    const hash = response.data?.hash;
    if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash;
    // Sponsored transactions come back with an empty `hash` until confirmation; the user-operation
    // hash is the identifier that exists at that point. Anything else is a response we do not
    // understand, and claiming a submission succeeded on the strength of one would be a lie.
    const userOp = response.data?.user_operation_hash;
    if (typeof userOp === "string" && /^0x[0-9a-fA-F]{64}$/.test(userOp)) return userOp;
    throw new Error("Privy accepted the request but returned no transaction hash");
  }

  /**
   * Solana's `signAndSendTransaction`.
   *
   * Request: `{ method, caip2, params: { transaction, encoding } }`, transaction base64-encoded.
   * Response: the signature is at `data.hash` — the same field name as the EVM method, holding a
   * base58 signature rather than a `0x` hash, which is the sort of detail that is only obvious once
   * someone has read the page. Verified against Privy's API reference for `signAndSendTransaction`.
   *
   * The shape is checked rather than trusted: a Solana signature is 64 bytes of base58, 86 or 88
   * characters, so a truthy-but-wrong field cannot pass for one and be logged as a submission that
   * happened.
   */
  async sendSolanaTransaction(args: SendSolanaTransactionArgs): Promise<string> {
    const body = {
      method: "signAndSendTransaction",
      caip2: args.caip2,
      params: { transaction: args.transaction, encoding: "base64" },
    };
    const idempotencyKey = (args.idempotencyKey ?? this.#newIdempotencyKey()).slice(0, 256);
    const response = (await this.#request(
      "POST",
      `/v1/wallets/${segment(args.walletId)}/rpc`,
      body,
      idempotencyKey,
    )) as { data?: { hash?: unknown } };

    const hash = response.data?.hash;
    if (typeof hash === "string" && SOLANA_SIGNATURE_RE.test(hash)) return hash;
    throw new Error("Privy accepted the request but returned no Solana signature");
  }

  async #request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = `${BASE}${path}`;
    const privyHeaders: Record<string, string> = { "privy-app-id": this.#appId };
    if (idempotencyKey !== undefined) privyHeaders["privy-idempotency-key"] = idempotencyKey;

    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: this.#authorization,
      accept: "application/json",
    };

    // Sign the canonicalised body and send exactly that text, so the bytes Privy verifies are the
    // bytes Privy received. GET is never signed.
    let payload: string | undefined;
    if (body !== undefined) {
      payload = canonicalize(body);
      headers["content-type"] = "application/json";
    }
    if (this.#signingKey !== null && method !== "GET") {
      headers["privy-authorization-signature"] = signAuthorizationPayload(this.#signingKey, {
        version: 1,
        method,
        url,
        body: body ?? {},
        headers: privyHeaders,
      });
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(describeNetworkFailure(err));
    }

    if (!response.ok) {
      const code = readErrorCode(await readJson(response));
      if (code === "policy_violation") throw new PrivyPolicyViolation(response.status);
      throw new PrivyApiError(response.status, code);
    }
    return await readJson(response);
  }
}

/** A body we cannot parse is `null`, not a crash: an error path must not produce a second error. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Wallet and policy ids arrive from configuration. Encoded so a value containing `/` or `..` cannot
 * silently retarget the request at a different endpoint — the same reason the OpenSea client
 * encodes collection slugs.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

export { BASE as PRIVY_API_BASE, REQUEST_TIMEOUT_MS };
