/**
 * Panel configuration.
 *
 * JSON rather than TOML, because Node has no TOML parser and this workspace will not add a
 * dependency for one. JSON also gets `\uXXXX` escapes for free, which is how icons are written:
 * Nerd Font glyphs live in the private use area, and a literal glyph in a config file is one
 * copy-paste or one editor away from becoming a replacement character. `""` always survives.
 *
 * Validation is strict and the errors name the path that is wrong. A panel that silently drops a
 * mistyped key is a panel you debug by staring at hardware.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenName } from "./types.ts";

export class ConfigError extends Error {}

export interface KeyConfig {
  readonly index: number;
  readonly icon: string;
  readonly label: string;
  readonly action: string;
  readonly hold: string;
  readonly state: string;
  /** A named live reading shown large on the key. See `KEY_SOURCES` in `panel.ts`. */
  readonly source: string;
  readonly tone?: TokenName;
}

export interface DialConfig {
  readonly index: number;
  readonly label: string;
  readonly icon: string;
  readonly control: string;
  readonly press: string;
  readonly step: number;
  readonly tone?: TokenName;
}

export interface StripSegmentConfig {
  /** Named live value: see `SEGMENT_SOURCES` in `panel.ts`. */
  readonly source: string;
  readonly icon: string;
  readonly tone?: TokenName;
}

export interface PageConfig {
  readonly name: string;
  readonly keys: readonly KeyConfig[];
  readonly dials: readonly DialConfig[];
  readonly segments: readonly StripSegmentConfig[];
}

export interface PanelConfig {
  readonly brightness: number;
  readonly pages: readonly PageConfig[];
}

const TOKEN_NAMES: ReadonlySet<string> = new Set([
  "ground",
  "raised",
  "sunken",
  "ink",
  "inkDim",
  "inkStrong",
  "accent",
  "positive",
  "negative",
  "warning",
  "line",
]);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new ConfigError(`${path} must be a string`);
  return value;
}

function asInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${path} must be an integer`);
  }
  return value;
}

function asTone(value: unknown, path: string): TokenName | undefined {
  if (value === undefined) return undefined;
  const name = asString(value, path);
  if (!TOKEN_NAMES.has(name)) {
    throw new ConfigError(`${path} is not a token name: ${name}. Valid: ${[...TOKEN_NAMES].join(", ")}`);
  }
  return name as TokenName;
}

export function parseConfig(raw: unknown): PanelConfig {
  const root = asRecord(raw, "config");
  const brightness = asInt(root.brightness, "brightness", 70);
  if (brightness < 0 || brightness > 100)
    throw new ConfigError(`brightness must be 0-100, got ${brightness}`);

  const pagesRaw = asArray(root.pages, "pages");
  if (pagesRaw.length === 0) throw new ConfigError("config must define at least one page");

  const seen = new Set<string>();
  const pages = pagesRaw.map((entry, pageIndex): PageConfig => {
    const page = asRecord(entry, `pages[${pageIndex}]`);
    const name = asString(page.name, `pages[${pageIndex}].name`);
    if (name === "") throw new ConfigError(`pages[${pageIndex}].name is required`);
    if (seen.has(name)) throw new ConfigError(`duplicate page name: ${name}`);
    seen.add(name);

    const keys = asArray(page.keys, `pages[${pageIndex}].keys`).map((keyEntry, i): KeyConfig => {
      const path = `pages[${pageIndex}].keys[${i}]`;
      const key = asRecord(keyEntry, path);
      if (key.index === undefined) throw new ConfigError(`${path}.index is required`);
      return {
        index: asInt(key.index, `${path}.index`, 0),
        icon: asString(key.icon, `${path}.icon`),
        label: asString(key.label, `${path}.label`),
        action: asString(key.action, `${path}.action`),
        hold: asString(key.hold, `${path}.hold`),
        state: asString(key.state, `${path}.state`),
        source: asString(key.source, `${path}.source`),
        tone: asTone(key.tone, `${path}.tone`),
      };
    });

    const dials = asArray(page.dials, `pages[${pageIndex}].dials`).map((dialEntry, i): DialConfig => {
      const path = `pages[${pageIndex}].dials[${i}]`;
      const dial = asRecord(dialEntry, path);
      if (dial.index === undefined) throw new ConfigError(`${path}.index is required`);
      return {
        index: asInt(dial.index, `${path}.index`, 0),
        label: asString(dial.label, `${path}.label`),
        icon: asString(dial.icon, `${path}.icon`),
        control: asString(dial.control, `${path}.control`, "none"),
        press: asString(dial.press, `${path}.press`),
        step: asInt(dial.step, `${path}.step`, 5),
        tone: asTone(dial.tone, `${path}.tone`),
      };
    });

    const segments = asArray(page.segments, `pages[${pageIndex}].segments`).map(
      (segmentEntry, i): StripSegmentConfig => {
        const path = `pages[${pageIndex}].segments[${i}]`;
        const segment = asRecord(segmentEntry, path);
        const source = asString(segment.source, `${path}.source`);
        if (source === "") throw new ConfigError(`${path}.source is required`);
        return {
          source,
          icon: asString(segment.icon, `${path}.icon`),
          tone: asTone(segment.tone, `${path}.tone`),
        };
      },
    );

    return { name, keys, dials, segments };
  });

  return { brightness, pages };
}

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "anchor", "devices.json");
}

/** Load from `path`, else the user's config, else the packaged default. */
export function loadConfig(path?: string): { config: PanelConfig; source: string } {
  const candidates = [
    path,
    userConfigPath(),
    new URL("../config/panel.json", import.meta.url).pathname,
  ].filter((candidate): candidate is string => typeof candidate === "string");
  for (const candidate of candidates) {
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      return { config: parseConfig(JSON.parse(text)), source: candidate };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${candidate}: ${detail}`);
    }
  }
  throw new ConfigError(`no config found; looked in: ${candidates.join(", ")}`);
}
