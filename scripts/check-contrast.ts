#!/usr/bin/env node
/**
 * WCAG contrast gate for the design tokens.
 *
 * Glass and low-contrast palettes fail quietly: the design looks right to whoever chose it and is
 * unreadable to someone else. This computes the actual ratios from theme/tokens.css and fails CI,
 * so a colour cannot land on taste alone.
 *
 * Thresholds: AA is 4.5:1 for body text and 3:1 for large text and UI boundaries.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "theme", "tokens.css"), "utf8");

/** Pull `--name: value;` pairs from a block, so light and dark can be resolved separately. */
function scope(marker: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const body = css.slice(start);
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

function resolve(vars: Map<string, string>, value: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() cycle near: ${value}`);
  const m = /var\(\s*--([a-z0-9-]+)\s*\)/i.exec(value);
  if (!m) return value;
  const next = vars.get(m[1]!);
  if (next === undefined) throw new Error(`undefined token: --${m[1]}`);
  return resolve(vars, value.replace(m[0], next), depth + 1);
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [l1, l2] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

interface Pair {
  fg: string;
  bg: string;
  min: number;
  note: string;
}

const PAIRS: Pair[] = [
  { fg: "text", bg: "bg", min: 4.5, note: "body text on the page" },
  { fg: "text", bg: "bg-elevated", min: 4.5, note: "body text on a card" },
  { fg: "text-muted", bg: "bg", min: 4.5, note: "secondary text — still body copy" },
  { fg: "text-muted", bg: "bg-elevated", min: 4.5, note: "secondary text on a card" },
  { fg: "text-subtle", bg: "bg", min: 3.0, note: "labels and captions (large/UI)" },
  { fg: "accent", bg: "bg", min: 4.5, note: "links on the page" },
  { fg: "accent", bg: "bg-elevated", min: 4.5, note: "links on a card" },
  { fg: "ember", bg: "bg", min: 4.5, note: "the counterpoint accent" },
  { fg: "ember", bg: "bg-elevated", min: 4.5, note: "counterpoint on a card" },
  { fg: "border-strong", bg: "bg", min: 1.4, note: "a visible edge" },

  // Component tokens (theme/components.css). Every colour pair a component can produce is checked
  // here, because the components are the layer people actually copy — a pill that fails AA gets
  // reproduced on every page that reaches for it.
  { fg: "attention-fg", bg: "attention-bg", min: 4.5, note: ".pill--required — the one that asks" },
  { fg: "bg-elevated", bg: "attention-fg", min: 4.5, note: "the number knocked out of .is-current" },
  { fg: "attention-border", bg: "bg-elevated", min: 1.4, note: ".pill--required's edge" },
  { fg: "text", bg: "surface-sunken", min: 4.5, note: "body text in a .well" },
  { fg: "text-muted", bg: "surface-sunken", min: 4.5, note: "a hint in a .well" },
  { fg: "text-subtle", bg: "surface-sunken", min: 3.0, note: ".progress-seg.is-filled on its track" },
];

let failed = 0;

// The base map is every token in document order, first-wins — which yields the light theme, since
// the dark block comes later. The dark map is the base with the dark block's overrides applied.
const base = scope(":root {");
const darkOnly = scope("@media (prefers-color-scheme: dark)");
const dark = new Map(base);
for (const [k, v] of darkOnly) dark.set(k, v);

for (const [name, vars] of [
  ["light", base],
  ["dark", dark],
] as const) {
  const get = (k: string) => {
    const raw = vars.get(k);
    if (raw === undefined) throw new Error(`undefined token: --${k}`);
    return resolve(vars, raw);
  };

  console.log(`\n${name}:`);
  for (const p of PAIRS) {
    const r = ratio(get(p.fg), get(p.bg));
    const ok = r >= p.min;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)}:1  (min ${p.min})  --${p.fg} on --${p.bg}  — ${p.note}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} pair(s) below the WCAG threshold. Adjust the token, not the threshold.`);
  process.exit(1);
}
console.log("\nAll token pairs meet WCAG AA.");
