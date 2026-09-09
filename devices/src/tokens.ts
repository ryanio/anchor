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
 * Read Omarchy's palette into the device token vocabulary, exactly as the theme authored it.
 *
 * This step is a *reading*, not a design: it says what the theme claims each role is. Whether those
 * claims survive a 120px backlit key is `deriveSurfaces` and `legible`'s problem, below. Keeping the
 * two apart matters, because a theme whose `lighter_background` equals its `background` is not
 * malformed — it is a theme that has no opinion about depth, and the difference between "said
 * nothing" and "said something unusable" is only visible while the raw reading still exists.
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

/** WCAG relative luminance, for the legibility floor below. */
function luminance(color: string): number {
  const channels = toRgb(color).map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function ratio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * Nudge a mark colour until it is legible on `background`, blending toward `toward`.
 *
 * Themes are designed for a large screen at arm's length, not a 120px key on a desk, and some do
 * not clear the bar. Omarchy's own `rose-pine` puts a #56949f accent on a #ede7e1 ground: 2.79:1,
 * under the 3:1 AA floor for a UI mark, so an active key's underline would be near-invisible on it.
 *
 * This blends toward the theme's own foreground rather than to black or white, so the result still
 * belongs to the palette — the colour is still derived from tokens, never picked at a call site.
 * A theme that already clears the floor is returned untouched, which is almost all of them.
 */
export function ensureLegible(color: string, background: string, toward: string, target: number): string {
  if (ratio(color, background) >= target) return color;
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(color, toward, step / 20);
    if (ratio(candidate, background) >= target) return candidate;
  }
  return toward;
}

const BLACK = "#000000";
const WHITE = "#ffffff";

/**
 * Move a colour's lightness without touching its hue or saturation.
 *
 * `ensureLegible` rescues a colour by blending it toward another one, and blending is a hue change:
 * pushing `rose-pine`'s #56949f teal toward that theme's #575279 foreground far enough to clear
 * 4.5:1 produced a slate purple. It was legible and it was no longer Rose Pine. Sliding lightness
 * instead gives a *darker teal* — a colour the theme would recognise as its own, which is the whole
 * point of wearing the user's palette rather than ours.
 */
function withLightness(color: string, lightness: number): string {
  const [r, g, b] = toRgb(color).map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  const target = Math.min(1, Math.max(0, lightness));
  if (delta === 0) {
    const grey = Math.round(target * 255);
    return `#${[grey, grey, grey].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  const c = (1 - Math.abs(2 * target - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = target - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${[r1 + m, g1 + m, b1 + m]
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A colour's HSL lightness, which is what `withLightness` slides. */
function lightnessOf(color: string): number {
  const [r, g, b] = toRgb(color).map((channel) => channel / 255) as [number, number, number];
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/**
 * The legibility floor for a colour drawn on `background`, keeping the colour's own hue.
 *
 * Direction is decided by the background rather than by the colour: on a light key a mark has to go
 * darker and on a dark key lighter, and either way the hue survives the trip. Where lightness alone
 * cannot get there — a mark on a mid-grey ground with nowhere useful to go — it falls back to
 * `ensureLegible`, blending toward the theme's own foreground, which always can.
 */
export function ensureLegibleHue(color: string, background: string, toward: string, target: number): string {
  if (ratio(color, background) >= target) return color;
  const start = lightnessOf(color);
  const darken = luminance(background) > luminance(color) || luminance(background) > 0.18;
  for (let step = 1; step <= 50; step++) {
    const l = darken ? start * (1 - step / 50) : start + (1 - start) * (step / 50);
    const candidate = withLightness(color, l);
    if (ratio(candidate, background) >= target) return candidate;
  }
  return ensureLegible(color, background, toward, target);
}

/**
 * Blend `toward` into `ground` until the pair reaches `target`, or as far as the ground allows.
 *
 * Stepping by blend fraction rather than by a fixed lightness delta is what makes one rule work on
 * both a #000000 ground and a #ffffff one: where a ground cannot move further in that direction the
 * loop runs out and returns the closest it reached, and the caller decides whether to reverse.
 */
function stepToward(ground: string, toward: string, target: number): string {
  let best = ground;
  for (let step = 1; step <= 60; step++) {
    best = mix(ground, toward, (step * 0.6) / 60);
    if (ratio(best, ground) >= target) return best;
  }
  return best;
}

/**
 * A derived step off `ground`, reversing direction when the ground has no room left in it.
 *
 * `vantablack` grounds at #000000 and `white` at #ffffff, so "a press is lighter" and "a gap is
 * darker" are each false somewhere. When the preferred direction cannot reach the target the step
 * goes the other way and takes a shorter one, which keeps the layers ordered rather than letting
 * the quieter surface out-shout the one above it. This is the same reasoning — and the same shape —
 * as `panelSurfaces` in `widget/PulseModel.js`; the widget and the device are one system, and a
 * theme that survives one should survive the other.
 */
function derivedStep(
  ground: string,
  preferred: string,
  opposite: string,
  target: number,
  reversedTarget: number,
  min: number,
): string {
  const first = stepToward(ground, preferred, target);
  if (ratio(first, ground) >= min) return first;
  return stepToward(ground, opposite, reversedTarget);
}

/** The theme's own value when it is a usable step off *this* ground, otherwise a derived one. */
function surfaceStep(
  ground: string,
  candidate: string,
  preferred: string,
  opposite: string,
  band: { min: number; max: number; target: number; reversed: number },
): string {
  const r = ratio(candidate, ground);
  if (r >= band.min && r <= band.max) return candidate;
  return derivedStep(ground, preferred, opposite, band.target, band.reversed, band.min);
}

/**
 * A pressed key has to *flash*. Through the Stream Deck's diffuser a 1.02:1 step is not a subtle
 * confirmation, it is no confirmation — and five stock themes land there, `solitude` and
 * `last-horizon` because they set `lighter_background` to the same value as `background`.
 */
const RAISED_BAND = { min: 1.18, max: 2.2, target: 1.34, reversed: 1.22 };
/**
 * The gap between keys. Wider floor than the widget's, because this one is not a hairline on a
 * screen — it is the 3.5px frame that gives a key its rounded corner, and at 1.01:1 (nine stock
 * themes) the tile has no shape at all and the grid reads as one unbroken slab.
 */
const SUNKEN_BAND = { min: 1.14, max: 2.0, target: 1.26, reversed: 1.16 };
/**
 * The tile edge, and the meter track. `selection` is the theme's own "this is picked" colour and
 * across the stock set it runs from 1.13:1 to 2.5:1 against the tile — the bottom of that range
 * draws nothing. The ceiling matters as much: a boundary that reaches text contrast stops reading
 * as an edge and starts reading as content.
 */
const LINE_BAND = { min: 1.55, max: 4.5, target: 2.1, reversed: 2.1 };

/**
 * Give the three surfaces real separation, deriving any the theme did not usefully supply.
 *
 * `theme/README.md` principle 5 is depth instead of dividers, and depth that measures 1.02:1 is a
 * divider that was never drawn. The rule is the widget's: take the theme's own value whenever it is
 * a genuine step off this ground, and derive one from the ground itself when it is not. A theme is
 * never overridden for having an opinion — only for having none.
 */
export function deriveSurfaces(tokens: Tokens): Tokens {
  const { ground } = tokens;
  // Raised moves toward the reader, sunken away from it. On a light theme both are darker than the
  // ground, because a light UI has no headroom above white — which is what the stock themes do.
  const up = tokens.dark ? WHITE : BLACK;
  const down = tokens.dark ? BLACK : WHITE;
  const raised = surfaceStep(ground, tokens.raised, up, down, RAISED_BAND);
  const sunken = surfaceStep(ground, tokens.sunken, BLACK, WHITE, SUNKEN_BAND);
  // The theme's foreground makes the best derived rule: it is the one colour guaranteed to
  // contrast with the ground, so an edge derived from it still belongs to the palette.
  const line = surfaceStep(ground, tokens.line, tokens.ink, tokens.ink, LINE_BAND);
  return { ...tokens, raised, sunken, line };
}

/**
 * The fill of an active key, and the colour of the marks drawn on it.
 *
 * A key that is *on* should be lit. The previous rule tinted the tile 30% toward its tone and drew
 * the icon and underline in that same tone, which works on a dark theme and inverts on a light one:
 * on `rose-pine` the accent measured 2.25:1 against the tile it was painted on, on `catppuccin-latte`
 * 2.63:1 and on `lupine` 2.88:1 — all under the 3:1 floor for a UI mark, and the previews showed
 * exactly that, an "active" key less legible than its inactive neighbours. The gate never caught it
 * because it measured the accent against `ground`, a surface the active mark is never drawn on.
 *
 * A fixed blend ratio was the root of it. 30% toward the tone barely moves a near-black ground and
 * halves the contrast of a near-white one, so the same number is two different designs. Filling the
 * tile with the tone instead makes the state unmistakable at arm's length on every theme, and turns
 * the contrast question into one with a guaranteed answer: the marks take whichever palette colour
 * stands furthest from the tone.
 */
export function activeFill(tokens: Tokens, tone: string): string {
  // A tone is whatever token the config named, and a page is free to name a quiet one. The floor
  // keeps an "on" key distinguishable from an "off" one even then: `tone: "line"` would otherwise
  // fill the tile with very nearly the ground it sits on.
  return ensureLegible(tone, tokens.ground, tokens.ink, 3);
}

/**
 * The mark colour for an active tile: the palette member that contrasts most with the fill.
 *
 * Every candidate is a token, so this stays a derivation rather than a colour picked at a call
 * site. The last-resort step toward black or white only runs when no palette member clears the
 * floor — a monochrome theme whose accent sits mid-grey — and is the same device `deriveSurfaces`
 * uses to get a step out of a ground with no headroom.
 */
export function onActive(tokens: Tokens, tone: string): string {
  const candidates = [tokens.sunken, tokens.ground, tokens.inkStrong, tokens.ink];
  let best = candidates[0] ?? tokens.ground;
  for (const candidate of candidates) {
    if (ratio(candidate, tone) > ratio(best, tone)) best = candidate;
  }
  if (ratio(best, tone) >= 4.5) return best;
  return ensureLegible(best, tone, luminance(tone) > 0.35 ? BLACK : WHITE, 4.5);
}

/**
 * The whole pipeline over one already-read palette: read it, give it depth, make its marks legible.
 *
 * Exported separately from `loadTokens` because `loadTokens` resolves the theme through
 * `omarchy theme dir`, and a name that does not resolve falls back to Tokyo Night rather than
 * failing. That is right at paint time — a device must draw *something* — and wrong in a gate,
 * where it means a theme whose `colors.toml` is missing gets measured as Tokyo Night and passes.
 * `contrast.test.ts` reads each file itself and comes through here, so nothing it checks can be a
 * palette other than the one on disk.
 */
export function deviceTokens(name: string, colors: Record<string, string>): Tokens {
  return legible(deriveSurfaces(toTokens(name, colors)));
}

export function loadTokens(themeName?: string): Tokens {
  const { name, colors } = readThemeColors(themeName);
  return deviceTokens(name, colors);
}

/**
 * The floor for a toned colour, against the ground it is drawn on.
 *
 * 4.5:1 rather than the 3:1 an icon or a rule would need, because every one of these four is also
 * drawn as *text*: a tile's reading takes its tone, and a reading is the portfolio total or the
 * P&L. `autoSize` shrinks a long one to 13px to keep its last digits, so it cannot be argued into
 * the large-text exemption either. On `solitude` the day's P&L came out at 3.16:1 — a dim grey
 * number on a near-black key, and the single most important thing on the page.
 */
const TONE_FLOOR = 4.5;

/**
 * Apply the legibility floor to the colours that are drawn *as marks* — a reading, an icon, a
 * meter fill. Surface colours are not adjusted here: a background is not required to contrast with
 * itself, and `deriveSurfaces` above has already given them their separation.
 */
export function legible(tokens: Tokens): Tokens {
  const floor = (color: string): string => ensureLegibleHue(color, tokens.ground, tokens.ink, TONE_FLOOR);
  return {
    ...tokens,
    accent: floor(tokens.accent),
    positive: floor(tokens.positive),
    negative: floor(tokens.negative),
    warning: floor(tokens.warning),
  };
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
