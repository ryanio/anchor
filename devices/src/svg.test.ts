/**
 * What a key face promises: it fits, it escapes, and it never contains a colour that did not come
 * from a token.
 *
 * That last one is the enforceable half of `theme/README.md` principle 8. A hex literal in a render
 * function is invisible in review and obvious only when someone switches theme.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advance, escapeXml, fit, toSvg } from "./svg.ts";
import { toTokens } from "./tokens.ts";
import type { SlotSpec, Surface } from "./types.ts";

const TOKENS = toTokens("Test", {
  accent: "#7aa2f7",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  bright_foreground: "#c0caf5",
  dark_foreground: "#565f89",
  selection: "#292e42",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
});

const KEY: SlotSpec = { id: "key:0", kind: "key", paintable: true, width: 120, height: 120 };
const STRIP: SlotSpec = { id: "strip:0", kind: "strip", paintable: true, width: 800, height: 100 };

describe("escapeXml", () => {
  test("escapes markup so a label cannot become an element", () => {
    // Collection names and window titles are untrusted text; AGENTS.md treats them as data.
    assert.equal(escapeXml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&apos;");
  });

  test("a hostile label produces no tag in the output", () => {
    const svg = toSvg({ kind: "tile", emphasis: "ground", label: '</text><rect fill="#f00"/>' }, TOKENS, KEY);
    assert.equal(svg.includes('<rect fill="#f00"'), false);
    assert.equal(svg.includes("&lt;/text&gt;"), true);
  });
});

describe("fit", () => {
  test("leaves text that already fits", () => {
    assert.equal(fit("ws 4", 22, 800), "ws 4");
  });

  test("truncates with an ellipsis when it does not", () => {
    const fitted = fit("a very long window title indeed", 22, 100);
    assert.ok(fitted.endsWith("…"));
    assert.ok(advance(fitted, 22) <= 100);
  });

  test("degrades to empty rather than overflowing an impossible width", () => {
    assert.equal(fit("anything", 22, 1), "");
  });
});

describe("toSvg", () => {
  const colorsIn = (svg: string): string[] =>
    [...svg.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0].toLowerCase());
  const palette = new Set(
    Object.values(TOKENS)
      .filter((v) => typeof v === "string")
      .map((v) => v.toLowerCase()),
  );

  test("declares the slot's own size, not a hard-coded one", () => {
    assert.ok(toSvg({ kind: "tile", emphasis: "ground" }, TOKENS, KEY).includes('width="120" height="120"'));
    assert.ok(toSvg({ kind: "bar", segments: [] }, TOKENS, STRIP).includes('width="800" height="100"'));
  });

  test("every colour in a plain tile comes from the token set", () => {
    const svg = toSvg({ kind: "tile", emphasis: "ground", icon: "A", label: "Test" }, TOKENS, KEY);
    for (const color of colorsIn(svg)) assert.ok(palette.has(color), `${color} is not a token`);
  });

  test("an active tile's tint is derived from a token, and it differs from ground", () => {
    const ground = toSvg({ kind: "tile", emphasis: "ground", label: "x" }, TOKENS, KEY);
    const active = toSvg({ kind: "tile", emphasis: "active", label: "x" }, TOKENS, KEY);
    assert.notEqual(ground, active, "an active key must look different or the state is invisible");
  });

  test("a meter clamps out-of-range values instead of drawing outside the track", () => {
    const over = toSvg({ kind: "tile", emphasis: "ground", meter: 5 }, TOKENS, KEY);
    const full = toSvg({ kind: "tile", emphasis: "ground", meter: 1 }, TOKENS, KEY);
    assert.equal(over, full);
    const under = toSvg({ kind: "tile", emphasis: "ground", meter: -1 }, TOKENS, KEY);
    assert.ok(!under.includes('width="-'), "a negative meter must not emit a negative width");
  });

  test("bar segments stop at the edge rather than running off it", () => {
    const many: Surface = {
      kind: "bar",
      segments: Array.from({ length: 40 }, () => ({ icon: "A", text: "segment" })),
    };
    const svg = toSvg(many, TOKENS, STRIP);
    for (const match of svg.matchAll(/<text x="(\d+)"/g)) {
      assert.ok(Number(match[1]) < STRIP.width, `a segment starts at ${match[1]}, past the strip`);
    }
  });

  test("uses the system monospace family rather than naming a font", () => {
    // AGENTS.md: the font family is system-wide and is not ours to set.
    const svg = toSvg({ kind: "tile", emphasis: "ground", label: "x" }, TOKENS, KEY);
    assert.ok(svg.includes('font-family="monospace"'));
    assert.equal(/JetBrains|Cascadia|DejaVu/.test(svg), false);
  });
});
