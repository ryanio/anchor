/**
 * Design tokens for devices, resolved from the live Omarchy theme.
 *
 * `theme/tokens.css` is the design system for surfaces that render CSS. A Stream Deck key is a
 * bitmap, so it cannot consume that file — but it must not therefore invent its own palette. This
 * module resolves the *same vocabulary* from the same place the Quickshell widget does: the active
 * Omarchy theme. `theme/README.md` principle 8 puts it plainly — never a colour at a call site,
 * and in the widget every colour resolves through the live Omarchy theme.
 *
 * Every Omarchy theme ships `colors.toml` with an identical key set, which is what makes this a
 * stable mapping rather than a guess. The theme directory is resolved via `omarchy theme dir`, so a
 * user-installed theme wins over a stock one exactly as it does everywhere else.
 *
 * The fallback below is Tokyo Night, Omarchy's own default. It exists so a device still renders on
 * a machine where `omarchy` is absent — a CI runner, or an ESP32 talking to a headless service —
 * rather than throwing at paint time.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenName } from "./types.ts";

export type Tokens = Readonly<Record<TokenName, string>> & {
  readonly themeName: string;
  readonly dark: boolean;
};

/** Tokyo Night, Omarchy's default. Used only when the live theme cannot be read. */
const FALLBACK_COLORS: Record<string, string> = {
  mode: "dark",
  accent: "#7aa2f7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  bright_foreground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  green: "#9ece6a",
};

function run(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Omarchy theme directories are slugs; `omarchy theme current` returns a display name. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A deliberately small TOML reader for `colors.toml`.
 *
 * Node has no TOML parser and this workspace will not add a dependency for one. That is only
 * defensible because the input is not general TOML: every Omarchy theme's `colors.toml` is a flat
 * list of `key = "value"` pairs with no tables, arrays or multi-line strings. Anything this does
 * not understand is skipped rather than guessed at, so a theme that grows a table cannot poison the
 * palette — it just does not contribute that key.
 */
export function parseFlatToml(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1 && !value.startsWith('"')) value = value.slice(0, hash).trim();
    const quoted = /^"([^"]*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
    if (!quoted) continue;
    const captured = quoted[1];
    if (key !== "" && captured !== undefined) out[key] = captured;
  }
  return out;
}

/** Read the active theme's raw Omarchy colours, or the fallback set. */
export function readThemeColors(themeName?: string): { name: string; colors: Record<string, string> } {
  const name = themeName ?? run("omarchy", ["theme", "current"]) ?? "Tokyo Night";
  const dir = run("omarchy", ["theme", "dir", slugify(name)]);
  if (dir === null) return { name, colors: { ...FALLBACK_COLORS } };
  try {
    const parsed = parseFlatToml(readFileSync(join(dir, "colors.toml"), "utf8"));
    return { name, colors: { ...FALLBACK_COLORS, ...parsed } };
  } catch {
    return { name, colors: { ...FALLBACK_COLORS } };
  }
}

/**
 * Map Omarchy's palette onto the device token vocabulary.
 *
 * The three surfaces come from `theme/README.md` principle 5. `sunken` is the darkest so the gap
 * between keys reads as recessed against the tile sitting on it; `raised` is what an active tile
 * lifts toward before its accent tint is applied.
 */
export function toTokens(name: string, colors: Record<string, string>): Tokens {
  const pick = (key: string, fallbackKey: string): string =>
    colors[key] ?? colors[fallbackKey] ?? FALLBACK_COLORS[fallbackKey] ?? "#000000";
  return {
    themeName: name,
    dark: (colors.mode ?? "dark") !== "light",
    ground: pick("dark_background", "background"),
    raised: pick("lighter_background", "background"),
    sunken: pick("darker_background", "dark_background"),
    ink: pick("foreground", "foreground"),
    inkDim: pick("dark_foreground", "foreground"),
    inkStrong: pick("bright_foreground", "foreground"),
    accent: pick("accent", "accent"),
    positive: pick("green", "accent"),
    negative: pick("red", "accent"),
    warning: pick("yellow", "accent"),
    line: pick("selection", "muted"),
  };
}

export function loadTokens(themeName?: string): Tokens {
  const { name, colors } = readThemeColors(themeName);
  return toTokens(name, colors);
}

/** `#rrggbb` to an `[r, g, b]` triple. Returns black for anything unparseable. */
export function toRgb(color: string): [number, number, number] {
  let hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** Blend two colours; `ratio` 0 is all `a`, 1 is all `b`. Used for active-tile tints. */
export function mix(a: string, b: string, ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * clamped)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}
