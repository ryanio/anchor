/**
 * The bare HTTP client for Anchor's local data service — the part that has nothing to do with a
 * portfolio. `state/anchor.ts` (owned holdings) and `state/discovery.ts` (trending tokens and NFT
 * collections, looked up rather than owned) both read through this rather than each opening its own
 * `fetch` with its own timeout and its own idea of what a stale response looks like.
 */

const DEFAULT_BASE = "http://127.0.0.1:8787";

export function baseUrl(): string {
  return process.env.ANCHOR_SERVICE_URL ?? DEFAULT_BASE;
}

export interface Envelope {
  readonly data: unknown;
  readonly meta: { readonly fetchedAt: string; readonly ageSeconds: number; readonly stale: boolean };
}

export async function get(
  path: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
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

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const meta = (value as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  return typeof (meta as { ageSeconds?: unknown }).ageSeconds === "number";
}

export function metaOf(body: unknown): { ageSeconds: number | null; stale: boolean } {
  if (!isEnvelope(body)) return { ageSeconds: null, stale: false };
  return { ageSeconds: body.meta.ageSeconds, stale: body.meta.stale };
}
