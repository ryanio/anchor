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
  gridCellAt,
  gridMetrics,
  gridWindow,
  TOUCH_TARGET_PX,
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
const PULSE: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 368, height: 448 };

const cells = (count: number) =>
  Array.from({ length: count }, (_v, i) => ({ label: `Cell ${i}`, emphasis: "ground" as const }));

describe("escapeXml", () => {
  test("escapes markup so a label cannot become an element", () => {
    // Collection names and window titles are untrusted text; AGENTS.md treats them as data.
    assert.equal(escapeXml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&apos;");
  });

  test("a hostile label produces no tag in the output, on a key or in a grid cell", () => {
    const hostile = '</text><rect fill="#f00"/>';
    const surfaces: Array<[Surface, SlotSpec]> = [
      [{ kind: "tile", emphasis: "ground", label: hostile }, KEY],
      // A cell is a tile, so it takes the same path.
      [{ kind: "grid", cells: [{ label: hostile, emphasis: "ground" }] }, PULSE],
    ];
    for (const [surface, slot] of surfaces) {
      const svg = toSvg(surface, TOKENS, slot);
      assert.equal(svg.includes('<rect fill="#f00"'), false);
      // The caption is elided to fit the key, so assert on the escaping rather than on a whole
      // substring of it: what matters is that no character of it can close an element.
      assert.ok(svg.includes("&lt;"), "the label's markup must arrive escaped");
      // Nothing outside a well-formed element may contain a `<`, whatever the label said.
      assert.equal(svg.replace(/<\/?[a-zA-Z][^>]*>/g, "").includes("<"), false);
    }
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

  test("every colour in a plain tile, or a grid of them, comes from the token set", () => {
    const surfaces: Array<[Surface, SlotSpec]> = [
      [{ kind: "tile", emphasis: "ground", icon: "A", label: "Test" }, KEY],
      [{ kind: "grid", cells: cells(8), selected: 1 }, PULSE],
    ];
    for (const [surface, slot] of surfaces) {
      const svg = toSvg(surface, TOKENS, slot);
      for (const color of colorsIn(svg)) assert.ok(palette.has(color), `${color} is not a token`);
    }
  });

  test("an active tile looks different from a ground one", () => {
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

  test("a tile draws no boundary stroke; the gap between real keys is the only edge it needs", () => {
    const svg = toSvg(
      { kind: "tile", emphasis: "ground", image: "data:image/jpeg;base64,AAAA" },
      TOKENS,
      KEY,
    );
    assert.ok(svg.includes("<image"));
    assert.ok(!svg.includes("stroke="));
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

/**
 * The grid, which is the surface a finger uses.
 *
 * Every assertion here is about a rule rather than a rasterised pixel, for the reason the block
 * above says: CI has neither this machine's fonts nor its themes. What a touch panel adds is that
 * one of those rules is about a *hand* — a cell under about 9mm is a cell people miss — so the
 * arithmetic that turns a panel into columns is held to the size it claims to produce.
 */
describe("a grid of tappable cells", () => {
  const ROUND: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 240, height: 240 };
  const NARROW: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 170, height: 320 };

  test("the 368x448 panel comes out three columns of roughly a thumb", () => {
    const metrics = gridMetrics(PULSE, 8);
    assert.equal(metrics.columns, 3);
    assert.equal(metrics.rows, 3);
    /*
     * 322 ppi measured off the panel's own diagonal, so `TOUCH_TARGET_PX` is about 9.5mm of finger.
     * A cell is allowed to come in a little under it: the layout now keeps a margin clear of the
     * panel's rounded corners, and spending a whole column on that curve would be the worse trade —
     * three columns of 111px is still nearly 9mm each, where two columns would be a third of the
     * screen given up. The floor is what stops that relaxation sliding into cells nobody can hit.
     */
    const floor = Math.round(TOUCH_TARGET_PX * 0.9);
    assert.ok(metrics.cellWidth >= floor, `${metrics.cellWidth}px is under a finger`);
    assert.ok(metrics.cellHeight >= floor);
  });

  test("a panel too narrow for two legible columns takes one rather than two cramped ones", () => {
    const metrics = gridMetrics(NARROW, 8);
    assert.equal(metrics.columns, 1);
    assert.ok(metrics.cellWidth >= TOUCH_TARGET_PX);
  });

  test("never more columns or rows than there are cells to put in them", () => {
    // Two keys on a 368px panel is two wide cells, not two cells and a column of nothing.
    const metrics = gridMetrics(PULSE, 2);
    assert.equal(metrics.columns, 2);
    assert.equal(metrics.rows, 1);
  });

  test("a grid that does not fit pages, rather than scrolling by one cell", () => {
    // The thing a grid is for is that a target stays where the hand last found it.
    assert.equal(gridWindow(8, 0, 4), 0);
    assert.equal(gridWindow(8, 3, 4), 0);
    assert.equal(gridWindow(8, 4, 4), 4, "the page turns whole");
    assert.equal(gridWindow(8, 7, 4), 4);
    assert.equal(gridWindow(4, 3, 4), 0, "everything fits, so there is nothing to page");
  });

  test("the centre of every cell resolves to that cell, and to no other", () => {
    const metrics = gridMetrics(PULSE, 8);
    const seen = new Set<number>();
    for (let index = 0; index < metrics.capacity; index++) {
      const x = metrics.originX + (index % metrics.columns) * metrics.cellWidth + metrics.cellWidth / 2;
      const y =
        metrics.originY + Math.floor(index / metrics.columns) * metrics.cellHeight + metrics.cellHeight / 2;
      const hit = gridCellAt(PULSE, 8, 0, x, y);
      assert.equal(hit, index < 8 ? index : null, `the centre of cell ${index} resolved to ${hit}`);
      if (hit !== null) seen.add(hit);
    }
    assert.equal(seen.size, 8, "eight cells, eight distinct answers");
  });

  test("the gutter between two tiles belongs to neither", () => {
    // The guard that lets a tap dispatch at all: between two targets is not a target, so a sleeve
    // brushing the boundary cannot be rounded into a keypress.
    const metrics = gridMetrics(PULSE, 8);
    const boundary = metrics.originX + metrics.cellWidth;
    assert.equal(gridCellAt(PULSE, 8, 0, boundary, 100), null);
    assert.equal(gridCellAt(PULSE, 8, 0, boundary - 1, 100), null, "the inset side of it too");
  });

  test("a touch off the grid, or on a cell that is not there, is not a cell", () => {
    assert.equal(gridCellAt(PULSE, 8, 0, -4, 100), null);
    assert.equal(gridCellAt(PULSE, 8, 0, 1000, 100), null);
    assert.equal(gridCellAt(PULSE, 0, 0, 60, 100), null, "an empty page has nothing to hit");
    // Nine boxes and eight cells: the ninth is drawn as nothing and must answer as nothing.
    const metrics = gridMetrics(PULSE, 8);
    const last = {
      x: metrics.originX + metrics.cellWidth * 2.5,
      y: metrics.originY + metrics.cellHeight * 2.5,
    };
    assert.equal(gridCellAt(PULSE, 8, 0, last.x, last.y), null);
  });

  test("the hit test answers for the page the selection is on", () => {
    // 240x240 holds four cells, so keys five to eight are on the second page — and the top-left box
    // is cell 0 or cell 4 depending on where the cursor is. A hit test that ignored that would run
    // a key the person is not looking at.
    const metrics = gridMetrics(ROUND, 8);
    assert.equal(metrics.capacity, 4);
    const topLeft = { x: metrics.originX + 20, y: metrics.originY + 20 };
    assert.equal(gridCellAt(ROUND, 8, 0, topLeft.x, topLeft.y), 0);
    assert.equal(gridCellAt(ROUND, 8, 5, topLeft.x, topLeft.y), 4);
  });

  test("the selection is a ring, so it composes with a tile that is already filled", () => {
    // `emphasis` spends the fill on whether the thing is on. A selection that also filled would
    // make selected-and-off identical to unselected-and-on.
    const plain = toSvg({ kind: "grid", cells: cells(8) }, TOKENS, PULSE);
    const chosen = toSvg({ kind: "grid", cells: cells(8), selected: 1 }, TOKENS, PULSE);
    assert.equal(plain.includes("stroke-width"), false, "nothing is ringed when nothing is selected");
    assert.ok(chosen.includes('fill="none" stroke='));
  });

  test("cells past the panel's capacity are not drawn at all", () => {
    // Four boxes on the round panel; the other four are a page turn away, not a half-tile.
    const svg = toSvg({ kind: "grid", cells: cells(8), selected: 0 }, TOKENS, ROUND);
    assert.ok(svg.includes("Cell 0"));
    assert.equal(svg.includes("Cell 4"), false);
  });

  test("an empty grid says why it is empty rather than going blank", () => {
    const svg = toSvg({ kind: "grid", cells: [], empty: 'nothing matches "zzz"' }, TOKENS, PULSE);
    assert.ok(svg.includes("zzz"));
  });

  test("each cell clips to its own box, never to its neighbour's", () => {
    // `renderTile` derives its clip-path id from the slot id it is given. Two cells sharing one id
    // would clip the second tile to the first one's rectangle — a bug that only shows on a device.
    const svg = toSvg({ kind: "grid", cells: cells(8) }, TOKENS, PULSE);
    const ids = [...svg.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 8);
    assert.equal(new Set(ids).size, 8);
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
