/**
 * Compose a frame into a single PNG, laid out like the physical device.
 *
 * This exists because of a rule in AGENTS.md: do not ship a visual change you have only reasoned
 * about. Every visual bug in this project so far was invisible in the source and obvious on screen,
 * and a device is worse than a screen for this — the person changing the code often cannot see the
 * hardware, and hardware cannot be screenshotted. A preview makes a key face reviewable in a diff,
 * in CI, and by an agent with no device attached.
 *
 * The composite is one SVG with the slot SVGs nested at offsets, rasterised in a single pass, so it
 * shows exactly the same source the device is sent rather than a re-drawing of it.
 *
 * **Two layouts, because there are two kinds of device.** A Stream Deck's keys are physically
 * separate screens with plastic between them, so the preview arranges them on a grid with a gap. A
 * Cardputer or an ESP32 pulse display is *one* framebuffer that the adapter carves into slots, and
 * on those the gap is a lie: it hides whether a tile runs into the status bar, and it puts the
 * Cardputer's status strip at the bottom when the device draws it at the top. Such a device hands
 * its own `rects` over and the preview honours them exactly, bezel included.
 */

import { execFile } from "node:child_process";
import { toSvg } from "./svg.ts";
import type { Tokens } from "./tokens.ts";
import type { Frame, SlotSpec } from "./types.ts";

const GAP = 12;
const MARGIN = 20;

export interface PreviewLayout {
  readonly width: number;
  readonly height: number;
  readonly svg: string;
}

/** Where a slot sits on a device that owns a single framebuffer. Matches the adapter's own map. */
export interface PreviewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PreviewOptions {
  /** Keys per row, for a device whose keys are physically separate. */
  readonly columns?: number;
  /**
   * The device's own slot geometry, for a device with one screen.
   *
   * Supplied by the adapter that owns it (`slotRects` in `cardputer.ts`) rather than derived here,
   * so the preview cannot drift from what the firmware is actually sent.
   */
  readonly rects?: ReadonlyMap<string, PreviewRect>;
}

/** Nest a slot's own SVG document inside the composite at an offset. */
function place(x: number, y: number, body: string): string {
  return `<g transform="translate(${x}, ${y})">${body.replace(/^<svg[^>]*>/, "<svg>")}</g>`;
}

/**
 * Lay a single-framebuffer device out exactly as its adapter addresses it.
 *
 * The panel's own edge is drawn, because on these devices "does this run into the bezel" is a real
 * question and a preview floating on an unbounded ground cannot answer it.
 */
function composeRects(
  frame: Frame,
  tokens: Tokens,
  slots: readonly SlotSpec[],
  rects: ReadonlyMap<string, PreviewRect>,
): PreviewLayout {
  let panelWidth = 0;
  let panelHeight = 0;
  for (const rect of rects.values()) {
    panelWidth = Math.max(panelWidth, rect.x + rect.w);
    panelHeight = Math.max(panelHeight, rect.y + rect.h);
  }

  const parts: string[] = [];
  for (const slot of slots) {
    if (!slot.paintable) continue;
    const rect = rects.get(slot.id);
    const surface = frame.get(slot.id);
    if (rect === undefined || surface === undefined) continue;
    parts.push(place(MARGIN + rect.x, MARGIN + rect.y, toSvg(surface, tokens, slot)));
  }

  const width = panelWidth + MARGIN * 2;
  const height = panelHeight + MARGIN * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${tokens.sunken}"/>` +
    // The panel's own rectangle, so an unpainted slot reads as a dark region of the screen rather
    // than as a hole in the page. A blanked device is entirely this, which is the point of showing
    // it: "nothing is visible" is the state the lock is supposed to produce.
    `<rect x="${MARGIN}" y="${MARGIN}" width="${panelWidth}" height="${panelHeight}" fill="${tokens.ground}"/>` +
    parts.join("") +
    `<rect x="${MARGIN - 0.5}" y="${MARGIN - 0.5}" width="${panelWidth + 1}" height="${panelHeight + 1}" ` +
    `fill="none" stroke="${tokens.line}" stroke-width="1"/>` +
    "</svg>";
  return { width, height, svg };
}

/** Lay out paintable slots: keys on a grid, strips full width beneath them. */
export function composeSvg(
  frame: Frame,
  tokens: Tokens,
  slots: readonly SlotSpec[],
  options: PreviewOptions = {},
): PreviewLayout {
  if (options.rects !== undefined) return composeRects(frame, tokens, slots, options.rects);

  const columns = options.columns ?? 4;
  const keys = slots.filter((slot) => slot.paintable && slot.kind === "key");
  const strips = slots.filter((slot) => slot.paintable && slot.kind !== "key");

  const keyWidth = keys[0]?.width ?? 120;
  const keyHeight = keys[0]?.height ?? 120;
  const rows = Math.ceil(keys.length / columns);
  const gridWidth = rows === 0 ? 0 : columns * keyWidth + (columns - 1) * GAP;
  const stripWidth = Math.max(...strips.map((s) => s.width), 0);
  const width = Math.max(gridWidth, stripWidth) + MARGIN * 2;

  const parts: string[] = [];
  let y = MARGIN;

  const gridLeft = MARGIN + Math.max(0, (width - MARGIN * 2 - gridWidth) / 2);
  keys.forEach((slot, index) => {
    const surface = frame.get(slot.id);
    if (surface === undefined) return;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = gridLeft + column * (slot.width + GAP);
    const top = y + row * (slot.height + GAP);
    parts.push(place(x, top, toSvg(surface, tokens, slot)));
  });
  // Guarded, because `(rows - 1) * GAP` on a device with no keys at all subtracts a gap from the
  // top margin — which is how the ESP32 preview came out with 32px above the panel and 20 below.
  let placed = rows > 0;
  if (rows > 0) y += rows * keyHeight + (rows - 1) * GAP;

  // Space is reserved for every paintable slot, whether or not this frame fills it. A blanked
  // device paints nothing at all, and a blank picture that is also a different *shape* from the
  // painted one is useless for the thing a review does with it — flipping between the two.
  for (const slot of strips) {
    if (placed) y += GAP * 2;
    const surface = frame.get(slot.id);
    if (surface !== undefined) {
      const x = MARGIN + Math.max(0, (width - MARGIN * 2 - slot.width) / 2);
      parts.push(place(x, y, toSvg(surface, tokens, slot)));
    }
    y += slot.height;
    placed = true;
  }

  const height = y + MARGIN;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${tokens.sunken}"/>${parts.join("")}</svg>`;
  return { width, height, svg };
}

/** Write the composed frame to `path` as a PNG. */
export function writePreview(layout: PreviewLayout, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "magick",
      ["-background", "none", "svg:-", "-alpha", "remove", "-alpha", "off", `PNG24:${path}`],
      { timeout: 20000 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end(layout.svg);
  });
}
