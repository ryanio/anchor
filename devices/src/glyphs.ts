/**
 * Glyph ink metrics, measured through the same rasteriser that draws the panel.
 *
 * Nerd Font symbols sit in a monospace font, so every one of them advances 0.6em — but they *paint*
 * between 0.70em and 1.04em wide. `text-anchor="middle"` centres the advance box, not the ink, so
 * an icon centred that way lands visibly right of centre, by 0.05em to 0.22em depending on the
 * glyph. A single fudge factor cannot fix that because the error is per-glyph.
 *
 * Measured at size 100 on JetBrainsMono Nerd Font, ink left edge at the advance box edge in every
 * case, ink width varying:
 *
 *     U+F186 moon    70px      U+F030 camera  93px
 *     U+F1FC brush   99px      U+F13D anchor 104px
 *
 * So the correction is `size * (0.3 - inkWidthEm / 2)`, and this module supplies `inkWidthEm`.
 *
 * Measuring goes through ImageMagick and fontconfig, exactly as the real render does, which is why
 * the numbers are right rather than merely plausible: if the user runs `omarchy font set` and the
 * monospace alias changes, the measurement changes with it. The cache is therefore keyed on the
 * resolved font file, and a font change simply misses the cache.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Fallback when a glyph has never been measured: assume the advance, i.e. no correction. */
const UNMEASURED = 0.6;

const registry = new Map<string, number>();

export function registerGlyphMetrics(entries: Iterable<readonly [string, number]>): void {
  for (const [glyph, widthEm] of entries) registry.set(glyph, widthEm);
}

export function clearGlyphMetrics(): void {
  registry.clear();
}

/** Ink width in em, or undefined when unmeasured. */
export function inkWidthEm(glyph: string): number | undefined {
  return registry.get(glyph);
}

/**
 * Horizontal correction to add to a centred glyph's x, so its ink lands on the centre.
 * Returns 0 for anything unmeasured, which is the current-behaviour fallback rather than a guess.
 */
export function centerCorrection(glyph: string, fontSize: number): number {
  const width = registry.get(glyph);
  if (width === undefined) return 0;
  return fontSize * (0.3 - width / 2);
}

/**
 * The width an icon cell should reserve, in px, so following text never overlaps the ink.
 *
 * The 0.34em tail is a gap, not a fudge: the ink width is measured exactly, and butting text
 * straight against a measured edge reads as cramped even though nothing overlaps.
 */
export function cellWidth(glyph: string, fontSize: number): number {
  return Math.round(fontSize * (registry.get(glyph) ?? UNMEASURED) + fontSize * 0.34);
}

function resolvedMonospaceFont(): string {
  try {
    return execFileSync("fc-match", ["monospace", "file"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "unknown";
  }
}

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "anchor", "glyph-metrics.json");
}

const REFERENCE_SIZE = 100;

/** Render one glyph alone and trim it, to find how wide the ink actually is. */
function measureOne(glyph: string): Promise<number | null> {
  const size = REFERENCE_SIZE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 4}" height="${size * 2}">` +
    `<rect width="${size * 4}" height="${size * 2}" fill="black"/>` +
    `<text x="${size * 2}" y="${size}" font-family="monospace" font-size="${size}" fill="white" ` +
    `text-anchor="middle" dominant-baseline="central">&#x${glyph.codePointAt(0)?.toString(16)};</text></svg>`;

  return new Promise((resolve) => {
    const child = execFile(
      "magick",
      ["svg:-", "-trim", "-format", "%w", "info:"],
      { encoding: "utf8", timeout: 15000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const width = Number.parseInt(stdout.trim(), 10);
        // A blank render trims to nothing; treat that as unmeasurable rather than as zero width.
        resolve(Number.isFinite(width) && width > 0 ? width / size : null);
      },
    );
    child.stdin?.end(svg);
  });
}

/**
 * Measure every glyph, using a disk cache keyed on the resolved monospace font.
 *
 * Measuring costs one subprocess per glyph and happens once per font per machine. Failures are
 * silent by design: an unmeasured glyph renders exactly as it did before this module existed.
 */
export async function loadGlyphMetrics(glyphs: Iterable<string>): Promise<void> {
  const font = resolvedMonospaceFont();
  const path = cachePath();

  let cache: Record<string, Record<string, number>> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) cache = parsed as typeof cache;
  } catch {
    cache = {};
  }
  const forFont = cache[font] ?? {};

  const wanted = [...new Set([...glyphs].filter((glyph) => glyph !== ""))];
  const missing = wanted.filter((glyph) => typeof forFont[glyph] !== "number");

  for (const glyph of missing) {
    const width = await measureOne(glyph);
    if (width !== null) forFont[glyph] = width;
  }

  registerGlyphMetrics(
    wanted.flatMap((glyph): Array<readonly [string, number]> => {
      const width = forFont[glyph];
      return typeof width === "number" ? [[glyph, width] as const] : [];
    }),
  );

  if (missing.length > 0) {
    cache[font] = forFont;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
    } catch {
      // A read-only cache directory costs a re-measure next run; it is not an error.
    }
  }
}
