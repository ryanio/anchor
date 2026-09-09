/**
 * Surfaces to SVG.
 *
 * SVG is the intermediate form for two reasons. It consumes the token vocabulary directly, so a key
 * face is written in the same language as the rest of the design system rather than in raster
 * drawing calls; and it costs no dependency, because the machine already has a rasteriser (see
 * `raster.ts`).
 *
 * **The font family is `monospace` on purpose.** AGENTS.md is explicit that the family is
 * system-wide and not ours to set: `Style.qml` in the Omarchy shell defaults to `monospace` so every
 * surface follows the fontconfig alias `omarchy font set` writes. A device that named
 * "JetBrainsMono Nerd Font" would be the one surface ignoring the user's font choice. Hierarchy here
 * comes from size, weight and colour within the family — never a second typeface.
 */

import { cellWidth, centerCorrection } from "./glyphs.ts";
import { mix, type Tokens } from "./tokens.ts";
import type { Emphasis, SlotSpec, Surface, TokenName } from "./types.ts";

/**
 * Horizontal advance of `text`, in px.
 *
 * Valid only because the family is monospace: every glyph occupies one cell, and JetBrains Mono —
 * like the DejaVu and Cascadia families a user might switch to — advances 0.6em per cell. This is
 * layout arithmetic, not measurement, so anything relying on it must tolerate being a pixel or two
 * out. Nothing here is centred by it; it only decides where the next segment starts.
 */
export function advance(text: string, fontSize: number): number {
  return Math.round([...text].length * fontSize * 0.6);
}

/** XML-escape. Labels can carry marketplace text, which AGENTS.md treats as data, never markup. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Truncate to fit a pixel width, with an ellipsis when it does not. */
export function fit(text: string, fontSize: number, maxWidth: number): string {
  if (advance(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 0 && advance(`${chars.join("")}…`, fontSize) > maxWidth) chars.pop();
  return chars.length > 0 ? `${chars.join("")}…` : "";
}

/**
 * The largest size at or below `maxSize` at which `text` fits `maxWidth`.
 *
 * A portfolio total is not a fixed width — "$412" and "$1,204,880.55" land on the same key — so a
 * fixed size either wastes the tile or overflows it. Shrinking beats truncating here: the last
 * digits of a number are not optional the way the tail of a window title is.
 */
export function autoSize(text: string, maxWidth: number, maxSize: number, minSize: number): number {
  for (let size = maxSize; size > minSize; size--) {
    if (advance(text, size) <= maxWidth) return size;
  }
  return minSize;
}

function tileFill(tokens: Tokens, emphasis: Emphasis, tone: string): string {
  if (emphasis === "active") return mix(tokens.ground, tone, 0.3);
  if (emphasis === "raised") return tokens.raised;
  return tokens.ground;
}

function toneColor(tokens: Tokens, name: TokenName | undefined): string {
  return name === undefined ? tokens.accent : tokens[name];
}

function text(x: number, y: number, size: number, fill: string, body: string, bold = false): string {
  const weight = bold ? ' font-weight="700"' : "";
  return (
    `<text x="${x}" y="${y}" font-family="monospace" font-size="${size}"${weight} fill="${fill}" ` +
    `text-anchor="middle" dominant-baseline="central">${escapeXml(body)}</text>`
  );
}

/**
 * A sparkline: the series scaled to its own range, not to zero.
 *
 * Anchoring at zero would render every real portfolio move as a flat line near the top. The range
 * is the series' own min and max, so the shape shows the movement that actually happened; a flat
 * series draws a centred line rather than dividing by zero.
 */
function sparkline(
  points: readonly number[],
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): string {
  if (points.length < 2) return "";
  const low = Math.min(...points);
  const high = Math.max(...points);
  const span = high - low;
  const at = (value: number): number => (span === 0 ? y + h / 2 : y + h - ((value - low) / span) * h);
  const step = w / (points.length - 1);
  const coords = points.map((value, index) => `${(x + index * step).toFixed(1)},${at(value).toFixed(1)}`);
  const area = `${x},${y + h} ${coords.join(" ")} ${x + w},${y + h}`;
  return (
    `<polygon points="${area}" fill="${color}" fill-opacity="0.18"/>` +
    `<polyline points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="2" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>`
  );
}

/** A donut. Proportions only — no legend, because a 120px key has no room to lie in. */
function donut(
  slices: readonly { value: number; tone?: TokenName }[],
  tokens: Tokens,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
): string {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  if (total <= 0)
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${tokens.line}" stroke-width="${thickness}"/>`;

  const palette: TokenName[] = ["accent", "positive", "warning", "negative", "inkDim"];
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const parts = [
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${tokens.line}" stroke-width="${thickness}"/>`,
  ];
  slices.forEach((slice, index) => {
    const fraction = Math.max(0, slice.value) / total;
    if (fraction <= 0) return;
    const length = fraction * circumference;
    const color = tokens[slice.tone ?? palette[index % palette.length] ?? "accent"];
    // Dash one arc per slice and rotate it into place; simpler than arc paths and exact.
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${thickness}" ` +
        `stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    );
    offset += length;
  });
  return parts.join("");
}

function renderTile(surface: Extract<Surface, { kind: "tile" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const tone = toneColor(tokens, surface.tone);
  const active = surface.emphasis === "active";
  // A hairline edge gives the tile a defined boundary against the gap, which is what stops a dark
  // key reading as a hole. Active keys take the accent for it, so the state is legible from the
  // shape of the key and not only from its fill.
  const edge = active ? tone : tokens.line;
  const parts: string[] = [
    `<rect width="${w}" height="${h}" fill="${tokens.sunken}"/>`,
    `<rect x="3.5" y="3.5" width="${w - 7}" height="${h - 7}" rx="14" fill="${tileFill(tokens, surface.emphasis, tone)}" stroke="${edge}" stroke-width="1"/>`,
  ];

  const hasMeter = typeof surface.meter === "number";
  const hasValue = typeof surface.value === "string" && surface.value !== "";
  const hasSpark = Array.isArray(surface.spark) && surface.spark.length > 1;
  const hasSlices = Array.isArray(surface.slices) && surface.slices.length > 0;
  // A reading takes the middle of the tile; the icon shrinks to a marker and the label to a caption.
  const iconY = hasValue ? h * 0.2 : hasMeter ? h * 0.29 : h * 0.4;
  const labelY = hasSpark ? h * 0.64 : hasValue ? h * 0.78 : hasMeter ? h * 0.62 : h * 0.76;

  if (surface.icon) {
    const iconSize = Math.round(hasValue ? h * 0.16 : h * 0.38);
    // Correct for the glyph's ink sitting right of its advance box; see `glyphs.ts`.
    parts.push(
      text(
        w / 2 + centerCorrection(surface.icon, iconSize),
        iconY,
        iconSize,
        active ? tone : tokens.ink,
        surface.icon,
      ),
    );
  }
  if (hasSlices) {
    // The donut takes the middle; a value, if any, sits inside it.
    parts.push(donut(surface.slices ?? [], tokens, w / 2, h * 0.44, h * 0.24, Math.round(h * 0.1)));
  }

  if (hasValue) {
    const value = surface.value ?? "";
    const maxSize = hasSlices ? Math.round(h * 0.15) : Math.round(h * 0.26);
    const width = hasSlices ? w * 0.34 : w - 14;
    const size = autoSize(value, width, maxSize, Math.round(h * 0.09));
    parts.push(text(w / 2, hasSlices ? h * 0.44 : hasSpark ? h * 0.4 : h * 0.47, size, tone, value, true));
  }

  if (hasSpark) {
    parts.push(sparkline(surface.spark ?? [], 12, h * 0.72, w - 24, h * 0.18, tone));
  }
  if (surface.label) {
    const size = Math.round(h * (hasValue ? 0.105 : 0.125));
    parts.push(
      text(
        w / 2,
        labelY,
        size,
        // `ink`, not `inkDim`. Measured across every stock theme, a dimmed label on a key comes out
        // at 2.0-3.4:1 against the tile — under the 4.5:1 AA floor `scripts/check-contrast.ts`
        // holds the rest of the project to, and unreadable in practice. `ink` is 6.3:1 or better
        // everywhere, and hierarchy still comes from weight and the icon above it.
        active ? tokens.inkStrong : tokens.ink,
        fit(surface.label, size, w - 16),
        active,
      ),
    );
  }

  if (hasMeter) {
    const value = Math.min(1, Math.max(0, surface.meter ?? 0));
    const left = 16;
    const right = w - 16;
    const y = h - 26;
    parts.push(
      `<rect x="${left}" y="${y}" width="${right - left}" height="8" rx="4" fill="${tokens.line}"/>`,
    );
    if (value > 0) {
      parts.push(
        `<rect x="${left}" y="${y}" width="${Math.round((right - left) * value)}" height="8" rx="4" fill="${tone}"/>`,
      );
    }
  } else if (active) {
    // A bottom rule reads as "on" from across the room, where a tint alone does not.
    parts.push(`<rect x="24" y="${h - 13}" width="${w - 49}" height="4" rx="2" fill="${tone}"/>`);
  }

  if (surface.badge) {
    const r = Math.round(h * 0.11);
    parts.push(`<circle cx="${w - r - 8}" cy="${r + 8}" r="${r}" fill="${tokens.negative}"/>`);
    parts.push(text(w - r - 8, r + 8, Math.round(r * 1.1), tokens.sunken, surface.badge, true));
  }

  return parts.join("");
}

function renderBar(surface: Extract<Surface, { kind: "bar" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const iconSize = Math.round(h * 0.3);
  const textSize = Math.round(h * 0.22);
  const parts: string[] = [
    `<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`,
    `<rect width="${w}" height="2" fill="${tokens.accent}"/>`,
  ];

  // A segment needs room to say something. Ellipsising "Catppuccin" down to "Catp…" spends the
  // pixels and communicates nothing, so a segment that cannot fit a legible minimum is dropped
  // instead — the same judgement the list surface makes about a half-drawn row.
  const MIN_LEGIBLE_CHARS = 6;
  let x = 22;
  for (const segment of surface.segments) {
    const iconRoom = segment.icon ? cellWidth(segment.icon, iconSize) : 0;
    const room = w - x - iconRoom - 30;
    const needed = Math.min(
      advance(segment.text, textSize),
      advance("x".repeat(MIN_LEGIBLE_CHARS), textSize),
    );
    if (room < needed) break;
    if (segment.icon) {
      parts.push(
        `<text x="${x}" y="${h / 2}" font-family="monospace" font-size="${iconSize}" ` +
          `fill="${toneColor(tokens, segment.tone)}" dominant-baseline="central">${escapeXml(segment.icon)}</text>`,
      );
      // Each icon reserves its own measured ink width; advancing by the monospace advance alone
      // would run the label straight through the glyph.
      x += cellWidth(segment.icon, iconSize);
    }
    const body = fit(segment.text, textSize, w - x - 30);
    parts.push(
      `<text x="${x}" y="${h / 2}" font-family="monospace" font-size="${textSize}" fill="${tokens.inkStrong}" ` +
        `dominant-baseline="central">${escapeXml(body)}</text>`,
    );
    // Reserve the segment's declared width so a shorter reading leaves the gap rather than closing
    // it, and its neighbours stay put.
    const reserved = segment.minChars === undefined ? 0 : advance("0".repeat(segment.minChars), textSize);
    x += Math.max(advance(body, textSize), reserved) + 30;
  }
  return parts.join("");
}

/**
 * Rows on a screen.
 *
 * Row height is derived from the slot rather than fixed, so the same surface fills a 135px Cardputer
 * screen and a 466px round panel without either being told about the other. Rows past the bottom are
 * dropped rather than squeezed: a half-legible row is worse than an absent one, and the panel owns
 * selection so it can scroll rather than relying on the device to.
 */
function renderList(surface: Extract<Surface, { kind: "list" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`];

  const rowHeight = Math.max(18, Math.round(h * 0.14));
  const fontSize = Math.round(rowHeight * 0.52);
  const pad = Math.round(w * 0.04);

  if (surface.rows.length === 0) {
    const message = surface.empty ?? "nothing to show";
    parts.push(
      `<text x="${w / 2}" y="${h / 2}" font-family="monospace" font-size="${fontSize}" ` +
        `fill="${tokens.inkDim}" text-anchor="middle" dominant-baseline="central">${escapeXml(message)}</text>`,
    );
    return parts.join("");
  }

  const visible = Math.max(1, Math.floor((h - pad) / rowHeight));
  // Keep the selected row on screen by scrolling the window, not by shrinking rows.
  const selected = surface.selected ?? -1;
  const first =
    selected < visible ? 0 : Math.min(selected - visible + 1, Math.max(0, surface.rows.length - visible));

  surface.rows.slice(first, first + visible).forEach((row, offset) => {
    const index = first + offset;
    const top = pad / 2 + offset * rowHeight;
    const mid = top + rowHeight / 2;
    const isSelected = index === selected;
    if (isSelected) {
      parts.push(
        `<rect x="${pad / 2}" y="${top}" width="${w - pad}" height="${rowHeight - 2}" rx="4" fill="${tokens.raised}"/>`,
      );
    }
    const ink = isSelected ? tokens.inkStrong : tokens.ink;
    let x = pad;
    if (row.icon) {
      parts.push(
        `<text x="${x}" y="${mid}" font-family="monospace" font-size="${fontSize}" ` +
          `fill="${row.tone === undefined ? tokens.accent : tokens[row.tone]}" ` +
          `dominant-baseline="central">${escapeXml(row.icon)}</text>`,
      );
      x += cellWidth(row.icon, fontSize);
    }
    const valueWidth = row.value === undefined ? 0 : advance(row.value, fontSize) + pad;
    parts.push(
      `<text x="${x}" y="${mid}" font-family="monospace" font-size="${fontSize}" fill="${ink}" ` +
        `dominant-baseline="central">${escapeXml(fit(row.label, fontSize, w - x - valueWidth - pad))}</text>`,
    );
    if (row.value !== undefined) {
      parts.push(
        `<text x="${w - pad}" y="${mid}" font-family="monospace" font-size="${fontSize}" ` +
          `fill="${row.tone === undefined ? ink : tokens[row.tone]}" text-anchor="end" ` +
          `dominant-baseline="central">${escapeXml(row.value)}</text>`,
      );
    }
  });
  return parts.join("");
}

/**
 * One thing, in full.
 *
 * The footer is laid out first and never truncated. It is where a card says that approval happens
 * somewhere else, and a shortened version of that sentence would be worse than no sentence.
 */
function renderDetail(surface: Extract<Surface, { kind: "detail" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const pad = Math.round(w * 0.05);
  const titleSize = Math.round(h * 0.11);
  const lineSize = Math.round(h * 0.08);
  const footerSize = Math.round(h * 0.07);
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`];

  let footerTop = h - pad;
  if (surface.footer !== undefined) {
    // Shrink rather than clip, so the whole sentence survives on a narrow screen.
    const size = autoSize(surface.footer, w - pad * 2, footerSize, Math.round(footerSize * 0.6));
    footerTop = h - pad - size;
    parts.push(
      `<rect x="0" y="${footerTop - size * 0.4}" width="${w}" height="${h - footerTop + size * 0.4}" fill="${tokens.sunken}"/>`,
    );
    parts.push(
      `<text x="${w / 2}" y="${footerTop + size * 0.2}" font-family="monospace" font-size="${size}" ` +
        `fill="${tokens.inkDim}" text-anchor="middle" dominant-baseline="central">${escapeXml(surface.footer)}</text>`,
    );
  }

  parts.push(
    `<text x="${pad}" y="${pad + titleSize * 0.6}" font-family="monospace" font-size="${titleSize}" ` +
      `font-weight="700" fill="${tokens.inkStrong}" dominant-baseline="central">` +
      `${escapeXml(fit(surface.title, titleSize, w - pad * 2))}</text>`,
  );

  if (surface.badge !== undefined) {
    const size = Math.round(lineSize * 0.85);
    const width = advance(surface.badge, size) + size;
    parts.push(
      `<rect x="${w - pad - width}" y="${pad * 0.6}" width="${width}" height="${size * 1.8}" rx="${size * 0.5}" fill="${tokens.warning}"/>`,
    );
    parts.push(
      `<text x="${w - pad - width / 2}" y="${pad * 0.6 + size * 0.9}" font-family="monospace" font-size="${size}" ` +
        `font-weight="700" fill="${tokens.sunken}" text-anchor="middle" dominant-baseline="central">` +
        `${escapeXml(surface.badge)}</text>`,
    );
  }

  let y = pad + titleSize * 1.6;
  for (const line of surface.lines) {
    if (y + lineSize > footerTop - lineSize * 0.5) break;
    parts.push(
      `<text x="${pad}" y="${y}" font-family="monospace" font-size="${lineSize}" fill="${tokens.inkDim}" ` +
        `dominant-baseline="central">${escapeXml(fit(line.label, lineSize, w * 0.45))}</text>`,
    );
    parts.push(
      `<text x="${w - pad}" y="${y}" font-family="monospace" font-size="${lineSize}" ` +
        `fill="${line.tone === undefined ? tokens.ink : tokens[line.tone]}" text-anchor="end" ` +
        `dominant-baseline="central">${escapeXml(fit(line.value, lineSize, w * 0.5))}</text>`,
    );
    y += lineSize * 1.6;
  }
  return parts.join("");
}

/** Render one surface for one slot. Returns a complete standalone SVG document. */
export function toSvg(surface: Surface, tokens: Tokens, slot: SlotSpec): string {
  let body: string;
  switch (surface.kind) {
    case "tile":
      body = renderTile(surface, tokens, slot);
      break;
    case "bar":
      body = renderBar(surface, tokens, slot);
      break;
    case "list":
      body = renderList(surface, tokens, slot);
      break;
    default:
      body = renderDetail(surface, tokens, slot);
      break;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${slot.width}" height="${slot.height}" ` +
    `viewBox="0 0 ${slot.width} ${slot.height}">${body}</svg>`
  );
}
