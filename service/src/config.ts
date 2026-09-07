/**
 * Configuration. Lives at $XDG_CONFIG_HOME/anchor/config.json (default ~/.config/anchor/config.json).
 *
 * Deliberately contains no secrets — the OpenSea API key and PAT live in the OS keyring
 * (see keyring.ts). A config file that is safe to paste into an issue is a feature.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChainIdentifier } from "@opensea/api-types";
import { assertAddressForChains, CHAINS, isChainIdentifier } from "./chains.ts";

export interface Config {
  /**
   * Chains to query, validated against the SDK's own chain union. Order matters: endpoints that
   * take a list get all of them, and endpoints whose path carries a single chain use the first.
   */
  chains: ChainIdentifier[];
  /** The wallet Anchor follows. Read-only: Anchor never holds its keys. */
  wallet: string;
  /** Collection slugs to watch. Users should pin only what they care about. */
  collections: string[];
  /** Fungible token contract addresses to watch, on the first configured chain. */
  tokens: string[];
  /** Loopback port for the local API. */
  port: number;
  /** Cache lifetimes in seconds, per resource. Keep these honest — they bound API load. */
  ttl: {
    nfts: number;
    events: number;
    stats: number;
    listings: number;
    offers: number;
    portfolio: number;
    tokens: number;
    prices: number;
  };
  /** Upper bound on outbound requests per second. Politeness, not just rate-limit avoidance. */
  requestsPerSecond: number;
}

const DEFAULTS: Config = {
  chains: ["ethereum"],
  wallet: "",
  collections: [],
  tokens: [],
  port: 8787,
  ttl: {
    nfts: 300,
    events: 60,
    stats: 120,
    listings: 120,
    offers: 60,
    portfolio: 120,
    // Tokens move orders of magnitude faster than a collection floor (docs/tokens.md), so their
    // ttls are short. Short, not zero: the point of the cache is that six widgets asking the same
    // question cost one request.
    tokens: 30,
    prices: 30,
  },
  requestsPerSecond: 2,
};

/** Accepted on input for backwards compatibility, normalised away before anything reads it. */
interface ConfigInput extends Partial<Omit<Config, "chains">> {
  chains?: unknown;
  /** @deprecated Superseded by `chains`. A single slug is read as a one-element `chains`. */
  chain?: unknown;
}

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anchor");
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "anchor");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Load config, writing a starter file on first run. */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: 0o644 });
    return { ...DEFAULTS, chains: [...DEFAULTS.chains] };
  }
  let parsed: ConfigInput;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ConfigInput;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validate(parsed);
}

/**
 * A typo in a chain slug used to be invisible until the first API call, which came back 400 and
 * got cached as an error card. Checking against the SDK's union at load time turns that into one
 * message naming the bad value and the nearest real chains.
 */
function validateChains(parsed: ConfigInput): ChainIdentifier[] {
  const { chain, chains } = parsed;

  if (chains !== undefined && chain !== undefined) {
    throw new Error("config: set either `chains` (an array) or the older `chain` (a string), not both");
  }

  // Backwards compatibility: `"chain": "base"` still means what it always did.
  const raw = chains !== undefined ? chains : chain === undefined ? undefined : [chain];
  if (raw === undefined) return [...DEFAULTS.chains];

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "config: `chains` must be a non-empty array of chain slugs. A single `chain` string is still " +
        "accepted and is read as a one-element `chains`.",
    );
  }

  const out: ChainIdentifier[] = [];
  for (const value of raw) {
    if (!isChainIdentifier(value)) {
      const near = suggest(value);
      throw new Error(
        `config: ${JSON.stringify(value)} is not a chain OpenSea supports.` +
          (near.length > 0 ? ` Did you mean ${near.join(" or ")}?` : "") +
          ` Valid chains: ${CHAINS.join(", ")}.`,
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Cheap "did you mean" — a shared prefix or a substring is enough for a typo. */
function suggest(value: unknown): string[] {
  if (typeof value !== "string" || value.length < 2) return [];
  const needle = value.toLowerCase();
  return CHAINS.filter((c) => c.startsWith(needle.slice(0, 3)) || c.includes(needle) || needle.includes(c))
    .slice(0, 3)
    .map((c) => JSON.stringify(c));
}

/**
 * Config comes off disk, so every field is untrusted. Silently accepting a bad value is worse than
 * refusing it: `"requestsPerSecond": "fast"` produced NaN, which made the rate limiter's `wait > 0`
 * always false and disabled rate limiting entirely, with no error anywhere.
 */
export function validate(parsed: ConfigInput): Config {
  const str = (v: unknown, fallback: string, field: string): string => {
    if (v === undefined) return fallback;
    if (typeof v !== "string") throw new Error(`config: \`${field}\` must be a string`);
    return v;
  };
  const num = (v: unknown, fallback: number, field: string, min: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      throw new Error(`config: \`${field}\` must be a finite number >= ${min}`);
    }
    return v;
  };
  const strings = (v: unknown, fallback: string[], field: string): string[] => {
    if (v === undefined) return [...fallback];
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
      throw new Error(`config: \`${field}\` must be an array of strings`);
    }
    return v as string[];
  };

  const chains = validateChains(parsed);
  const collections = strings(parsed.collections, DEFAULTS.collections, "collections");
  const tokens = strings(parsed.tokens, DEFAULTS.tokens, "tokens");
  const wallet = str(parsed.wallet, DEFAULTS.wallet, "wallet");

  // Address shape depends on the chain, so this can only run once `chains` is known.
  assertAddressForChains(wallet, chains, "wallet");
  for (const [i, token] of tokens.entries()) assertAddressForChains(token, chains, `tokens[${i}]`);

  const ttlIn = parsed.ttl ?? {};
  if (typeof ttlIn !== "object" || ttlIn === null) throw new Error("config: `ttl` must be an object");

  const ttl = {} as Config["ttl"];
  for (const k of Object.keys(DEFAULTS.ttl) as Array<keyof Config["ttl"]>) {
    ttl[k] = num((ttlIn as Record<string, unknown>)[k], DEFAULTS.ttl[k], `ttl.${k}`, 0);
  }

  return {
    chains,
    wallet,
    collections,
    tokens,
    port: num(parsed.port, DEFAULTS.port, "port", 0),
    ttl,
    requestsPerSecond: num(parsed.requestsPerSecond, DEFAULTS.requestsPerSecond, "requestsPerSecond", 0.1),
  };
}
