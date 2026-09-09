/**
 * What a key face promises: it fits, it escapes, and it never contains a colour that did not come
 * from a token.
 *
 * That last one is the enforceable half of `theme/README.md` principle 8. A hex literal in a render
 * function is invisible in review and obvious only when someone switches theme.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  advance,
  barMetrics,
  escapeXml,
  fit,
  fitEnds,
  tileInset,
  tileRadius,
  toSvg,
  wrapText,
} from "./svg.ts";
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
    // The caption is elided to fit the key, so assert on the escaping rather than on a whole
    // substring of it: what matters is that no character of it can close an element.
    assert.ok(svg.includes("&lt;"), "the label's markup must arrive escaped");
    // Nothing outside a well-formed element may contain a `<`, whatever the label said.
    assert.equal(svg.replace(/<\/?[a-zA-Z][^>]*>/g, "").includes("<"), false);
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

/**
 * Sizes that follow the slot.
 *
 * Every one of these was a constant tuned on a 120x120 Stream Deck key and inherited unchanged by an
 * 80x35 Cardputer tile and an 18px status bar — which is how the device with the smallest surface in
 * the family ended up with 4px captions, pill-shaped keys and a sparkline running out through a
 * rounded corner. None of it was visible in the source; all of it was obvious in a render.
 *
 * These assert the *rules*, never rasterised pixels: CI has neither this machine's fonts nor its
 * themes, and asserting on a pixel offset has turned main red here before.
 */
describe("marks scale with the slot they are drawn in", () => {
  const TILE: SlotSpec = { id: "key:1", kind: "key", paintable: true, width: 80, height: 35 };
  const SHORT_STRIP: SlotSpec = { id: "strip:0", kind: "strip", paintable: true, width: 240, height: 18 };

  test("the corner radius is a proportion of the tile, capped at the deck's own", () => {
    assert.equal(tileRadius(120, 120), 14, "the shipped 120px key must not move");
    assert.ok(tileRadius(80, 35) < 8, "a 35px-tall tile with a 14px radius is a lozenge, not a key");
    assert.ok(tileRadius(80, 35) >= 2);
  });

  test("the inset never eats a fifth of a short tile", () => {
    assert.equal(tileInset(120, 120), 3.5);
    assert.ok(tileInset(80, 35) < 3.5);
    assert.ok(tileInset(80, 35) >= 1);
  });

  test("a status strip stays legible when it is eighteen pixels tall", () => {
    assert.equal(barMetrics(100).textSize, 22, "the shipped 800x100 strip must not move");
    assert.ok(barMetrics(18).textSize >= 8, "4px text on the Cardputer's only surface is not a status bar");
    assert.ok(barMetrics(18).textSize <= 18);
    assert.ok(barMetrics(18).gap < barMetrics(100).gap);
  });

  /**
   * Text bands, from the SVG's own numbers.
   *
   * Not a pixel assertion — nothing here is rasterised and no font is consulted. It reads back the
   * `y` and `font-size` this module chose and asserts they do not describe two marks in the same
   * place, which is exactly what a 120px layout does when it is handed a 35px tile: the reading and
   * its caption overlapped by two pixels, and the sparkline sat under both.
   */
  const bands = (svg: string): Array<[number, number]> =>
    [...svg.matchAll(/<text x="[\d.-]+" y="([\d.]+)" font-family="monospace" font-size="([\d.]+)"/g)].map(
      (m) => [Number(m[1]) - Number(m[2]) * 0.42, Number(m[1]) + Number(m[2]) * 0.42],
    );

  test("no two marks are drawn in the same place, at any tile size", () => {
    const surface: Surface = {
      kind: "tile",
      emphasis: "ground",
      icon: "A",
      value: "$48,214",
      label: "day",
      spark: [1, 5, 2, 8],
    };
    for (const slot of [KEY, TILE, { ...KEY, width: 72, height: 72 }]) {
      const found = bands(toSvg(surface, TOKENS, slot)).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < found.length; i++) {
        assert.ok(
          (found[i]?.[0] ?? 0) >= (found[i - 1]?.[1] ?? 0),
          `${slot.width}x${slot.height}: two marks overlap at ${JSON.stringify(found)}`,
        );
      }
    }
  });

  test("a mark too small to read is not drawn at all", () => {
    // The reading inside a donut is capped at 15% of the tile height, which is five pixels on a
    // Cardputer tile. The donut still says the proportion; five pixels of "66%" says nothing.
    const donut: Surface = { kind: "tile", emphasis: "ground", value: "66%", slices: [{ value: 2 }] };
    assert.equal(toSvg(donut, TOKENS, TILE).includes("66%"), false);
    assert.ok(toSvg(donut, TOKENS, KEY).includes("66%"), "a 120px key has room for it and must keep it");
  });

  test("a caption that fits is still drawn", () => {
    const svg = toSvg({ kind: "tile", emphasis: "ground", value: "$48,214", label: "day" }, TOKENS, TILE);
    assert.ok(svg.includes(">day<"));
  });

  test("a short strip drops the wash that only a tall one has room for", () => {
    const surface: Surface = { kind: "bar", segments: [{ text: "ready" }], background: [1, 4, 2, 9] };
    // The wash exists because the deck's 800x100 strip uses a third of its height for text. An 18px
    // bar uses all of it, and the same curve is then drawn through the glyphs.
    assert.ok(toSvg(surface, TOKENS, STRIP).includes("polyline"));
    assert.equal(toSvg(surface, TOKENS, SHORT_STRIP).includes("polyline"), false);
  });

  test("everything inside a key is clipped to the key", () => {
    // A sparkline is placed by a fraction of the height, and a rounded corner takes a bite out of
    // the rectangle that fraction thinks is free.
    const svg = toSvg({ kind: "tile", emphasis: "ground", spark: [1, 5, 2, 8] }, TOKENS, TILE);
    assert.ok(/<clipPath id="[^"]+"><rect /.test(svg));
    assert.ok(svg.includes('clip-path="url(#'));
  });

  test("an art key keeps its outline, which means the edge is drawn after the image", () => {
    const svg = toSvg(
      { kind: "tile", emphasis: "ground", image: "data:image/jpeg;base64,AAAA" },
      TOKENS,
      KEY,
    );
    const image = svg.indexOf("<image");
    const stroke = svg.lastIndexOf("stroke=");
    assert.ok(image !== -1);
    assert.ok(stroke > image, "the boundary was painted over by the artwork");
  });

  test("artwork takes the whole key, so no caption is drawn over it", () => {
    const svg = toSvg(
      { kind: "tile", emphasis: "ground", image: "data:image/jpeg;base64,AAAA", label: "Opepen 018" },
      TOKENS,
      KEY,
    );
    assert.equal(svg.includes("Opepen 018"), false);
  });
});

describe("fitEnds", () => {
  test("keeps both ends, so a qualifier at the tail survives", () => {
    // The two keys of a portfolio holding the same token on two chains must not read the same.
    const a = fitEnds("WSTETH·arbitrum-nova", 13, 100);
    const b = fitEnds("WSTETH·ethereum", 13, 100);
    assert.notEqual(a, b);
    assert.ok(advance(a, 13) <= 100);
    assert.ok(advance(b, 13) <= 100);
  });

  test("leaves text that already fits", () => {
    assert.equal(fitEnds("USDC", 13, 200), "USDC");
  });

  test("falls back to a tail ellipsis when there is no room for two ends", () => {
    assert.ok(fitEnds("WSTETH·ethereum", 13, 20).endsWith("…"));
  });
});

describe("wrapText", () => {
  test("breaks a sentence onto the lines it is given", () => {
    const lines = wrapText("Approval happens on the desktop, never here.", 12, 200, 2);
    assert.ok(lines !== null);
    assert.ok((lines ?? []).length <= 2);
    for (const line of lines ?? []) assert.ok(advance(line, 12) <= 200);
  });

  test("refuses rather than clipping when a single word will not fit", () => {
    assert.equal(wrapText("supercalifragilistic", 40, 30, 2), null);
  });

  test("a footer is never cut in half", () => {
    // `detail` has no producer yet, so this surface has never been on a screen. Its own contract
    // says the footer is never truncated; before this it ran off both edges of a 368px panel.
    const screen: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 368, height: 448 };
    const footer = "Approval happens on the desktop, never here.";
    const svg = toSvg(
      { kind: "detail", title: "Pudgy Penguin 4821", lines: [], footer, badge: "held" },
      TOKENS,
      screen,
    );
    const drawn = [...svg.matchAll(/>([^<>]*)<\/text>/g)].map((m) => m[1] ?? "").join(" ");
    for (const word of footer.split(" "))
      assert.ok(drawn.includes(word), `"${word}" was cut from the footer`);
  });

  test("a badge does not print over the title it labels", () => {
    const screen: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 368, height: 448 };
    const withBadge = toSvg(
      { kind: "detail", title: "Pudgy Penguin 4821", lines: [], badge: "held" },
      TOKENS,
      screen,
    );
    const without = toSvg({ kind: "detail", title: "Pudgy Penguin 4821", lines: [] }, TOKENS, screen);
    const titleIn = (svg: string): string =>
      [...svg.matchAll(/>([^<>]*)<\/text>/g)].map((m) => m[1] ?? "").find((t) => t.startsWith("Pudgy")) ?? "";
    assert.ok(titleIn(withBadge).length < titleIn(without).length, "the badge took no room from the title");
  });
});
