/**
 * Remote artwork, fetched once and cached as a square thumbnail.
 *
 * A portfolio page that shows tickers tells you what you hold; showing the art tells you what you
 * *own*, which is the thing an NFT actually is. So owned pieces are drawn on the keys.
 *
 * Three rules, because this is the one place the panel pulls bytes from the open internet:
 *
 * 1. **https only, with a byte cap and a timeout.** Marketplace metadata is untrusted input
 *    (AGENTS.md), and an image url in it is attacker-influenced. A url that redirects to a
 *    multi-gigabyte file, or to `file://`, must not be followed.
 * 2. **Nothing is executed.** Bytes go to ImageMagick, which re-encodes to a flat JPEG; whatever
 *    the source claimed to be, what reaches the device is pixels.
 * 3. **Cached on disk by url**, so a rotating gallery costs one fetch per piece per machine rather
 *    than one per rotation.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/** Data URIs already in memory, so a repaint costs nothing. */
const memory = new Map<string, string>();

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "anchor", "art");
}

function cachePath(url: string, size: number): string {
  return join(cacheDir(), `${createHash("sha256").update(`${size}|${url}`).digest("hex").slice(0, 32)}.jpg`);
}

/** Square-crop and re-encode to `size`, through the rasteriser already used for everything else. */
function square(input: Buffer, size: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = execFile(
      "magick",
      [
        "-",
        "-auto-orient",
        "-resize",
        `${size}x${size}^`,
        "-gravity",
        "center",
        "-extent",
        `${size}x${size}`,
        "-strip",
        "-quality",
        "82",
        "JPEG:-",
      ],
      { encoding: "buffer", maxBuffer: 1 << 26, timeout: 20000 },
      (error, stdout) => resolve(error ? null : stdout),
    );
    child.stdin?.end(input);
  });
}

/**
 * A still frame from a video, via ffmpeg.
 *
 * NFT media is not always an image: of thirty owned pieces here, twenty are SVG, twenty-three PNG
 * and three are MP4. ImageMagick has no decoder for the last group, so a gallery that only handled
 * images would show gaps where the animated pieces are.
 *
 * The bytes go to a file rather than a pipe because MP4 needs to seek, and a pipe makes ffmpeg
 * guess. Nothing here executes the input; ffmpeg decodes it and emits pixels.
 */
function videoFrame(input: Buffer): Promise<Buffer | null> {
  const scratch = join(
    cacheDir(),
    `frame-${createHash("sha256").update(input.subarray(0, 4096)).digest("hex").slice(0, 16)}.bin`,
  );
  return new Promise((resolve) => {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(scratch, input);
    } catch {
      resolve(null);
      return;
    }
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", scratch, "-frames:v", "1", "-f", "image2", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 1 << 26, timeout: 20000 },
      (error, stdout) => {
        try {
          rmSync(scratch, { force: true });
        } catch {
          // best effort
        }
        resolve(error || stdout.byteLength === 0 ? null : stdout);
      },
    );
  });
}

function toDataUri(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * A square thumbnail of `url` as a data URI, or null when it cannot be had.
 *
 * Null is an ordinary outcome — an unreachable host, a 404, an SVG the rasteriser dislikes — and
 * the caller draws the tile without art rather than failing.
 */
export async function thumbnail(url: string, size = 120): Promise<string | null> {
  const cached = memory.get(`${size}|${url}`);
  if (cached !== undefined) return cached;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const path = cachePath(url, size);
  try {
    const uri = toDataUri(readFileSync(path));
    memory.set(`${size}|${url}`, uri);
    return uri;
  } catch {
    // Not cached yet.
  }

  let bytes: Buffer;
  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: { accept: "image/*" },
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return null;
    const type = response.headers.get("content-type") ?? "";
    // A video is still a picture of something, once a frame is pulled out of it.
    bytes = type.startsWith("video/") ? ((await videoFrame(buffer)) ?? buffer) : buffer;
  } catch {
    return null;
  }

  const jpeg = await square(bytes, size);
  if (jpeg === null) return null;

  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(path, jpeg);
  } catch {
    // A read-only cache costs a refetch next run; not an error.
  }
  const uri = toDataUri(jpeg);
  memory.set(`${size}|${url}`, uri);
  return uri;
}

export function artCacheSize(): number {
  return memory.size;
}

/**
 * The cached thumbnail for `url`, or null.
 *
 * Synchronous on purpose: rendering must never await. A piece appears on the key the first repaint
 * after `prefetch` has it, which is the difference between a gallery that fills in and a panel that
 * stalls on the network.
 */
export function cachedThumbnail(url: string, size = 120): string | null {
  return memory.get(`${size}|${url}`) ?? null;
}

/** Warm the cache, one at a time so a gallery does not open dozens of sockets at once. */
export async function prefetch(urls: readonly string[], size = 120): Promise<void> {
  for (const url of urls) {
    if (cachedThumbnail(url, size) !== null) continue;
    await thumbnail(url, size);
  }
}
