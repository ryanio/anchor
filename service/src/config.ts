/**
 * Configuration. Lives at $XDG_CONFIG_HOME/anchor/config.json (default ~/.config/anchor/config.json).
 *
 * Deliberately contains no secrets — the OpenSea API key lives in the OS keyring (see keyring.ts).
 * A config file that is safe to paste into an issue is a feature.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Config {
  /** Chain to query. See OpenSea's supported chain list; `ethereum` is the default. */
  chain: string;
  /** The wallet Anchor follows. Read-only: Anchor never holds its keys. */
  wallet: string;
  /** Collection slugs to watch. Users should pin only what they care about. */
  collections: string[];
  /** Loopback port for the local API. */
  port: number;
  /** Cache lifetimes in seconds, per resource. Keep these honest — they bound API load. */
  ttl: { nfts: number; events: number; stats: number; listings: number; offers: number };
  /** Upper bound on outbound requests per second. Politeness, not just rate-limit avoidance. */
  requestsPerSecond: number;
}

const DEFAULTS: Config = {
  chain: "ethereum",
  wallet: "",
  collections: [],
  port: 8787,
  ttl: { nfts: 300, events: 60, stats: 120, listings: 120, offers: 60 },
  requestsPerSecond: 2,
};

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anchor");
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "anchor");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Load config, writing a commented starter file on first run. */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + "\n", { mode: 0o644 });
    return { ...DEFAULTS };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  return {
    ...DEFAULTS,
    ...parsed,
    ttl: { ...DEFAULTS.ttl, ...(parsed.ttl ?? {}) },
  };
}
