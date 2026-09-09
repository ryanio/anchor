/**
 * What a preview promises about the device it is a preview of.
 *
 * A composite that lies is worse than no composite: the whole reason this exists is that hardware
 * cannot be screenshotted, so the picture *is* the evidence. Two lies had to be found by looking —
 * the ESP32 panel floating with twelve more pixels above it than below, and the Cardputer laid out
 * on a grid with imaginary plastic between tiles and its status bar moved to the bottom.
 *
 * Nothing here rasterises; these are assertions about the composed SVG's own geometry.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { composeSvg, type PreviewRect } from "./preview.ts";
import { deviceTokens } from "./tokens.ts";
import type { Frame, SlotSpec, Surface } from "./types.ts";

const TOKENS = deviceTokens("test", {});
const TILE: Surface = { kind: "tile", emphasis: "ground", label: "x" };

const keys = (count: number, size = 120): SlotSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `key:${index}`,
    kind: "key" as const,
    paintable: true,
    width: size,
    height: size,
  }));

const STRIP: SlotSpec = { id: "strip:0", kind: "strip", paintable: true, width: 800, height: 100 };
const SCREEN: SlotSpec = { id: "screen:0", kind: "screen", paintable: true, width: 368, height: 448 };

const filled = (slots: readonly SlotSpec[]): Frame =>
  new Map<string, Surface>(
    slots.map((slot) => [slot.id, slot.kind === "key" ? TILE : { kind: "bar", segments: [] }]),
  );

describe("the key-grid layout", () => {
  test("a Stream Deck + is as wide as its strip and as tall as its rows plus the strip", () => {
    const slots = [...keys(8), STRIP];
    const layout = composeSvg(filled(slots), TOKENS, slots, { columns: 4 });
    assert.equal(layout.width, 800 + 40);
    // 20 margin, two 120 rows with a 12 gap, 24 before the strip, the strip, 20 margin.
    assert.equal(layout.height, 20 + 120 * 2 + 12 + 24 + 100 + 20);
  });

  test("a blank frame is the same size as a painted one", () => {
    // A blanked device is the review's picture of the lock working, and it is looked at by flipping
    // between it and the live frame. A blank that is also a different shape cannot be compared.
    const slots = [...keys(8), STRIP];
    const painted = composeSvg(filled(slots), TOKENS, slots, { columns: 4 });
    const blank = composeSvg(new Map(), TOKENS, slots, { columns: 4 });
    assert.equal(blank.width, painted.width);
    assert.equal(blank.height, painted.height);
  });

  test("a device with no keys at all keeps its margins", () => {
    // `(rows - 1) * gap` subtracted a gap from the top margin when there were no rows, so the ESP32
    // preview came out with 32px above the panel and 20 below. Nothing in the source said so.
    const layout = composeSvg(filled([SCREEN]), TOKENS, [SCREEN]);
    assert.equal(layout.height, 448 + 40);
    assert.equal(layout.width, 368 + 40);
  });
});

describe("the framebuffer layout", () => {
  // The shape a Cardputer actually has: a status strip across the top, tiles butted under it.
  const rects = new Map<string, PreviewRect>([
    ["strip:0", { x: 0, y: 0, w: 240, h: 18 }],
    ["key:0", { x: 0, y: 18, w: 80, h: 35 }],
    ["key:1", { x: 80, y: 18, w: 80, h: 35 }],
  ]);
  const slots: SlotSpec[] = [
    { id: "strip:0", kind: "strip", paintable: true, width: 240, height: 18 },
    { id: "key:0", kind: "key", paintable: true, width: 80, height: 35 },
    { id: "key:1", kind: "key", paintable: true, width: 80, height: 35 },
  ];

  test("is the size of the panel the adapter describes, not of a grid", () => {
    const layout = composeSvg(filled(slots), TOKENS, slots, { rects });
    assert.equal(layout.width, 240 + 40);
    assert.equal(layout.height, 53 + 40);
  });

  test("puts every slot where the adapter puts it", () => {
    const layout = composeSvg(filled(slots), TOKENS, slots, { rects });
    // Margin plus the adapter's own offsets. The strip is at the top, which the generic grid would
    // have moved to the bottom — the one thing a Cardputer preview must not get wrong.
    assert.ok(layout.svg.includes("translate(20, 20)"), "the status strip is not at the top");
    assert.ok(layout.svg.includes("translate(20, 38)"));
    assert.ok(layout.svg.includes("translate(100, 38)"));
  });

  test("draws the panel edge, so a mark against the bezel is visible as one", () => {
    const layout = composeSvg(filled(slots), TOKENS, slots, { rects });
    assert.ok(layout.svg.includes(`stroke="${TOKENS.line}"`));
  });
});
