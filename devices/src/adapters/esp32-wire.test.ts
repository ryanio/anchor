/**
 * The wire format, against the rules the firmware has to implement.
 *
 * Three classes of thing are tested here, and only three, because they are the ones that fail
 * silently on hardware rather than loudly in CI:
 *
 * 1. **Byte order and packing.** A swapped RGB565 pair passes every length check and paints the
 *    portfolio in the wrong hue — the same failure `raster.test.ts` guards against for RGB888, and
 *    it is guarded the same way: by asserting the actual bytes, not their count.
 * 2. **What a device is allowed to say.** The parser's refusal of anything but HELLO, INPUT and
 *    PONG is the whole of a display's power over the desktop. A test that only proved the happy
 *    path would be proving nothing about it.
 * 3. **Round trips through the decoder the device runs.** `decodeRle16` is written to the same
 *    rules as the firmware, so encoding and decoding back is a claim about the format rather than
 *    about this file agreeing with itself.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cropRgb565,
  decodeHello,
  decodeInput,
  decodeMessages,
  decodeRle16,
  dirtyTiles,
  encodeBlank,
  encodeBrightness,
  encodeCommit,
  encodeHeader,
  encodeHello,
  encodeInput,
  encodeRle16,
  encodeTile,
  HEADER_BYTES,
  type Hello,
  HOST_BOUND_TYPES,
  MAGIC,
  MAX_PANEL_PIXELS,
  MessageType,
  PixelFormat,
  PROTOCOL_VERSION,
  rgb888ToRgb565,
  sanitiseDeviceId,
  splitRect,
  TileEncoding,
  WireError,
} from "./esp32-wire.ts";

const hello: Hello = {
  version: PROTOCOL_VERSION,
  width: 466,
  height: 466,
  format: PixelFormat.Rgb565Le,
  maxTileBytes: 16384,
  inputs: ["press", "tap", "swipe"],
  deviceId: "pulse-01",
};

/** RGB888 for a list of `[r, g, b]` triples. */
const rgb = (...pixels: readonly (readonly [number, number, number])[]): Buffer => Buffer.from(pixels.flat());

/** An RGB565 buffer of `count` copies of one little-endian pixel value. */
const solid565 = (value: number, count: number): Buffer => {
  const out = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) out.writeUInt16LE(value, index * 2);
  return out;
};

describe("framing", () => {
  test("every message carries the magic byte, its type, a sequence and a length", () => {
    const header = encodeHeader(MessageType.Commit, 7, 0);
    assert.equal(header.length, HEADER_BYTES);
    assert.equal(header.readUInt8(0), MAGIC);
    assert.equal(header.readUInt8(1), MessageType.Commit);
    assert.equal(header.readUInt16LE(2), 7);
    assert.equal(header.readUInt32LE(4), 0);
  });

  test("a partial message is left in the buffer rather than half-parsed", () => {
    const whole = encodeHello(1, hello);
    const { messages, rest } = decodeMessages(whole.subarray(0, whole.length - 4));
    assert.deepEqual(messages, []);
    assert.equal(rest.length, whole.length - 4);
    // The remainder plus its tail parses, which is what a TCP stream actually delivers.
    const completed = decodeMessages(Buffer.concat([rest, whole.subarray(whole.length - 4)]));
    assert.equal(completed.messages.length, 1);
    assert.equal(completed.rest.length, 0);
  });

  test("two messages in one segment both come out", () => {
    const stream = Buffer.concat([
      encodeHello(1, hello),
      encodeInput(2, { kind: "press", slot: "screen:0" }),
    ]);
    const { messages } = decodeMessages(stream);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.type, MessageType.Hello);
    assert.equal(messages[1]?.type, MessageType.Input);
  });

  test("a stream that does not start with the magic byte is refused, not resynchronised", () => {
    assert.throws(() => decodeMessages(Buffer.alloc(HEADER_BYTES, 0x00)), WireError);
  });
});

describe("what a device is allowed to say", () => {
  test("the host-bound set is exactly hello, input and pong", () => {
    assert.deepEqual([...HOST_BOUND_TYPES].sort(), [MessageType.Hello, MessageType.Input, MessageType.Pong]);
  });

  test("a device sending a tile is a protocol error, not a repaint", () => {
    // The point of the whole format: a display cannot paint the host's idea of the panel, cannot
    // address another device through us, and has no opcode that means anything about a wallet.
    const forged = encodeTile(1, { x: 0, y: 0, width: 1, height: 1 }, TileEncoding.Raw, solid565(0, 1));
    assert.throws(() => decodeMessages(forged), WireError);
  });

  for (const [name, message] of [
    ["blank", encodeBlank(1)],
    ["brightness", encodeBrightness(1, 50)],
    ["commit", encodeCommit(1)],
  ] as const) {
    test(`a device sending ${name} is refused`, () => {
      assert.throws(() => decodeMessages(message), WireError);
    });
  }
});

describe("hello", () => {
  test("round-trips the panel a device declares", () => {
    const decoded = decodeHello(encodeHello(1, hello).subarray(HEADER_BYTES));
    assert.deepEqual(decoded, hello);
  });

  test("refuses a panel too big to allocate for", () => {
    // A HELLO is untrusted input and `width * height * 2` is an allocation. Without a ceiling a
    // device claiming 65535x65535 asks the host for gigabytes before a pixel is painted.
    const huge = encodeHello(1, { ...hello, width: 4096, height: 4096 });
    assert.ok(4096 * 4096 > MAX_PANEL_PIXELS);
    assert.throws(() => decodeHello(huge.subarray(HEADER_BYTES)), WireError);
  });

  test("refuses an empty panel and an unknown pixel format", () => {
    assert.throws(
      () => decodeHello(encodeHello(1, { ...hello, width: 0 }).subarray(HEADER_BYTES)),
      WireError,
    );
    const bad = encodeHello(1, hello);
    bad.writeUInt8(9, HEADER_BYTES + 5);
    assert.throws(() => decodeHello(bad.subarray(HEADER_BYTES)), WireError);
  });

  test("a device cannot rewrite the terminal it is logged in", () => {
    // The id lands in a log line and in `--list`. An escape sequence in it is a device editing the
    // output of the machine it is plugged into, so it is sanitised at the decoder, not per caller.
    // Both the escape and the bracket go: the allowed set is what a device id legitimately needs,
    // not everything that happens to be printable.
    assert.equal(sanitiseDeviceId("\u001b[2Jpulse"), "??2Jpulse");
    assert.equal(sanitiseDeviceId(""), "esp32");
    assert.equal(sanitiseDeviceId("a".repeat(200)).length, 64);
  });
});

describe("input", () => {
  test("carries a slot id and two numbers, and nothing else", () => {
    for (const input of [
      { kind: "press", slot: "screen:0" },
      { kind: "release", slot: "screen:0" },
      { kind: "tap", slot: "screen:0", x: 233, y: 400 },
      { kind: "swipe", slot: "screen:0", from: 10, to: 300 },
      { kind: "rotate", slot: "screen:0", delta: -3 },
    ] as const) {
      assert.deepEqual(decodeInput(encodeInput(1, input).subarray(HEADER_BYTES)), input);
    }
  });

  test("a truncated input is an error rather than a zero-valued gesture", () => {
    const message = encodeInput(1, { kind: "tap", slot: "screen:0", x: 1, y: 2 });
    assert.throws(() => decodeInput(message.subarray(HEADER_BYTES, message.length - 2)), WireError);
  });
});

describe("rgb888ToRgb565", () => {
  test("packs 5-6-5 in that order", () => {
    // Not a smoke test: a swapped pair passes a length check and paints the wrong colour.
    assert.deepEqual([...rgb888ToRgb565(rgb([255, 0, 0]))], [0x00, 0xf8]);
    assert.deepEqual([...rgb888ToRgb565(rgb([0, 255, 0]))], [0xe0, 0x07]);
    assert.deepEqual([...rgb888ToRgb565(rgb([0, 0, 255]))], [0x1f, 0x00]);
  });

  test("honours the byte order the device asked for", () => {
    const le = rgb888ToRgb565(rgb([255, 0, 0]), PixelFormat.Rgb565Le);
    const be = rgb888ToRgb565(rgb([255, 0, 0]), PixelFormat.Rgb565Be);
    assert.deepEqual([...be], [...le].reverse());
  });

  test("refuses a buffer that is not whole pixels", () => {
    assert.throws(() => rgb888ToRgb565(Buffer.alloc(5)), WireError);
  });
});

describe("rle16", () => {
  test("a flat tile collapses to almost nothing", () => {
    const flat = solid565(0x1234, 1024);
    const packed = encodeRle16(flat);
    // 1024 pixels is 2,048 bytes raw; eight runs of 128 is 24.
    assert.equal(packed.length, 24);
    assert.deepEqual(decodeRle16(packed, 1024), flat);
  });

  test("noise round-trips and is never catastrophically larger", () => {
    const noisy = Buffer.alloc(512);
    for (let index = 0; index < 256; index++) noisy.writeUInt16LE((index * 7919) & 0xffff, index * 2);
    const packed = encodeRle16(noisy);
    assert.deepEqual(decodeRle16(packed, 256), noisy);
    // PackBits costs one control byte per 128 literals, and no more.
    assert.ok(packed.length <= noisy.length + Math.ceil(256 / 128), `packed to ${packed.length}`);
  });

  test("runs and literals mixed in one tile survive the trip", () => {
    const mixed = Buffer.concat([
      solid565(0xaaaa, 5),
      solid565(0x0001, 1),
      solid565(0x0002, 1),
      solid565(0xbbbb, 200),
    ]);
    assert.deepEqual(decodeRle16(encodeRle16(mixed), 207), mixed);
  });

  test("a stream that does not fill the tile is refused rather than smeared", () => {
    // On the device a short decode is a band of stale pixels under a fresh number.
    assert.throws(() => decodeRle16(encodeRle16(solid565(1, 4)), 8), WireError);
    assert.throws(() => decodeRle16(Buffer.from([0x80]), 1), WireError);
  });
});

describe("dirtyTiles", () => {
  const size = { width: 64, height: 64 };

  test("the first frame is one full-panel rectangle", () => {
    assert.deepEqual(dirtyTiles(null, solid565(0, 64 * 64), size), [{ x: 0, y: 0, width: 64, height: 64 }]);
  });

  test("an unchanged frame sends nothing at all", () => {
    const frame = solid565(0x1234, 64 * 64);
    assert.deepEqual(dirtyTiles(frame, Buffer.from(frame), size), []);
  });

  test("one changed pixel sends one tile, not the panel", () => {
    const before = solid565(0, 64 * 64);
    const after = Buffer.from(before);
    // (40, 40) lands in the tile at (32, 32) on a 32px grid.
    after.writeUInt16LE(0xffff, (40 * 64 + 40) * 2);
    assert.deepEqual(dirtyTiles(before, after, size), [{ x: 32, y: 32, width: 32, height: 32 }]);
  });

  test("adjacent dirty tiles in a row merge into one rectangle", () => {
    // A line of text dirties a whole row of tiles; sending them separately pays a header and a
    // round of the device's bookkeeping for each.
    const before = solid565(0, 64 * 64);
    const after = Buffer.from(before);
    for (let x = 0; x < 64; x++) after.writeUInt16LE(0xffff, (10 * 64 + x) * 2);
    assert.deepEqual(dirtyTiles(before, after, size), [{ x: 0, y: 0, width: 64, height: 32 }]);
  });

  test("refuses a frame that is not the size it was told", () => {
    assert.throws(() => dirtyTiles(null, solid565(0, 10), size), WireError);
  });
});

describe("cropRgb565 and splitRect", () => {
  test("a crop takes the rectangle asked for, row by row", () => {
    const frame = Buffer.alloc(4 * 4 * 2);
    for (let index = 0; index < 16; index++) frame.writeUInt16LE(index, index * 2);
    const crop = cropRgb565(frame, 4, { x: 1, y: 1, width: 2, height: 2 });
    assert.deepEqual(
      [crop.readUInt16LE(0), crop.readUInt16LE(2), crop.readUInt16LE(4), crop.readUInt16LE(6)],
      [5, 6, 9, 10],
    );
  });

  test("a rectangle wider than the device's buffer is split on whole rows", () => {
    const pieces = splitRect({ x: 0, y: 0, width: 466, height: 466 }, 16384);
    // 466 pixels is 932 bytes a row, so 17 rows fit in 16 KB.
    assert.equal(pieces[0]?.height, 17);
    assert.equal(
      pieces.reduce((total, piece) => total + piece.height, 0),
      466,
    );
    for (const piece of pieces) assert.ok(piece.width * piece.height * 2 <= 16384);
  });

  test("a rectangle that already fits is not split", () => {
    const rect = { x: 4, y: 4, width: 32, height: 32 };
    assert.deepEqual(splitRect(rect, 16384), [rect]);
  });
});
