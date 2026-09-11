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
import { activeFill, onActive, type Tokens } from "./tokens.ts";
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
 * Truncate from the middle, keeping both ends.
 *
 * For a caption that *names* something, where the qualifier is at the end. `KEY_SOURCES.token`
 * appends the chain to a ticker precisely when the ticker alone is ambiguous — and cutting from the
 * tail then removes the disambiguation and nothing else: two keys of a portfolio holding wstETH on
 * two chains both read `WSTETH·arbit…`, which is worse than either name alone because it looks like
 * an answer. `WSTETH…m-nova` and `WSTETH…hereum` are still two different keys.
 *
 * Not used for prose. A window title is read from the front and `fit` is right for it.
 */
export function fitEnds(text: string, fontSize: number, maxWidth: number): string {
  if (advance(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  let keep = chars.length - 1;
  while (keep > 0 && advance(`${"x".repeat(keep)}…`, fontSize) > maxWidth) keep--;
  // Under four characters there are no two ends to keep, only an ellipsis with a letter each side.
  if (keep < 4) return fit(text, fontSize, maxWidth);
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
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
  if (emphasis === "active") return activeFill(tokens, tone);
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

/**
 * The smallest a mark may be drawn.
 *
 * Below this a monospace glyph is four pixels of ink and reads as texture rather than as a word. It
 * is a floor rather than a scale factor because the failure it prevents is absolute: the Cardputer's
 * tiles are 80x35 and its status bar 18 tall, and every size in here used to be a fraction of that
 * height — which put 4px captions on the tiles and a 4px status bar on a device whose whole point is
 * being read at arm's length. `renderBar` already had the idea in `MIN_LEGIBLE_CHARS`; this is the
 * same judgement about size instead of width.
 */
const MIN_LEGIBLE_PX = 7;

/**
 * A tile's corner radius, from its own short side.
 *
 * Fixed at 14 this was right for a 120px key and turned an 80x35 Cardputer tile into a lozenge — a
 * radius of 40% of the height, which reads as a pill rather than as a key. Capped at 14 so the shape
 * a Stream Deck already ships with does not move.
 */
export function tileRadius(w: number, h: number): number {
  return Math.max(2, Math.min(14, Math.round(Math.min(w, h) * 0.14)));
}

/**
 * The gap a tile leaves inside its own slot.
 *
 * On a Stream Deck this is decoration — the keys are physically separate screens. On a device whose
 * tiles share one framebuffer it is the *only* thing between one tile and the next, so it has to
 * stay proportional to the tile rather than eating a fifth of a 35px one.
 */
export function tileInset(w: number, h: number): number {
  return Math.min(3.5, Math.max(1, Math.round(Math.min(w, h) * 0.1) / 2));
}

function renderTile(surface: Extract<Surface, { kind: "tile" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const tone = toneColor(tokens, surface.tone);
  const active = surface.emphasis === "active";
  // Every mark on an active tile is drawn on the tone rather than on `ground`, so it resolves
  // through `onActive` rather than through the token it would use anywhere else. That indirection
  // is the fix for the bug this had: the old face drew the accent on a tile tinted 30% toward the
  // accent, which measured 2.25:1 on `rose-pine`.
  const mark = onActive(tokens, tone);
  const hasImage = typeof surface.image === "string" && surface.image !== "";
  const inset = tileInset(w, h);
  const radius = tileRadius(w, h);
  const innerW = w - inset * 2;
  const innerH = h - inset * 2;
  const shape = `x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${radius}"`;
  // Everything inside the key is clipped to the key. Marks are placed by fractions of the tile's
  // height, and on a short tile a rounded corner takes a bite out of a rectangle those fractions
  // think is free — the sparkline ran out through the bottom-left corner of an 80x35 tile. Clipping
  // makes that impossible at any size rather than at the sizes someone remembered to check.
  const clipId = `t${slot.id.replace(/[^A-Za-z0-9]/g, "")}`;
  const parts: string[] = [`<rect ${shape} fill="${tileFill(tokens, surface.emphasis, tone)}"/>`];

  const hasMeter = typeof surface.meter === "number";
  const hasValue = typeof surface.value === "string" && surface.value !== "";
  const hasSpark = Array.isArray(surface.spark) && surface.spark.length > 1;
  const hasSlices = Array.isArray(surface.slices) && surface.slices.length > 0;
  // A reading takes the middle of the tile; the icon shrinks to a marker and the label to a caption.
  const iconY = hasValue ? h * 0.2 : hasMeter ? h * 0.29 : h * 0.4;
  // The room a mark leaves to the tile's own edge. Was a flat 7-16px, which is 6% of a 120px key
  // and 40% of a 35px one.
  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  const labelSize = Math.max(MIN_LEGIBLE_PX, Math.round(h * (hasValue ? 0.105 : 0.125)));
  const iconSize = Math.round(hasValue ? h * 0.16 : h * 0.38);
  const sparkTop = h * 0.72;
  const sparkHeight = h * 0.18;
  const meterThickness = Math.max(2, Math.round(h * 0.067));
  const meterY = h - inset - Math.round(h * 0.15) - meterThickness;

  /**
   * Which marks there is actually room for, claimed in priority order.
   *
   * Every position in here is a fraction of the tile's height, tuned on a 120x120 Stream Deck key
   * where they never collide. On an 80x35 Cardputer tile they collide constantly: the reading and
   * its caption overlapped by two pixels and the sparkline ran out through the rounded corner. So a
   * mark that has nowhere to go is *not drawn* rather than drawn through its neighbour — the same
   * judgement `renderBar` makes about a segment with no room and `renderList` about a half row.
   *
   * Data claims first and is never dropped for decoration: the donut and the reading, then the
   * sparkline and the meter, then the icon, then the caption. At 120x120 nothing is dropped, so the
   * face this ships with today does not move.
   *
   * The band is 0.84em rather than the full em: a monospace glyph's ink is about that, and using the
   * advance box would have the tile refusing marks that visibly clear each other.
   */
  const INK = 0.42;
  const claimed: Array<[number, number]> = [];
  const claim = (top: number, bottom: number): boolean => {
    if (top < inset || bottom > h - inset) return false;
    if (claimed.some(([t, b]) => top < b && bottom > t)) return false;
    claimed.push([top, bottom]);
    return true;
  };

  const donutThickness = Math.max(1, Math.round(h * 0.1));
  const donutRadius = h * 0.24;
  const donutCentre = h * 0.44;
  const showSlices =
    hasSlices &&
    claim(donutCentre - donutRadius - donutThickness / 2, donutCentre + donutRadius + donutThickness / 2);

  const valueSize = hasValue
    ? autoSize(
        surface.value ?? "",
        hasSlices ? w * 0.34 : innerW - pad,
        hasSlices ? Math.round(h * 0.15) : Math.round(h * 0.26),
        Math.round(h * 0.09),
      )
    : 0;
  const valueY = hasSlices ? donutCentre : hasSpark ? h * 0.4 : h * 0.47;
  // A reading inside the donut sits in a hole the donut has already claimed, so it is judged on
  // legibility alone. Everywhere else it takes a band of its own.
  const showValue =
    hasValue &&
    valueSize >= MIN_LEGIBLE_PX &&
    (showSlices || claim(valueY - valueSize * INK, valueY + valueSize * INK));

  const showSpark = hasSpark && claim(sparkTop, sparkTop + sparkHeight);
  const showMeter = hasMeter && claim(meterY, meterY + meterThickness);
  const showIcon =
    typeof surface.icon === "string" &&
    surface.icon !== "" &&
    iconSize >= MIN_LEGIBLE_PX &&
    claim(iconY - iconSize * INK, iconY + iconSize * INK);

  // The caption goes under the reading and over whatever is beneath it, clamped into that gap
  // rather than parked at a fraction that only happens to be clear at 120px.
  const labelAbove = Math.max(
    inset,
    showValue && !showSlices ? valueY + valueSize * INK : inset,
    showSlices ? donutCentre + donutRadius + donutThickness / 2 : inset,
  );
  const labelBelow = Math.min(h - inset, showSpark ? sparkTop : h - inset, showMeter ? meterY : h - inset);
  const labelWanted = hasValue ? (hasSpark ? h * 0.64 : h * 0.78) : hasMeter ? h * 0.62 : h * 0.76;
  const labelY = Math.min(Math.max(labelWanted, labelAbove + labelSize * INK), labelBelow - labelSize * INK);
  // No caption over artwork — see the `hasImage` block below.
  const showLabel =
    typeof surface.label === "string" &&
    surface.label !== "" &&
    !hasImage &&
    labelAbove + labelSize * INK * 2 <= labelBelow &&
    claim(labelY - labelSize * INK, labelY + labelSize * INK);

  if (showIcon) {
    // Correct for the glyph's ink sitting right of its advance box; see `glyphs.ts`.
    parts.push(
      text(
        w / 2 + centerCorrection(surface.icon ?? "", iconSize),
        iconY,
        iconSize,
        active ? mark : tokens.ink,
        surface.icon ?? "",
      ),
    );
  }
  if (hasImage) {
    // Clipped to the tile's own radius so the art sits in the key rather than on it, and the whole
    // key goes to the piece: a title over a picture is a label on a painting.
    //
    // That decision lives here rather than in the source that supplies the piece, because it is a
    // decision about *this surface at this size*, and `types.ts` rule 1 is that nothing outside a
    // renderer knows a pixel size. Moving it fixed a real bug too: the source used to blank the
    // piece's name to suppress the caption, so a screen device drawing the same page as a list had
    // rows reading "Key 2" where the gallery should have been.
    parts.push(
      `<image href="${surface.image}" x="${inset}" y="${inset}" width="${innerW}" ` +
        `height="${innerH}" preserveAspectRatio="xMidYMid slice"/>`,
    );
  }

  if (showSlices) {
    // The donut takes the middle; a value, if any, sits inside it.
    parts.push(donut(surface.slices ?? [], tokens, w / 2, donutCentre, donutRadius, donutThickness));
  }

  if (showValue) {
    // Layout from the reading's own shape; colour through `onActive`, so a filled key's text is
    // legible against the fill rather than against the ground it is no longer on.
    parts.push(text(w / 2, valueY, valueSize, active ? mark : tone, surface.value ?? "", true));
  }

  if (showSpark) {
    // Inset by the tile's own padding *and* its inset, so the line stops short of the rounded
    // corner instead of being clipped by it.
    const left = inset + pad;
    parts.push(
      sparkline(surface.spark ?? [], left, sparkTop, w - left * 2, sparkHeight, active ? mark : tone),
    );
  }
  if (showLabel) {
    parts.push(
      text(
        w / 2,
        labelY,
        labelSize,
        // `ink`, not `inkDim`. Measured across every stock theme, a dimmed label on a key comes out
        // at 2.0-3.4:1 against the tile — under the 4.5:1 AA floor `scripts/check-contrast.ts`
        // holds the rest of the project to, and unreadable in practice. `ink` is 6.3:1 or better
        // everywhere, and hierarchy still comes from weight and the icon above it.
        active ? mark : tokens.ink,
        fitEnds(surface.label ?? "", labelSize, innerW - pad),
        active,
      ),
    );
  }

  if (showMeter) {
    const value = Math.min(1, Math.max(0, surface.meter ?? 0));
    const left = pad + inset;
    const right = w - pad - inset;
    parts.push(
      `<rect x="${left}" y="${meterY}" width="${right - left}" height="${meterThickness}" rx="${meterThickness / 2}" fill="${active ? mark : tokens.line}" fill-opacity="${active ? 0.35 : 1}"/>`,
    );
    if (value > 0) {
      parts.push(
        `<rect x="${left}" y="${meterY}" width="${Math.round((right - left) * value)}" height="${meterThickness}" rx="${meterThickness / 2}" fill="${active ? mark : tone}"/>`,
      );
    }
  }
  // There is deliberately no underline on an active key any more. It existed because a 30% tint
  // alone did not read as "on" from across the room; a filled tile does, and the rule on top of it
  // came out as a white bar across a light grey key on `vantablack` — a mark competing with the
  // state it was there to announce.

  if (surface.badge) {
    const r = Math.round(h * 0.11);
    // Offset from the tile's own inner corner, so the badge sits on the key rather than half off it
    // on a tile whose inset is smaller than the 8px this used to assume.
    const offset = inset + pad;
    parts.push(`<circle cx="${w - r - offset}" cy="${r + offset}" r="${r}" fill="${tokens.negative}"/>`);
    parts.push(text(w - r - offset, r + offset, Math.round(r * 1.1), tokens.sunken, surface.badge, true));
  }

  // No boundary stroke: a Stream Deck key is already a physically separate button with a real gap
  // around it, and `tokens.sunken` filling that gap already keeps a dark tile from reading as a
  // hole. A drawn outline on top of a real bezel was decoration duplicating the hardware.
  return (
    `<rect width="${w}" height="${h}" fill="${tokens.sunken}"/>` +
    `<defs><clipPath id="${clipId}"><rect ${shape}/></clipPath></defs>` +
    `<g clip-path="url(#${clipId})">${parts.join("")}</g>`
  );
}

/**
 * Metrics for a status strip, from the strip's own height.
 *
 * Two strips ship and they are nothing like each other: the Stream Deck's is 800x100 and the
 * Cardputer's is 240x18. Every number here used to be a flat fraction of the height tuned on the
 * first of them, which put 4px text and a 5px icon on the second — a status bar nobody could read,
 * on the device whose whole surface is that bar. So the text takes a *half* of a short strip and a
 * fifth of a tall one, and the padding and gaps follow it.
 */
export function barMetrics(h: number): {
  textSize: number;
  iconSize: number;
  edgePad: number;
  gap: number;
  rule: number;
} {
  const textSize = Math.round(Math.min(h * 0.5, Math.max(h * 0.22, MIN_LEGIBLE_PX + 4)));
  return {
    textSize,
    iconSize: Math.min(Math.round(textSize * 1.36), Math.max(MIN_LEGIBLE_PX, h - 4)),
    edgePad: Math.max(4, Math.round(h * 0.22)),
    gap: Math.max(5, Math.round(h * 0.3)),
    rule: Math.max(1, Math.round(h * 0.02)),
  };
}

function renderBar(surface: Extract<Surface, { kind: "bar" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;

  // A hint row sits below the readings, one zone per dial — on the Stream Deck Plus the strip sits
  // *above* the row of dials, so the edge closest to a physical dial is the bottom one, and that is
  // where its caption belongs. Reserved off the bottom rather than a fixed constant, the same
  // discipline `barMetrics` uses, so it still holds on the Cardputer's 18px strip (where
  // `roomForHints` below simply comes out false and the row disappears).
  const hints = surface.hints ?? [];
  const roomForHints = hints.length > 0 && h * 0.28 >= MIN_LEGIBLE_PX + 6;
  const hintH = roomForHints ? Math.round(h * 0.3) : 0;
  const barH = h - hintH;
  const { textSize, iconSize, edgePad, gap, rule } = barMetrics(barH);

  // Laid out before anything is drawn, because two decisions below need to know how much of the
  // strip the readings actually take: whether the wash behind them has any room left to live in, and
  // where each segment starts.
  //
  // A segment needs room to say something. Ellipsising "Catppuccin" down to "Catp…" spends the
  // pixels and communicates nothing, so a segment that cannot fit a legible minimum is dropped
  // instead — the same judgement the list surface makes about a half-drawn row.
  const MIN_LEGIBLE_CHARS = 6;
  const placed: Array<{ x: number; icon?: string; body: string; tone?: TokenName }> = [];
  let x = edgePad;
  for (const segment of surface.segments) {
    const iconRoom = segment.icon ? cellWidth(segment.icon, iconSize) : 0;
    const room = w - x - iconRoom - gap;
    const needed = Math.min(
      advance(segment.text, textSize),
      advance("x".repeat(MIN_LEGIBLE_CHARS), textSize),
    );
    if (room < needed) break;
    const start = x;
    // Each icon reserves its own measured ink width; advancing by the monospace advance alone
    // would run the label straight through the glyph.
    if (segment.icon) x += iconRoom;
    const body = fit(segment.text, textSize, w - x - gap);
    placed.push({ x: start, icon: segment.icon, body, tone: segment.tone });
    // Reserve the segment's declared width so a shorter reading leaves the gap rather than closing
    // it, and its neighbours stay put.
    const reserved = segment.minChars === undefined ? 0 : advance("0".repeat(segment.minChars), textSize);
    x += Math.max(advance(body, textSize), reserved) + gap;
  }

  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`];

  // Behind everything, at low opacity: present when you look for it, invisible when you are reading.
  // Artwork and the net-worth wash are alternatives — a page tells one story behind its readings, not
  // two — so at most one of them ever draws.
  //
  // Only where there is a behind. The wash exists because the deck's strip is 800x100 and the
  // readings use a third of it, so the rest was dead pixels — but on an 18px bar the readings use
  // the whole height, and the same curve is then drawn straight through the glyphs. The test is the
  // strip's own proportions rather than a model name.
  const roomForWash = textSize * 1.2 < barH * 0.5;
  if (roomForWash && Array.isArray(surface.artwork) && surface.artwork.length > 0) {
    // Tiled edge to edge and cropped to the full bar height: a filmstrip of what is actually held,
    // faded enough that the readings on top of it stay the thing you read first.
    const tileW = w / surface.artwork.length;
    const tiles = surface.artwork
      .map(
        (art, i) =>
          `<image href="${art}" x="${i * tileW}" y="0" width="${tileW}" height="${h}" ` +
          `preserveAspectRatio="xMidYMid slice"/>`,
      )
      .join("");
    parts.push(`<g opacity="0.22">${tiles}</g>`);
  } else if (roomForWash && Array.isArray(surface.background) && surface.background.length > 1) {
    parts.push(
      `<g opacity="0.34">${sparkline(surface.background, 0, barH * 0.22, w, barH * 0.72, tokens.accent)}</g>`,
    );
  }

  for (const segment of placed) {
    let at = segment.x;
    if (segment.icon) {
      parts.push(
        `<text x="${at}" y="${barH / 2}" font-family="monospace" font-size="${iconSize}" ` +
          `fill="${toneColor(tokens, segment.tone)}" dominant-baseline="central">${escapeXml(segment.icon)}</text>`,
      );
      at += cellWidth(segment.icon, iconSize);
    }
    parts.push(
      `<text x="${at}" y="${barH / 2}" font-family="monospace" font-size="${textSize}" ` +
        `fill="${tokens.inkStrong}" dominant-baseline="central">${escapeXml(segment.body)}</text>`,
    );
  }

  if (roomForHints) {
    parts.push(`<rect y="${barH}" width="${w}" height="${rule}" fill="${tokens.accent}"/>`);
    // Equal zones across the full width, aligned under where the dials physically sit — a caption
    // read before a hand reaches for the control, not a status read after.
    const zoneW = w / hints.length;
    const hintMidY = barH + hintH / 2;
    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      if (hint === undefined) continue;
      const cx = i * zoneW + zoneW / 2;
      const hintIconSize = Math.max(MIN_LEGIBLE_PX, Math.round(hintH * 0.42));
      const hintTextSize = Math.max(MIN_LEGIBLE_PX, Math.round(hintH * 0.34));
      const label = fit(hint.label, hintTextSize, zoneW - edgePad);
      if (hint.icon) {
        const iconW = cellWidth(hint.icon, hintIconSize);
        const labelW = advance(label, hintTextSize);
        const totalW = iconW + Math.round(hintIconSize * 0.3) + labelW;
        const startX = cx - totalW / 2;
        parts.push(
          `<text x="${startX}" y="${hintMidY}" font-family="monospace" font-size="${hintIconSize}" ` +
            `fill="${tokens.inkDim}" dominant-baseline="central">${escapeXml(hint.icon)}</text>` +
            `<text x="${startX + iconW + Math.round(hintIconSize * 0.3)}" y="${hintMidY}" ` +
            `font-family="monospace" font-size="${hintTextSize}" fill="${tokens.inkDim}" ` +
            `dominant-baseline="central">${escapeXml(label)}</text>`,
        );
      } else {
        parts.push(
          `<text x="${cx}" y="${hintMidY}" font-family="monospace" font-size="${hintTextSize}" ` +
            `fill="${tokens.inkDim}" text-anchor="middle" dominant-baseline="central">${escapeXml(label)}</text>`,
        );
      }
      if (i > 0) {
        parts.push(
          `<line x1="${i * zoneW}" y1="${barH + hintH * 0.22}" x2="${i * zoneW}" y2="${barH + hintH * 0.78}" ` +
            `stroke="${tokens.line}" stroke-width="1"/>`,
        );
      }
    }
  } else {
    // No hint row to sit above, so the rule reverts to a plain top border — the strip's original
    // shape, which every device without dials (Cardputer, ESP32) or without room for the row still
    // uses.
    parts.push(`<rect width="${w}" height="${rule}" fill="${tokens.accent}"/>`);
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
  const fontSize = Math.max(MIN_LEGIBLE_PX, Math.round(rowHeight * 0.52));
  // One padding, used on all four sides. It was `pad` at the sides and `pad / 2` at the top, which
  // is not a considered asymmetry — it is the first row sitting twice as close to the bezel as the
  // text does to the left edge, and on a round panel that row is partly off the glass.
  const pad = Math.round(w * 0.04);

  if (surface.rows.length === 0) {
    const message = surface.empty ?? "nothing to show";
    parts.push(
      `<text x="${w / 2}" y="${h / 2}" font-family="monospace" font-size="${fontSize}" ` +
        `fill="${tokens.inkDim}" text-anchor="middle" dominant-baseline="central">${escapeXml(message)}</text>`,
    );
    return parts.join("");
  }

  const visible = Math.max(1, Math.floor((h - pad * 2) / rowHeight));
  // Keep the selected row on screen by scrolling the window, not by shrinking rows.
  const selected = surface.selected ?? -1;
  const first =
    selected < visible ? 0 : Math.min(selected - visible + 1, Math.max(0, surface.rows.length - visible));

  surface.rows.slice(first, first + visible).forEach((row, offset) => {
    const index = first + offset;
    const top = pad + offset * rowHeight;
    const mid = top + rowHeight / 2;
    const isSelected = index === selected;
    if (isSelected) {
      parts.push(
        `<rect x="${pad / 2}" y="${top}" width="${w - pad}" height="${rowHeight - 2}" rx="${Math.max(2, Math.round(rowHeight * 0.1))}" fill="${tokens.raised}"/>`,
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
        `dominant-baseline="central">${escapeXml(fitEnds(row.label, fontSize, w - x - valueWidth - pad))}</text>`,
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
 * Break `words` into at most `maxLines` lines that each fit `maxWidth`.
 *
 * Returns null when it cannot be done, which is the caller's cue to shrink and ask again rather
 * than to clip. Word-wrapping is the only honest way to keep a sentence whole on a narrow panel:
 * `autoSize` alone bottoms out at its floor and then draws the overflow anyway, which is how the
 * footer came out running off both edges of a 368px screen.
 */
export function wrapText(body: string, size: number, maxWidth: number, maxLines: number): string[] | null {
  const lines: string[] = [];
  let current = "";
  for (const word of body.split(/\s+/).filter((part) => part !== "")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (advance(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    // A single word wider than the line cannot be wrapped, only shrunk.
    if (current === "") return null;
    lines.push(current);
    current = word;
    if (lines.length >= maxLines) return null;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 || lines.length > maxLines ? null : lines;
}

/**
 * One thing, in full.
 *
 * The footer is laid out first and never truncated. It is where a card says that approval happens
 * somewhere else, and a shortened version of that sentence would be worse than no sentence — so it
 * shrinks, and then wraps, and only a sentence that will do neither is dropped.
 *
 * Every size here comes from the panel's *short* side rather than its height. On the 368x448 board
 * this actually runs on, `h * 0.11` was a 49px title on a 368px-wide screen: truncated to three
 * words before it had said anything, with the badge printed over the top of it. Nothing produces
 * this surface yet, which is exactly why none of that had been seen.
 */
function renderDetail(surface: Extract<Surface, { kind: "detail" }>, tokens: Tokens, slot: SlotSpec): string {
  const { width: w, height: h } = slot;
  const short = Math.min(w, h);
  const pad = Math.round(short * 0.06);
  const titleSize = Math.max(MIN_LEGIBLE_PX, Math.round(short * 0.09));
  const lineSize = Math.max(MIN_LEGIBLE_PX, Math.round(short * 0.062));
  const footerSize = Math.max(MIN_LEGIBLE_PX, Math.round(short * 0.05));
  const inner = w - pad * 2;
  const parts: string[] = [];
  const hasArtwork = typeof surface.artwork === "string" && surface.artwork !== "";
  if (hasArtwork) {
    parts.push(
      `<image href="${surface.artwork}" x="0" y="0" width="${w}" height="${h}" ` +
        `preserveAspectRatio="xMidYMid slice"/>`,
    );
    // A flat scrim, not measured per-theme the way `contrast.test.ts` holds every other mark to —
    // there is no fixed contrast ratio against a photo whose content is not known until it arrives.
    // This is the honest limit of that guarantee, not a gap in applying it: strong enough that ink
    // tuned for `ground` reads on top of most art, on a panel whose whole point is showing the art
    // underneath it.
    parts.push(`<rect width="${w}" height="${h}" fill="${tokens.ground}" opacity="0.62"/>`);
  } else {
    parts.push(`<rect width="${w}" height="${h}" fill="${tokens.ground}"/>`);
  }

  let footerTop = h - pad;
  if (surface.footer !== undefined) {
    // Shrink first, then wrap, so the whole sentence survives on a narrow screen.
    let size = footerSize;
    let lines = wrapText(surface.footer, size, inner, 2);
    while (lines === null && size > MIN_LEGIBLE_PX) {
      size--;
      lines = wrapText(surface.footer, size, inner, 2);
    }
    if (lines !== null) {
      const block = lines.length * size * 1.35;
      footerTop = h - pad - block;
      parts.push(
        `<rect x="0" y="${(footerTop - size * 0.5).toFixed(1)}" width="${w}" ` +
          `height="${(h - footerTop + size * 0.5).toFixed(1)}" fill="${tokens.sunken}"/>`,
      );
      lines.forEach((line, index) => {
        parts.push(
          `<text x="${w / 2}" y="${(footerTop + size * 0.7 + index * size * 1.35).toFixed(1)}" ` +
            `font-family="monospace" font-size="${size}" fill="${tokens.inkDim}" text-anchor="middle" ` +
            `dominant-baseline="central">${escapeXml(line)}</text>`,
        );
      });
    }
  }

  // The badge is measured before the title is drawn, so the title's room excludes it. Drawn after
  // it, the badge simply sat on top of the words — and a badge is by definition the thing you put
  // next to a name, so covering the name is the one thing it must not do.
  let titleRoom = inner;
  if (surface.badge !== undefined) {
    const size = Math.max(MIN_LEGIBLE_PX, Math.round(lineSize * 0.85));
    const width = advance(surface.badge, size) + size;
    const height = Math.round(size * 1.8);
    titleRoom = Math.max(advance("…", titleSize), inner - width - pad);
    parts.push(
      `<rect x="${w - pad - width}" y="${pad}" width="${width}" height="${height}" ` +
        `rx="${(height / 2).toFixed(1)}" fill="${tokens.warning}"/>`,
    );
    parts.push(
      `<text x="${w - pad - width / 2}" y="${pad + height / 2}" font-family="monospace" font-size="${size}" ` +
        `font-weight="700" fill="${tokens.sunken}" text-anchor="middle" dominant-baseline="central">` +
        `${escapeXml(surface.badge)}</text>`,
    );
  }

  parts.push(
    `<text x="${pad}" y="${pad + titleSize * 0.6}" font-family="monospace" font-size="${titleSize}" ` +
      `font-weight="700" fill="${tokens.inkStrong}" dominant-baseline="central">` +
      `${escapeXml(fit(surface.title, titleSize, titleRoom))}</text>`,
  );

  // The label column takes what it needs up to 45%, the value column the rest. They used to be
  // given 45% and 50% of the *whole* panel independently, which is 95% plus two paddings — so both
  // sides truncated at once and neither had a reason to.
  const gap = Math.round(pad * 0.8);
  const labelRoom = Math.min(
    Math.round(inner * 0.45),
    Math.max(...surface.lines.map((line) => advance(line.label, lineSize)), 0),
  );
  const valueRoom = inner - labelRoom - gap;

  let y = pad + titleSize * 1.7;
  for (const line of surface.lines) {
    if (y + lineSize > footerTop - lineSize * 0.5) break;
    parts.push(
      `<text x="${pad}" y="${y.toFixed(1)}" font-family="monospace" font-size="${lineSize}" fill="${tokens.inkDim}" ` +
        `dominant-baseline="central">${escapeXml(fit(line.label, lineSize, labelRoom))}</text>`,
    );
    parts.push(
      `<text x="${w - pad}" y="${y.toFixed(1)}" font-family="monospace" font-size="${lineSize}" ` +
        `fill="${line.tone === undefined ? tokens.ink : tokens[line.tone]}" text-anchor="end" ` +
        `dominant-baseline="central">${escapeXml(fit(line.value, lineSize, valueRoom))}</text>`,
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
