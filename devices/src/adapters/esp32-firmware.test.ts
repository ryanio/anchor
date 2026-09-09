/**
 * The host encoder against the firmware decoder — two implementations, one format.
 *
 * `esp32-wire.test.ts` proves the encoder against `decodeRle16`, which lives in the same file it is
 * testing. That is worth having and it is not the same claim: an encoder checked against its own
 * decoder agrees with itself, which it would still do if both had read the length field one byte
 * off. AGENTS.md is explicit that a control which cannot be made to fail is not evidence, and the
 * control here is a *second* implementation, in another language, that will be compiled unchanged
 * for the microcontroller — `devices/firmware/esp32/src/anchor_pulse.c`.
 *
 * So this test paints real surfaces through the real `Esp32PulseDevice`, pipes the bytes it emits
 * into the firmware decoder as a subprocess, and compares that framebuffer with the pixels the host
 * believes it painted. The negative cases matter as much: a flipped byte must produce a different
 * picture, a tile that overruns the panel must be refused, and a message type the device is not
 * allowed to receive must end the stream.
 *
 * It compiles C with `cc`. Where there is no compiler the whole suite skips rather than passing
 * quietly, because a green tick from a test that did not run is the exact failure AGENTS.md warns
 * about under "check the instrument, not just the reading".
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rasteriserAvailable, rasterize } from "../raster.ts";
import { toSvg } from "../svg.ts";
import { toTokens } from "../tokens.ts";
import type { Frame, SlotSpec, Surface } from "../types.ts";
import { attach, type Esp32PulseDevice, MemoryLink, SCREEN_SLOT } from "./esp32.ts";
import {
  encodeHello,
  encodeTile,
  type Hello,
  MessageType,
  PixelFormat,
  PROTOCOL_VERSION,
  rgb888ToRgb565,
  TileEncoding,
} from "./esp32-wire.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRMWARE = join(HERE, "..", "..", "firmware", "esp32");

const tokens = toTokens("Tokyo Night", {
  mode: "dark",
  accent: "#7aa2f7",
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  bright_foreground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  green: "#9ece6a",
  selection: "#292e42",
  muted: "#414868",
});

/**
 * Big-endian on purpose.
 *
 * Most ESP32 panel drivers want RGB565 high byte first, which is why HELLO carries a byte order at
 * all — the host packs to it so the device never spends a pass swapping a framebuffer. A decoder
 * that quietly assumed little-endian would pass every existing test and paint colour-shifted
 * garbage on the desk, so this is the order the cross-check uses.
 */
const HELLO: Hello = {
  version: PROTOCOL_VERSION,
  width: 128,
  height: 128,
  format: PixelFormat.Rgb565Be,
  // The floor `decodeHello` clamps to, and small enough that a full frame is split into many
  // tiles — so the split-on-whole-rows arithmetic is exercised rather than assumed.
  maxTileBytes: 1024,
  inputs: ["tap"],
  deviceId: "pulse-conformance",
};

/** The buffer the device promises in HELLO, plus the 9-byte tile head that precedes the pixels. */
const TILE_CAPACITY = HELLO.maxTileBytes + 9;

const SLOT: SlotSpec = {
  id: SCREEN_SLOT,
  kind: "screen",
  paintable: true,
  width: HELLO.width,
  height: HELLO.height,
};

const frameFor = (surface: Surface): Frame => new Map([[SCREEN_SLOT, surface]]);

async function connect(): Promise<{ link: MemoryLink; device: Esp32PulseDevice }> {
  const link = new MemoryLink();
  const attached = attach(link, tokens);
  link.receive(encodeHello(1, HELLO));
  const device = await attached;
  return { link, device };
}

/**
 * What the panel should be holding, computed here rather than read out of the device.
 *
 * The device's framebuffer is private, and comparing against it would only prove the adapter
 * agrees with itself. This walks the same three public steps a paint does — surface to SVG, SVG to
 * RGB888, RGB888 to the device's declared RGB565 — so the expectation is independent of everything
 * the wire format does with it.
 */
async function expectedPixels(surface: Surface): Promise<Buffer> {
  const rgb = await rasterize(toSvg(surface, tokens, SLOT), { width: SLOT.width, height: SLOT.height });
  return rgb888ToRgb565(rgb, HELLO.format);
}

let workdir: string | null = null;
let binary: string | null = null;

function compilerAvailable(): boolean {
  const probe = spawnSync("cc", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

interface Run {
  readonly status: number;
  readonly events: string[];
  readonly framebuffer: Buffer;
  readonly fromDevice: Buffer;
}

/**
 * Feed bytes to the firmware decoder.
 *
 * `chunk` defaults to one byte at a time: a message is then split at every possible offset,
 * including the middle of a header and the middle of a run-length pair. That is not a contrived
 * case — a USB CDC endpoint hands over 64 bytes at a time and TCP segments wherever it likes — and
 * a decoder that only works on whole messages works only in a test.
 */
function feed(bytes: Buffer, chunk = 1): Run {
  const dir = workdir;
  const exe = binary;
  assert.ok(dir !== null && exe !== null, "firmware was compiled");
  const fbPath = join(dir, "fb.bin");
  const devPath = join(dir, "device.bin");
  const result = spawnSync(
    exe,
    [String(HELLO.width), String(HELLO.height), String(TILE_CAPACITY), fbPath, devPath, String(chunk)],
    { input: bytes, maxBuffer: 1 << 26 },
  );
  const stdout = result.stdout.toString("utf8");
  return {
    status: result.status ?? -1,
    events: stdout.split("\n").filter((line) => line !== ""),
    framebuffer: readFileSync(fbPath),
    fromDevice: readFileSync(devPath),
  };
}

describe("firmware conformance", { skip: !compilerAvailable() || !rasteriserAvailable() }, () => {
  before(() => {
    workdir = mkdtempSync(join(tmpdir(), "anchor-pulse-"));
    binary = join(workdir, "conformance");
    // -Werror on purpose: the firmware compiles clean or this test says so. It is the only place
    // the C is built at all until someone has an ESP-IDF toolchain installed.
    execFileSync(
      "cc",
      [
        "-std=c99",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        `-I${join(FIRMWARE, "src")}`,
        "-o",
        binary,
        join(FIRMWARE, "host", "conformance.c"),
        join(FIRMWARE, "src", "anchor_pulse.c"),
      ],
      { stdio: "pipe" },
    );
  });

  after(() => {
    if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
  });

  test("the firmware reconstructs, pixel for pixel, the frame the host painted", async () => {
    const { link, device } = await connect();
    const surface: Surface = { kind: "tile", emphasis: "ground", label: "anchor", value: "1.42" };
    await device.paint(frameFor(surface));

    const run = feed(link.written());

    assert.equal(run.status, 0, `decoder faulted: ${run.events.join(", ")}`);
    assert.ok(run.events.includes("fault 0"), `expected a clean stream, got ${JSON.stringify(run.events)}`);
    assert.ok(run.events.includes("commit 1"), "the frame was presented exactly once");
    // READY carries the adapter's defaults; the firmware must read them off the wire, not guess.
    assert.ok(
      run.events.some((line) => line.startsWith("ready version=1 brightness=70")),
      `ready was decoded: ${JSON.stringify(run.events)}`,
    );

    const expected = await expectedPixels(surface);
    assert.equal(run.framebuffer.length, expected.length);
    assert.equal(
      Buffer.compare(run.framebuffer, expected),
      0,
      "the firmware framebuffer differs from the pixels the host rendered",
    );
    await device.close();
  });

  test("a second paint sends only dirty rectangles, and the firmware still holds the whole frame", async () => {
    const { link, device } = await connect();
    const first: Surface = { kind: "tile", emphasis: "ground", label: "anchor", value: "1.42" };
    const second: Surface = { kind: "tile", emphasis: "ground", label: "anchor", value: "9.87" };
    await device.paint(frameFor(first));
    await device.paint(frameFor(second));

    const run = feed(link.written());
    assert.equal(run.status, 0, `decoder faulted: ${run.events.join(", ")}`);
    assert.ok(run.events.includes("commit 2"), "two frames were presented");

    // The point of the diff: the second paint is a fraction of a frame on the wire, and the device
    // still ends up holding all of it because the parts that did not change were never resent.
    const expected = await expectedPixels(second);
    assert.equal(
      Buffer.compare(run.framebuffer, expected),
      0,
      "the incrementally-painted framebuffer differs from the frame the host rendered",
    );
    await device.close();
  });

  test("the whole exchange survives being split at every byte boundary", async () => {
    const { link, device } = await connect();
    const surface: Surface = { kind: "tile", emphasis: "ground", label: "split", value: "0.01" };
    await device.paint(frameFor(surface));
    const bytes = link.written();

    const wholesale = feed(bytes, bytes.length);
    const byteAtATime = feed(bytes, 1);
    const awkward = feed(bytes, 7);

    const expected = await expectedPixels(surface);
    for (const [name, run] of [
      ["one write", wholesale],
      ["one byte at a time", byteAtATime],
      ["seven bytes at a time", awkward],
    ] as const) {
      assert.equal(run.status, 0, `${name} faulted`);
      assert.equal(Buffer.compare(run.framebuffer, expected), 0, `${name} produced a different frame`);
    }
    await device.close();
  });

  test("brightness and blank reach the firmware as themselves", async () => {
    const { link, device } = await connect();
    await device.setBrightness(35);
    await device.blank();

    const run = feed(link.written());
    assert.equal(run.status, 0);
    assert.ok(run.events.includes("brightness 35"), JSON.stringify(run.events));
    assert.ok(run.events.includes("blank"), JSON.stringify(run.events));
    await device.close();
  });

  test("a ping is answered with a pong, and with nothing else", async () => {
    const { link, device } = await connect();
    // The keepalive fires on a timer the test does not wait for, so the ping is sent directly —
    // what is being checked is the firmware's reply, not the host's schedule.
    const ping = Buffer.from([0xa5, MessageType.Ping, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const run = feed(Buffer.concat([link.written(), ping]));

    assert.equal(run.status, 0);
    assert.equal(run.fromDevice.length, 8, "a pong is a bare header");
    assert.equal(run.fromDevice.readUInt8(0), 0xa5);
    assert.equal(run.fromDevice.readUInt8(1), MessageType.Pong);
    // Echoing the sequence number is what lets a host match a reply to the probe that caused it.
    assert.equal(run.fromDevice.readUInt16LE(2), 7);
    await device.close();
  });

  /* ----------------------------------------------------------------- make it fail ------------- */

  test("a flipped byte in a tile changes the picture — the comparison can fail", async () => {
    // Without this the test above proves only that two programs agree, not that they would notice
    // disagreeing. AGENTS.md: say what would falsify it.
    const { link, device } = await connect();
    const surface: Surface = { kind: "tile", emphasis: "ground", label: "corrupt", value: "5.00" };
    await device.paint(frameFor(surface));
    const bytes = Buffer.from(link.written());

    const clean = feed(bytes);
    const expected = await expectedPixels(surface);
    assert.equal(Buffer.compare(clean.framebuffer, expected), 0, "the clean run matches");

    // Land in the middle of the stream, well past READY and inside tile pixel data.
    const at = Math.floor(bytes.length / 2);
    bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at);
    const dirty = feed(bytes);
    assert.notEqual(
      Buffer.compare(dirty.framebuffer, expected),
      0,
      "corrupting a pixel byte must produce a different frame, or this test proves nothing",
    );
    await device.close();
  });

  test("a tile that overruns the panel is refused rather than written", async () => {
    // The rectangle is arithmetic on numbers from the other end of a cable, and it lands as a
    // pointer into the framebuffer. This is the case that would be a stack smash on the device.
    const overrun = encodeTile(
      1,
      { x: 120, y: 0, width: 64, height: 1 },
      TileEncoding.Raw,
      Buffer.alloc(64 * 2),
    );
    const run = feed(overrun);
    assert.equal(run.status, 1, "the decoder rejected the stream");
    assert.ok(run.events.includes("fault 5"), `expected ANCHOR_FAULT_RECT, got ${run.events.join(", ")}`);
  });

  test("a run-length tile that does not fill its rectangle is refused", async () => {
    // A short RLE stream would otherwise leave part of a rectangle holding the previous frame,
    // which on a portfolio is a number with stale digits in it rather than a visible glitch.
    const short = Buffer.from([0x81, 0x12, 0x34]); // two pixels, for a rectangle wanting four
    const tile = encodeTile(1, { x: 0, y: 0, width: 2, height: 2 }, TileEncoding.Rle16, short);
    const run = feed(tile);
    assert.equal(run.status, 1);
    assert.ok(run.events.includes("fault 6"), `expected ANCHOR_FAULT_RLE, got ${run.events.join(", ")}`);
  });

  test("the device refuses a message only a device may send", async () => {
    // The mirror of HOST_BOUND_TYPES. A host cannot send HELLO, so something claiming to be one is
    // not a host, and a stream already caught lying is not a stream to resynchronise.
    const run = feed(encodeHello(1, HELLO));
    assert.equal(run.status, 1);
    assert.ok(run.events.includes("fault 2"), `expected ANCHOR_FAULT_TYPE, got ${run.events.join(", ")}`);
  });

  test("a payload larger than the buffer hello promised is refused, not allocated for", async () => {
    // `maxTileBytes` is a promise about memory that already exists. A device that grew a buffer to
    // fit whatever arrived would be a device an attacker sizes.
    const oversized = encodeTile(
      1,
      { x: 0, y: 0, width: 128, height: 128 },
      TileEncoding.Raw,
      Buffer.alloc(128 * 128 * 2),
    );
    const run = feed(oversized);
    assert.equal(run.status, 1);
    assert.ok(run.events.includes("fault 3"), `expected ANCHOR_FAULT_LENGTH, got ${run.events.join(", ")}`);
  });

  test("noise before the session is skipped, and the frame behind it still lands", async () => {
    // The mirror of `findHello` on the host, and it is not hypothetical: on a native-USB ESP32 the
    // ROM banner, the second-stage bootloader and the tail of esptool's stub loader all arrive on
    // the same endpoint before a host has said anything. Measured on the board — without this the
    // device announced itself as already faulted after every flash.
    const { link, device } = await connect();
    const surface: Surface = { kind: "tile", emphasis: "ground", label: "noise", value: "1.00" };
    await device.paint(frameFor(surface));

    const noise = Buffer.from("ESP-ROM:esp32s3-20210327\r\nrst:0x15 boot:0x2b\r\n", "utf8");
    const run = feed(Buffer.concat([noise, link.written()]));

    assert.equal(run.status, 0, `expected a clean stream, got ${run.events.join(", ")}`);
    assert.ok(run.events.includes("commit 1"));
    const expected = await expectedPixels(surface);
    assert.equal(Buffer.compare(run.framebuffer, expected), 0, "the frame behind the noise is intact");
    await device.close();
  });

  test("once the session is established, a byte out of place is a fault", async () => {
    // The other half, and the half that makes the first one safe. Skipping garbage forever would be
    // a decoder that hunts for a header in a stream it has already caught lying — which is how one
    // ends up blitting attacker-chosen bytes into a framebuffer.
    const { link, device } = await connect();
    await device.paint(frameFor({ kind: "tile", emphasis: "ground", label: "strict" }));
    const run = feed(
      Buffer.concat([link.written(), Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])]),
    );
    assert.equal(run.status, 1);
    assert.ok(run.events.includes("fault 1"), `expected ANCHOR_FAULT_MAGIC, got ${run.events.join(", ")}`);
    await device.close();
  });

  test("garbage that never contains a header is consumed without faulting", async () => {
    const run = feed(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
    assert.equal(run.status, 0);
    assert.ok(run.events.includes("fault 0"), `expected no fault, got ${run.events.join(", ")}`);
  });
});
