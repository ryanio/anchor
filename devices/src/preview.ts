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

/** Lay out paintable slots: keys on a grid, strips full width beneath them. */
export function composeSvg(
  frame: Frame,
  tokens: Tokens,
  slots: readonly SlotSpec[],
  columns = 4,
): PreviewLayout {
  const keys = slots.filter((slot) => slot.paintable && slot.kind === "key");
  const strips = slots.filter((slot) => slot.paintable && slot.kind !== "key");

  const keyWidth = keys[0]?.width ?? 120;
  const keyHeight = keys[0]?.height ?? 120;
  const rows = Math.ceil(keys.length / columns);
  const gridWidth = columns * keyWidth + (columns - 1) * GAP;
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
    parts.push(
      `<g transform="translate(${x}, ${top})">${toSvg(surface, tokens, slot).replace(/^<svg[^>]*>/, "<svg>")}</g>`,
    );
  });
  y += rows * keyHeight + (rows - 1) * GAP;

  for (const slot of strips) {
    const surface = frame.get(slot.id);
    if (surface === undefined) continue;
    y += GAP * 2;
    const x = MARGIN + Math.max(0, (width - MARGIN * 2 - slot.width) / 2);
    parts.push(
      `<g transform="translate(${x}, ${y})">${toSvg(surface, tokens, slot).replace(/^<svg[^>]*>/, "<svg>")}</g>`,
    );
    y += slot.height;
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
