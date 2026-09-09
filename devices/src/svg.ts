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

function renderTile(surface: Extract<Surface, { kind: "tile" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const tone = toneColor(tokens, surface.tone);
  const active = surface.emphasis === "active";
  const parts: string[] = [
    `<rect width="${w}" height="${h}" fill="${tokens.sunken}"/>`,
    `<rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="14" fill="${tileFill(tokens, surface.emphasis, tone)}"/>`,
  ];

  const hasMeter = typeof surface.meter === "number";
  const iconY = hasMeter ? h * 0.29 : h * 0.4;
  const labelY = hasMeter ? h * 0.62 : h * 0.76;

  if (surface.icon) {
    parts.push(text(w / 2, iconY, Math.round(h * 0.38), active ? tone : tokens.ink, surface.icon));
  }
  if (surface.label) {
    const size = Math.round(h * 0.125);
    parts.push(
      text(
        w / 2,
        labelY,
        size,
        active ? tokens.inkStrong : tokens.inkDim,
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
  // Nerd Font symbols keep the monospace advance but paint wider than it, so an icon gets its own
  // cell rather than being advanced past. Measured: advance 24px against 47px of ink at size 40.
  const iconCell = Math.round(iconSize * 1.35);
  const parts: string[] = [
    `<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`,
    `<rect width="${w}" height="2" fill="${tokens.accent}"/>`,
  ];

  let x = 22;
  for (const segment of surface.segments) {
    if (x > w - 60) break;
    if (segment.icon) {
      parts.push(
        `<text x="${x}" y="${h / 2}" font-family="monospace" font-size="${iconSize}" ` +
          `fill="${toneColor(tokens, segment.tone)}" dominant-baseline="central">${escapeXml(segment.icon)}</text>`,
      );
      x += iconCell;
    }
    const body = fit(segment.text, textSize, w - x - 30);
    parts.push(
      `<text x="${x}" y="${h / 2}" font-family="monospace" font-size="${textSize}" fill="${tokens.inkStrong}" ` +
        `dominant-baseline="central">${escapeXml(body)}</text>`,
    );
    x += advance(body, textSize) + 30;
  }
  return parts.join("");
}

/** Render one surface for one slot. Returns a complete standalone SVG document. */
export function toSvg(surface: Surface, tokens: Tokens, slot: SlotSpec): string {
  const body = surface.kind === "tile" ? renderTile(surface, tokens, slot) : renderBar(surface, tokens, slot);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${slot.width}" height="${slot.height}" ` +
    `viewBox="0 0 ${slot.width} ${slot.height}">${body}</svg>`
  );
}
