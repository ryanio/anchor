/**
 * The Anchor Pulse wire protocol, and the pixel work that feeds it.
 *
 * Split out from `esp32.ts` on purpose: everything here is a pure function over bytes, so the
 * format can be tested exhaustively with no socket, no hardware and no rasteriser. The firmware
 * decoder is the other half of this file's contract — `decodeRle16` exists so a test can prove the
 * encoder against the same rules the device implements, rather than against itself.
 *
 * **The vocabulary is deliberately small, and deliberately incapable.** Every message is either
 * geometry and pixels going out, or a slot id and two numbers coming back. There is no opcode, no
 * field and no string for a signature, a key, an address, an amount or an approval, and
 * `HOST_BOUND_TYPES` refuses anything a device sends that is not one of the three things a device
 * is allowed to say. That is invariant 1 in AGENTS.md expressed as a parser: a display on a desk is
 * the least trustworthy requester in the system, so it is given no way to ask for anything.
 *
 * Byte order: the wire is little-endian throughout, matching both hosts and the ESP32. Pixels are
 * the exception — the *device* declares in its HELLO whether it wants RGB565 low byte or high byte
 * first, because most ESP32 QSPI panel drivers want the high byte first and a byte swap over
 * 434,312 bytes is work the host can simply not create.
 */

import type { DeviceInput, InputKind } from "../types.ts";

export class WireError extends Error {}

/** Bumped when a field moves. A device announcing another major version is refused, not coerced. */
export const PROTOCOL_VERSION = 1;

/** First byte of every message. Cheap resynchronisation, and a cheap rejection of stray traffic. */
export const MAGIC = 0xa5;

/** `[magic][type][seq u16][length u32]`. */
export const HEADER_BYTES = 8;

/**
 * The largest payload either side will accept. A device that announces a panel needing more than
 * this is refused at HELLO rather than allocated for — see `MAX_PANEL_PIXELS`.
 */
export const MAX_PAYLOAD = 1 << 20;

export const MessageType = {
  /** device → host: I exist, here is my panel. */
  Hello: 0x01,
  /** host → device: accepted; here is your brightness and how long silence may last. */
  Ready: 0x02,
  /** host → device: a rectangle of pixels. Several may precede one Commit. */
  Tile: 0x10,
  /** host → device: present everything since the last Commit, atomically. */
  Commit: 0x11,
  /** host → device: backlight, 0-100. */
  Brightness: 0x12,
  /** host → device: clear to ground and forget the frame. Sent on session lock. */
  Blank: 0x13,
  /** device → host: a press, a tap, a turn. */
  Input: 0x20,
  Ping: 0x30,
  Pong: 0x31,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/**
 * What the host will parse from a device, and nothing else.
 *
 * A device cannot send a Tile, so it cannot paint the host's idea of the panel; it cannot send a
 * Ready, so it cannot talk to another device through us. This set is the whole attack surface a
 * compromised display has against the desktop.
 */
export const HOST_BOUND_TYPES: ReadonlySet<number> = new Set([
  MessageType.Hello,
  MessageType.Input,
  MessageType.Pong,
]);

/** Pixel formats a panel may ask for. Both are RGB565; they differ only in byte order. */
export const PixelFormat = { Rgb565Le: 0, Rgb565Be: 1 } as const;
export type PixelFormatValue = (typeof PixelFormat)[keyof typeof PixelFormat];

/** Tile payload encodings. `Raw` is always legal; `Rle16` is only sent when it is smaller. */
export const TileEncoding = { Raw: 0, Rle16: 1 } as const;
export type TileEncodingValue = (typeof TileEncoding)[keyof typeof TileEncoding];

/**
 * A ceiling on what a HELLO may claim, in pixels.
 *
 * 1024x1024 is four times the largest panel in `PANELS` and far beyond anything an ESP32 drives.
 * The number is not the point; having one is. A HELLO is data from an untrusted device, and
 * `width * height * 2` is an allocation — a device claiming 65535x65535 would ask the host for
 * 8 GB before a single pixel was painted.
 */
export const MAX_PANEL_PIXELS = 1024 * 1024;

/** Input kinds a device may claim, in HELLO bit order. */
const INPUT_BITS: readonly InputKind[] = ["press", "release", "rotate", "tap", "swipe"];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Hello {
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly format: PixelFormatValue;
  /** Largest tile payload the device will buffer, in bytes. The host splits to fit. */
  readonly maxTileBytes: number;
  readonly inputs: readonly InputKind[];
  readonly deviceId: string;
}

export interface Ready {
  readonly version: number;
  readonly brightness: number;
  /** How often the host promises to speak. The device uses it to notice silence. */
  readonly keepaliveMs: number;
  /**
   * How long the device may keep showing a frame before it must mark it stale.
   *
   * This is the protocol's one opinion about meaning, and it is here rather than in the firmware
   * because it is a claim about *our* data, not about the display. `docs/security.md`: a stale
   * floor price shown as current is a bug.
   */
  readonly staleAfterMs: number;
}

export type WireMessage =
  | { readonly type: typeof MessageType.Hello; readonly seq: number; readonly hello: Hello }
  | { readonly type: typeof MessageType.Input; readonly seq: number; readonly input: DeviceInput }
  | { readonly type: typeof MessageType.Pong; readonly seq: number };

/* -------------------------------------------------------------------------- framing ----------- */

export function encodeHeader(type: number, seq: number, length: number): Buffer {
  if (length > MAX_PAYLOAD) throw new WireError(`payload ${length} exceeds ${MAX_PAYLOAD}`);
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt8(MAGIC, 0);
  header.writeUInt8(type, 1);
  header.writeUInt16LE(seq & 0xffff, 2);
  header.writeUInt32LE(length, 4);
  return header;
}

function message(type: number, seq: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeHeader(type, seq, payload.length), payload]);
}

/* -------------------------------------------------------------- host → device messages -------- */

export function encodeReady(seq: number, ready: Ready): Buffer {
  const payload = Buffer.allocUnsafe(6);
  payload.writeUInt8(ready.version, 0);
  payload.writeUInt8(Math.min(100, Math.max(0, Math.round(ready.brightness))), 1);
  payload.writeUInt16LE(ready.keepaliveMs, 2);
  payload.writeUInt16LE(ready.staleAfterMs, 4);
  return message(MessageType.Ready, seq, payload);
}

/** `[x][y][w][h][encoding][pixels]`. `pixels` is already in the device's declared byte order. */
export function encodeTile(seq: number, rect: Rect, encoding: TileEncodingValue, pixels: Buffer): Buffer {
  const head = Buffer.allocUnsafe(9);
  head.writeUInt16LE(rect.x, 0);
  head.writeUInt16LE(rect.y, 2);
  head.writeUInt16LE(rect.width, 4);
  head.writeUInt16LE(rect.height, 6);
  head.writeUInt8(encoding, 8);
  return message(MessageType.Tile, seq, Buffer.concat([head, pixels]));
}

export function encodeCommit(seq: number): Buffer {
  return message(MessageType.Commit, seq, Buffer.alloc(0));
}

export function encodeBrightness(seq: number, percent: number): Buffer {
  const payload = Buffer.allocUnsafe(1);
  payload.writeUInt8(Math.min(100, Math.max(0, Math.round(percent))), 0);
  return message(MessageType.Brightness, seq, payload);
}

export function encodeBlank(seq: number): Buffer {
  return message(MessageType.Blank, seq, Buffer.alloc(0));
}

export function encodePing(seq: number): Buffer {
  return message(MessageType.Ping, seq, Buffer.alloc(0));
}

/* -------------------------------------------------------------- device → host messages -------- */

/**
 * Encode a HELLO. The host never sends one; this exists so tests and the virtual link can stand in
 * for a device, which is the only way any of this is exercised without hardware.
 */
export function encodeHello(seq: number, hello: Hello): Buffer {
  const id = Buffer.from(hello.deviceId, "utf8");
  if (id.length > 255) throw new WireError("device id longer than 255 bytes");
  let mask = 0;
  for (const [bit, kind] of INPUT_BITS.entries()) if (hello.inputs.includes(kind)) mask |= 1 << bit;
  const payload = Buffer.allocUnsafe(10 + id.length);
  payload.writeUInt8(hello.version, 0);
  payload.writeUInt16LE(hello.width, 1);
  payload.writeUInt16LE(hello.height, 3);
  payload.writeUInt8(hello.format, 5);
  payload.writeUInt16LE(hello.maxTileBytes, 6);
  payload.writeUInt8(mask, 8);
  payload.writeUInt8(id.length, 9);
  id.copy(payload, 10);
  return message(MessageType.Hello, seq, payload);
}

/**
 * A device id is printed in log lines and in `--list` output, so it is sanitised here rather than
 * at each call site. Anything outside a conservative ASCII set becomes `?`: a device that names
 * itself with an ANSI escape must not be able to rewrite the terminal of the machine it is
 * plugged into. AGENTS.md treats untrusted content as data, and a device is untrusted content.
 */
export function sanitiseDeviceId(raw: string): string {
  const cleaned = [...raw.slice(0, 64)]
    .map((char) => (/[A-Za-z0-9 ._:-]/.test(char) ? char : "?"))
    .join("")
    .trim();
  return cleaned === "" ? "esp32" : cleaned;
}

export function decodeHello(payload: Buffer): Hello {
  if (payload.length < 10) throw new WireError("hello is too short");
  const idLength = payload.readUInt8(9);
  if (payload.length < 10 + idLength) throw new WireError("hello claims an id it did not send");
  const width = payload.readUInt16LE(1);
  const height = payload.readUInt16LE(3);
  if (width === 0 || height === 0) throw new WireError("hello declares an empty panel");
  if (width * height > MAX_PANEL_PIXELS) {
    throw new WireError(`hello declares ${width}x${height}, beyond the ${MAX_PANEL_PIXELS}px ceiling`);
  }
  const format = payload.readUInt8(5);
  if (format !== PixelFormat.Rgb565Le && format !== PixelFormat.Rgb565Be) {
    throw new WireError(`unknown pixel format ${format}`);
  }
  const mask = payload.readUInt8(8);
  const inputs = INPUT_BITS.filter((_kind, bit) => (mask & (1 << bit)) !== 0);
  return {
    version: payload.readUInt8(0),
    width,
    height,
    format,
    // A device asking for one-pixel tiles would make the host issue 200,000 writes; a floor keeps
    // the split loop honest without letting the device dictate an unbounded buffer either.
    maxTileBytes: Math.min(MAX_PAYLOAD, Math.max(1024, payload.readUInt16LE(6))),
    inputs,
    deviceId: sanitiseDeviceId(payload.subarray(10, 10 + idLength).toString("utf8")),
  };
}

/** `[kind][slotLen][slot][a i16][b i16]`. `a`/`b` are x/y, from/to, or delta and an unused zero. */
export function encodeInput(seq: number, input: DeviceInput): Buffer {
  const bit = INPUT_BITS.indexOf(input.kind);
  if (bit === -1) throw new WireError(`unknown input kind ${input.kind}`);
  const slot = Buffer.from(input.slot, "utf8");
  if (slot.length > 255) throw new WireError("slot id longer than 255 bytes");
  const payload = Buffer.allocUnsafe(6 + slot.length);
  payload.writeUInt8(bit, 0);
  payload.writeUInt8(slot.length, 1);
  slot.copy(payload, 2);
  const a = input.kind === "tap" ? input.x : input.kind === "swipe" ? input.from : 0;
  const b = input.kind === "tap" ? input.y : input.kind === "swipe" ? input.to : 0;
  payload.writeInt16LE(input.kind === "rotate" ? input.delta : a, 2 + slot.length);
  payload.writeInt16LE(b, 4 + slot.length);
  return message(MessageType.Input, seq, payload);
}

export function decodeInput(payload: Buffer): DeviceInput {
  if (payload.length < 6) throw new WireError("input is too short");
  const kind = INPUT_BITS[payload.readUInt8(0)];
  if (kind === undefined) throw new WireError(`unknown input kind ${payload.readUInt8(0)}`);
  const slotLength = payload.readUInt8(1);
  if (payload.length < 6 + slotLength) throw new WireError("input claims a slot it did not send");
  const slot = sanitiseDeviceId(payload.subarray(2, 2 + slotLength).toString("utf8"));
  const a = payload.readInt16LE(2 + slotLength);
  const b = payload.readInt16LE(4 + slotLength);
  switch (kind) {
    case "press":
      return { kind: "press", slot };
    case "release":
      return { kind: "release", slot };
    case "rotate":
      return { kind: "rotate", slot, delta: a };
    case "tap":
      return { kind: "tap", slot, x: a, y: b };
    default:
      return { kind: "swipe", slot, from: a, to: b };
  }
}

/**
 * Pull whole messages off a stream, returning what is left.
 *
 * `allowed` is passed in rather than assumed, so the host parser can be given `HOST_BOUND_TYPES`
 * and a firmware-side test can be given the other direction. An out-of-set type is an error and
 * not a skip: a peer sending something it has no business sending is a peer to hang up on.
 */
export function decodeMessages(
  buffer: Buffer,
  allowed: ReadonlySet<number> = HOST_BOUND_TYPES,
): { messages: WireMessage[]; rest: Buffer } {
  const messages: WireMessage[] = [];
  let offset = 0;
  while (buffer.length - offset >= HEADER_BYTES) {
    if (buffer.readUInt8(offset) !== MAGIC) throw new WireError("stream is out of frame");
    const type = buffer.readUInt8(offset + 1);
    const seq = buffer.readUInt16LE(offset + 2);
    const length = buffer.readUInt32LE(offset + 4);
    if (length > MAX_PAYLOAD) throw new WireError(`payload ${length} exceeds ${MAX_PAYLOAD}`);
    if (buffer.length - offset - HEADER_BYTES < length) break;
    if (!allowed.has(type)) throw new WireError(`peer sent message type 0x${type.toString(16)}`);
    const payload = buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
    if (type === MessageType.Hello)
      messages.push({ type: MessageType.Hello, seq, hello: decodeHello(payload) });
    else if (type === MessageType.Input)
      messages.push({ type: MessageType.Input, seq, input: decodeInput(payload) });
    else messages.push({ type: MessageType.Pong, seq });
    offset += HEADER_BYTES + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/* --------------------------------------------------------------------------- pixels ----------- */

/**
 * RGB888 (what `raster.ts` produces) to RGB565, in the byte order the device asked for.
 *
 * Truncation, not dithering. The surfaces this paints are flat fills and text at two or three
 * weights; there is no gradient to band. The one place it shows is the accent tint behind an active
 * tile, and 5 bits of blue is finer than the difference between two Omarchy themes.
 */
export function rgb888ToRgb565(rgb: Buffer, format: PixelFormatValue = PixelFormat.Rgb565Le): Buffer {
  if (rgb.length % 3 !== 0) throw new WireError(`RGB buffer of ${rgb.length} bytes is not whole pixels`);
  const out = Buffer.allocUnsafe((rgb.length / 3) * 2);
  for (let index = 0, at = 0; index < rgb.length; index += 3, at += 2) {
    const packed =
      ((rgb.readUInt8(index) & 0xf8) << 8) |
      ((rgb.readUInt8(index + 1) & 0xfc) << 3) |
      (rgb.readUInt8(index + 2) >> 3);
    if (format === PixelFormat.Rgb565Be) out.writeUInt16BE(packed, at);
    else out.writeUInt16LE(packed, at);
  }
  return out;
}

/**
 * PackBits over 16-bit pixels.
 *
 * A control byte with the high bit set is a run: `(n & 0x7f) + 1` copies of the pixel that follows.
 * Clear, and it is a literal: `n + 1` pixels follow verbatim. Worst case is one extra byte per 128
 * pixels, and the caller sends raw whenever this comes out no smaller, so the encoding can never
 * cost more than one byte of header.
 *
 * Chosen because Anchor's surfaces are mostly one colour. Nothing here is general-purpose
 * compression: the point is that a tile of flat ground collapses, and `zlib` — which the device
 * would then need to inflate — is not worth a dependency-free encoder's weight in firmware.
 */
export function encodeRle16(pixels: Buffer): Buffer {
  if (pixels.length % 2 !== 0) throw new WireError("RLE input is not whole 16-bit pixels");
  const count = pixels.length / 2;
  const out: number[] = [];
  let index = 0;
  while (index < count) {
    let run = 1;
    while (
      run < 128 &&
      index + run < count &&
      pixels.readUInt16LE(2 * (index + run)) === pixels.readUInt16LE(2 * index)
    ) {
      run++;
    }
    if (run >= 2) {
      out.push(0x80 | (run - 1), pixels.readUInt8(2 * index), pixels.readUInt8(2 * index + 1));
      index += run;
      continue;
    }
    // A literal run ends where a run of two or more begins, which is the rule the decoder mirrors.
    let literal = 1;
    while (
      literal < 128 &&
      index + literal < count &&
      pixels.readUInt16LE(2 * (index + literal)) !== pixels.readUInt16LE(2 * (index + literal - 1))
    ) {
      literal++;
    }
    out.push(literal - 1);
    for (let at = 0; at < literal; at++) {
      out.push(pixels.readUInt8(2 * (index + at)), pixels.readUInt8(2 * (index + at) + 1));
    }
    index += literal;
  }
  return Buffer.from(out);
}

/**
 * The decoder the firmware implements, written here so a test can prove the encoder against the
 * rules rather than against itself. `expectedPixels` is the tile's `width * height`; a stream that
 * does not produce exactly that many is a corrupt tile, and on the device it would be a smear.
 */
export function decodeRle16(encoded: Buffer, expectedPixels: number): Buffer {
  const out = Buffer.allocUnsafe(expectedPixels * 2);
  let read = 0;
  let written = 0;
  while (read < encoded.length) {
    const control = encoded.readUInt8(read++);
    if ((control & 0x80) !== 0) {
      const run = (control & 0x7f) + 1;
      if (read + 2 > encoded.length) throw new WireError("RLE run without a pixel");
      const pixel = encoded.readUInt16LE(read);
      read += 2;
      for (let at = 0; at < run; at++) {
        if (written >= expectedPixels) throw new WireError("RLE produced more pixels than the tile holds");
        out.writeUInt16LE(pixel, 2 * written++);
      }
    } else {
      const literal = control + 1;
      if (read + 2 * literal > encoded.length) throw new WireError("RLE literal runs off the end");
      for (let at = 0; at < literal; at++) {
        if (written >= expectedPixels) throw new WireError("RLE produced more pixels than the tile holds");
        out.writeUInt16LE(encoded.readUInt16LE(read), 2 * written++);
        read += 2;
      }
    }
  }
  if (written !== expectedPixels) throw new WireError(`RLE produced ${written} of ${expectedPixels} pixels`);
  return out;
}

/**
 * Which parts of the panel changed, as rectangles aligned to a `tile` grid.
 *
 * This is what makes shipping pixels affordable. A portfolio pulse changes one number a second; the
 * frame is a quarter of a megabyte and the number is a few thousand pixels of it. Without this the
 * link carries the whole panel every tick, and with it an idle display carries nothing at all —
 * the same property that makes the Stream Deck adapter do no USB traffic when nothing moves.
 *
 * Horizontally adjacent dirty tiles are merged into one rectangle, because a message costs a header
 * and a round of the device's tile bookkeeping, and a line of text dirties a whole row of them.
 */
export function dirtyTiles(
  previous: Buffer | null,
  next: Buffer,
  size: { readonly width: number; readonly height: number },
  tile = 32,
): Rect[] {
  const { width, height } = size;
  if (next.length !== width * height * 2) {
    throw new WireError(`frame is ${next.length} bytes, expected ${width * height * 2}`);
  }
  if (previous === null || previous.length !== next.length) return [{ x: 0, y: 0, width, height }];

  const rects: Rect[] = [];
  for (let top = 0; top < height; top += tile) {
    const rowHeight = Math.min(tile, height - top);
    let runStart: number | null = null;
    for (let left = 0; left <= width; left += tile) {
      const columnWidth = Math.min(tile, width - left);
      const changed = left < width && !sameRegion(previous, next, width, left, top, columnWidth, rowHeight);
      if (changed && runStart === null) runStart = left;
      if (!changed && runStart !== null) {
        rects.push({ x: runStart, y: top, width: left - runStart, height: rowHeight });
        runStart = null;
      }
    }
  }
  return rects;
}

function sameRegion(
  a: Buffer,
  b: Buffer,
  width: number,
  left: number,
  top: number,
  columnWidth: number,
  rowHeight: number,
): boolean {
  for (let row = 0; row < rowHeight; row++) {
    const start = ((top + row) * width + left) * 2;
    const end = start + columnWidth * 2;
    if (a.compare(b, start, end, start, end) !== 0) return false;
  }
  return true;
}

/** Copy a rectangle out of a full-panel RGB565 buffer. */
export function cropRgb565(frame: Buffer, frameWidth: number, rect: Rect): Buffer {
  const out = Buffer.allocUnsafe(rect.width * rect.height * 2);
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * frameWidth + rect.x) * 2;
    frame.copy(out, row * rect.width * 2, start, start + rect.width * 2);
  }
  return out;
}

/**
 * Split a rectangle into strips no larger than `maxBytes`, on whole rows.
 *
 * A device declares how much it will buffer; a full-width band of a 466px panel is 1,864 bytes a
 * row, so a 16 KB buffer takes eight rows at a time. Splitting on rows rather than arbitrarily
 * keeps every tile a rectangle the device can blit without arithmetic.
 */
export function splitRect(rect: Rect, maxBytes: number): Rect[] {
  const rowBytes = rect.width * 2;
  const rowsPerTile = Math.max(1, Math.floor(maxBytes / rowBytes));
  if (rowsPerTile >= rect.height) return [rect];
  const out: Rect[] = [];
  for (let top = 0; top < rect.height; top += rowsPerTile) {
    out.push({
      x: rect.x,
      y: rect.y + top,
      width: rect.width,
      height: Math.min(rowsPerTile, rect.height - top),
    });
  }
  return out;
}
