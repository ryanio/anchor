/**
 * SVG to raw RGB bytes.
 *
 * `fillKeyBuffer` and `fillLcdRegion` take raw pixels, so the rasteriser is asked for `RGB:-`
 * directly and nothing in this workspace decodes an image format. That is the whole reason this
 * costs no dependency: ImageMagick is already a documented tool in this repo (AGENTS.md uses it to
 * re-encode generated assets), and its SVG coder is RSVG, so text goes through fontconfig and picks
 * up the user's monospace font exactly as the widget does.
 *
 * Renders are cached by SVG source. A panel repaints on every state change, and most tiles are
 * unchanged between frames — without this, a volume nudge would fork eight processes.
 */

import { execFile, execFileSync } from "node:child_process";

export interface RasterSize {
  readonly width: number;
  readonly height: number;
}

export class RasterError extends Error {}

/** One argument list, so the capability probe below renders exactly what a key face does. */
const RENDER_ARGS = [
  "-background",
  "none",
  "svg:-",
  "-alpha",
  "remove",
  "-alpha",
  "off",
  "-depth",
  "8",
  "RGB:-",
];

const CACHE_LIMIT = 256;
const cache = new Map<string, Buffer>();

/** ImageMagick 7 is `magick`; 6 exposes `convert`. Resolved on first use and remembered. */
let binary: string | null = null;

const PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
  '<rect width="1" height="1" fill="#ff0000"/></svg>';

/**
 * Prove a candidate can rasterise, rather than that it exists.
 *
 * `-version` only proves a binary is installed, and installed is not the same as working: Debian's
 * ImageMagick 6 does not rasterise SVG itself, it shells out to `rsvg-convert`. Without librsvg the
 * version check passes and every render fails with ``delegate failed `'rsvg-convert' -o '%o' '%i'``
 * — an error about a delegate, from a machine that looks correctly configured. CI found this the
 * first time it ran these tests.
 *
 * So the probe is a real render of a 1x1 red pixel, and the answer has to be the three bytes that
 * describes. Anything else and the candidate is not a rasteriser as far as this module is concerned.
 */
function canRasterise(candidate: string): boolean {
  try {
    const out = execFileSync(candidate, RENDER_ARGS, {
      input: PROBE_SVG,
      timeout: 10_000,
      maxBuffer: 1 << 16,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.length === 3 && out[0] === 255 && out[1] === 0 && out[2] === 0;
  } catch {
    return false;
  }
}

function resolveBinary(): string {
  if (binary !== null) return binary;
  for (const candidate of ["magick", "convert"]) {
    if (canRasterise(candidate)) {
      binary = candidate;
      return binary;
    }
  }
  throw new RasterError(
    "no working SVG rasteriser: install imagemagick *and* librsvg. ImageMagick 6 delegates SVG to " +
      "`rsvg-convert`, so imagemagick alone passes a version check and then fails every render. " +
      "Devices paint key faces from SVG, so this is required to paint anything.",
  );
}

/** Whether a working rasteriser is present. For tests that need one; never for a paint path. */
export function rasteriserAvailable(): boolean {
  try {
    resolveBinary();
    return true;
  } catch {
    return false;
  }
}

function renderOnce(svg: string, size: RasterSize): Promise<Buffer> {
  const bin = resolveBinary();
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      RENDER_ARGS,
      { encoding: "buffer", maxBuffer: 1 << 26, timeout: 15000 },
      (error, stdout) => {
        if (error) {
          reject(new RasterError(`rasterising ${size.width}x${size.height} failed: ${error.message}`));
          return;
        }
        const expected = size.width * size.height * 3;
        if (stdout.length !== expected) {
          // A short buffer silently paints garbage on the device, so refuse it here where the
          // cause is still legible.
          reject(
            new RasterError(
              `expected ${expected} bytes for ${size.width}x${size.height}, got ${stdout.length}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(svg);
  });
}

/** Rasterise `svg` to `width * height * 3` bytes of RGB. */
export async function rasterize(svg: string, size: RasterSize): Promise<Buffer> {
  // The size belongs in the key. An SVG carries its own intrinsic size, so the same source always
  // rasterises to the same bytes — but keying on the source alone let a caller ask for the wrong
  // size and be handed a cached buffer without the length check ever running. A short buffer paints
  // garbage on the device, and the point of that check is that it cannot be skipped.
  const key = `${size.width}x${size.height}|${svg}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const buffer = await renderOnce(svg, size);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, buffer);
  return buffer;
}

export function clearRasterCache(): void {
  cache.clear();
}

export function rasterCacheSize(): number {
  return cache.size;
}
