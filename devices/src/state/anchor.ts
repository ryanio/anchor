/**
 * Read-only client for the local Anchor data service.
 *
 * The service binds loopback and refuses non-GET before routing (AGENTS.md invariant 4), so a device
 * can only ever read through it. That is the property that lets a piece of plastic on a desk talk to
 * it at all.
 *
 * **What is verified here and what is not.** The routes, the port default (8787) and the response
 * envelope — `{ data, meta: { fetchedAt, ageSeconds, stale } }` — are read from `service/src`, not
 * remembered. The *shape of `data`* is not: it comes from `@opensea/sdk`'s `getPortfolioStats`, and
 * confirming its field names needs a credentialed service running. So this module surfaces `meta`,
 * which it knows, and hands `data` back untouched as `unknown`. Nothing renders a field name that
 * has not been measured — AGENTS.md is emphatic that a plausible number taken for a true one has
 * already cost this project an afternoon.
 */

export interface Envelope {
  readonly data: unknown;
  readonly meta: { readonly fetchedAt: string; readonly ageSeconds: number; readonly stale: boolean };
}

export interface ServiceStatus {
  readonly reachable: boolean;
  /** Set when the service answered but the request itself failed, e.g. no wallet configured. */
  readonly detail: string;
  /** A wallet is configured. Without one the wallet routes answer 428, measured below. */
  readonly hasWallet: boolean;
  readonly primaryChain: string;
}

/**
 * The `/health` shape, measured against a running service rather than remembered:
 *
 *     { ok, wallets: [], wallet: null, chains: ["ethereum"], primaryChain: "ethereum",
 *       collections: [], tokens: [], credentials: { apiKey: true, pat: true } }
 *
 * Only the fields this panel renders are declared. The control for "the service is up" is a request
 * to a closed port, which returns no status at all — that is what distinguishes a real 200 here from
 * one this code merely assumed.
 */
interface Health {
  readonly ok?: boolean;
  readonly wallet?: string | null;
  readonly wallets?: readonly string[];
  readonly primaryChain?: string;
}

const DEFAULT_BASE = "http://127.0.0.1:8787";

export function baseUrl(): string {
  return process.env.ANCHOR_SERVICE_URL ?? DEFAULT_BASE;
}

async function get(path: string, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, { signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Is the service up? A failure here is ordinary — most users will not be running it. */
export async function status(timeoutMs = 1500): Promise<ServiceStatus> {
  const offline = { reachable: false, hasWallet: false, primaryChain: "" };
  const result = await get("/health", timeoutMs);
  if (result === null) return { ...offline, detail: "not running" };
  if (result.status !== 200) return { ...offline, detail: `health ${result.status}` };
  const health = (typeof result.body === "object" && result.body !== null ? result.body : {}) as Health;
  const hasWallet = typeof health.wallet === "string" && health.wallet !== "";
  return {
    reachable: true,
    detail: hasWallet ? "" : "no wallet",
    hasWallet,
    primaryChain: typeof health.primaryChain === "string" ? health.primaryChain : "",
  };
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const meta = (value as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  return typeof (meta as { ageSeconds?: unknown }).ageSeconds === "number";
}

/**
 * Fetch `/portfolio/value`. Returns the envelope, or null when the service is absent or refused.
 *
 * The caller gets `meta` to render provenance (`theme/README.md` principle 6: a number without
 * which wallets and how old is not checkable) and `data` as `unknown`.
 */
export async function portfolioValue(timeoutMs = 2500): Promise<Envelope | null> {
  // 428 is the service saying "no wallet configured" rather than a failure; measured against a
  // running service with `wallets: []`. Either way there is nothing to draw.
  const result = await get("/portfolio/value", timeoutMs);
  if (result === null || result.status !== 200) return null;
  return isEnvelope(result.body) ? result.body : null;
}

/** "12s ago", "4m ago" — provenance the panel can show next to a number. */
export function describeAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${Math.max(0, Math.round(ageSeconds))}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  return `${Math.round(ageSeconds / 3600)}h ago`;
}
