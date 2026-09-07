/**
 * Shared test scaffolding.
 *
 * Nothing here touches the network or the keyring: `globalThis.fetch` is replaced for the duration
 * of a test and the credentials below are obvious placeholders. Real credentials live in the OS
 * keyring and never appear in a test, a fixture, or a commit (docs/security.md).
 *
 * The fetch stub is a *global* one rather than an injected `fetchImpl` because `@opensea/sdk` calls
 * `fetch` directly and offers no transport seam. That turns out to be an improvement for these
 * tests: they now assert the URL the SDK actually builds, which is the thing hand-rolled paths kept
 * getting wrong.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainIdentifier } from "@opensea/api-types";
import { WalletTokenProvider } from "./auth.ts";
import { Cache } from "./cache.ts";
import type { Config } from "./config.ts";
import { OpenSeaClient } from "./opensea.ts";

export const API_KEY = "placeholder-not-a-real-key-0123456789";
export const PAT = "placeholder-not-a-real-pat-9876543210";
export const JWT = "placeholder-not-a-real-jwt-abcdefghij";

export const NO_TTL = 0; // ttl 0 => the entry is stale the moment it is written
export const FRESH_TTL = 600;

export function tempCache(): Cache {
  return new Cache(join(mkdtempSync(join(tmpdir(), "anchor-test-")), "cache.sqlite"));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    chains: ["ethereum"],
    wallets: [],
    collections: [],
    tokens: [],
    port: 0,
    ttl: {
      nfts: 300,
      events: 60,
      stats: 120,
      listings: 120,
      offers: 60,
      portfolio: 120,
      tokens: 30,
      prices: 30,
    },
    requestsPerSecond: 2,
    ...overrides,
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  at: number;
}

export type Handler = (call: Call, index: number) => Response | Promise<Response>;

export interface FetchStub {
  calls: Call[];
  restore: () => void;
}

/** Only OpenSea traffic is stubbed. A test's own loopback requests must reach the real server. */
const UPSTREAM = "https://api.opensea.io";

/** Replace `globalThis.fetch`, recording every OpenSea call. Always paired with `restore()`. */
export function stubFetch(handler: Handler): FetchStub {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(input).startsWith(UPSTREAM)) return real(input, init);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      at: Date.now(),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

/** Answer each call from a list, reusing the last entry once the list runs out. */
export function respondInOrder(...responses: (() => Response)[]): Handler {
  return (_call, i) => responses[Math.min(i, responses.length - 1)]!();
}

export interface Harness {
  client: OpenSeaClient;
  cache: Cache;
  calls: Call[];
  restore: () => void;
}

export function harness(
  handler: Handler,
  opts: {
    cache?: Cache;
    apiKey?: string | null;
    pat?: string | null;
    chains?: ChainIdentifier[];
    requestsPerSecond?: number;
  } = {},
): Harness {
  const cache = opts.cache ?? tempCache();
  const { calls, restore } = stubFetch(handler);
  const walletToken = new WalletTokenProvider({
    getPat: async () => (opts.pat === undefined ? PAT : opts.pat),
  });
  const client = new OpenSeaClient({
    chains: opts.chains ?? ["ethereum"],
    requestsPerSecond: opts.requestsPerSecond ?? 1000,
    cache,
    walletToken,
    getApiKey: async () => (opts.apiKey === undefined ? API_KEY : opts.apiKey),
  });
  return { client, cache, calls, restore };
}

/** A stubbed token exchange, so wallet-scoped reads work without a real PAT. */
export function exchangeResponse(): Response {
  return jsonResponse({ accessToken: JWT, expiresIn: 43200, tokenScopes: ["read:wallets"] });
}

/** Route the auth exchange to a token and everything else to `handler`. */
export function withExchange(handler: Handler): Handler {
  return (call, index) =>
    call.url.includes("/auth/tokens/exchange") ? exchangeResponse() : handler(call, index);
}

export async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}
