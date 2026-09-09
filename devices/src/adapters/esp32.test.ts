/**
 * The pulse adapter, with no ESP32 anywhere near it.
 *
 * Everything below runs against `MemoryLink`, which is the point: a device that is only testable
 * when it is on the desk is a device whose failure modes are discovered on the desk. The rasteriser
 * *is* real — `raster.test.ts` makes the same choice, and for the same reason. What can break in a
 * paint is the tool and the byte counts, not our arithmetic about them.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rasteriserAvailable } from "../raster.ts";
import { toTokens } from "../tokens.ts";
import type { Frame, Surface } from "../types.ts";
import {
  attach,
  capabilitiesFor,
  checkTransport,
  type Esp32PulseDevice,
  isLoopback,
  MemoryLink,
  PANELS,
  PairingError,
  SCREEN_SLOT,
} from "./esp32.ts";
import {
  decodeMessages,
  encodeHeader,
  encodeHello,
  encodeInput,
  HEADER_BYTES,
  type Hello,
  MAX_PANEL_PIXELS,
  MessageType,
  PixelFormat,
  PROTOCOL_VERSION,
} from "./esp32-wire.ts";

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
 * A small panel, so a test paints in milliseconds rather than rasterising a quarter-megapixel.
 * `maxTileBytes` is large enough that a full frame is one tile here; splitting has its own test.
 */
const smallHello: Hello = {
  version: PROTOCOL_VERSION,
  width: 128,
  height: 128,
  format: PixelFormat.Rgb565Le,
  maxTileBytes: 65535,
  inputs: ["tap", "swipe"],
  deviceId: "pulse-test",
};

const PANEL_PIXELS = smallHello.width * smallHello.height;

/**
 * A tile whose pixels differ per label without depending on glyph rendering.
 *
 * These tests compare rasterised frames, and CI has neither this machine's fonts nor its Omarchy
 * themes. A label change alone is not guaranteed to move a single pixel there: `svg.ts` drops a
 * mark that falls below the legible floor rather than drawing it as texture, and two labels can
 * rasterise identically under a substituted font. That is exactly what turned main red — the tests
 * held here and failed on the runner.
 *
 * The meter makes the difference geometric, which no font can take away, while the label stays so
 * each test still reads as the thing it is about.
 */
const tile = (label: string): Surface => {
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.codePointAt(0)!) % 997;
  return { kind: "tile", emphasis: "ground", label, meter: 0.1 + (hash % 80) / 100 };
};
const frameFor = (surface: Surface): Frame => new Map([[SCREEN_SLOT, surface]]);

/** Every message type, for reading back what the *host* wrote. */
const ALL_TYPES: ReadonlySet<number> = new Set(Object.values(MessageType));

interface SentTile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly payloadBytes: number;
}

function sent(link: MemoryLink): { types: number[]; tiles: SentTile[] } {
  const types: number[] = [];
  const tiles: SentTile[] = [];
  let buffer = link.written();
  while (buffer.length >= HEADER_BYTES) {
    const type = buffer.readUInt8(1);
    const length = buffer.readUInt32LE(4);
    const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
    types.push(type);
    if (type === MessageType.Tile) {
      tiles.push({
        x: payload.readUInt16LE(0),
        y: payload.readUInt16LE(2),
        width: payload.readUInt16LE(4),
        height: payload.readUInt16LE(6),
        payloadBytes: payload.length - 9,
      });
    }
    buffer = buffer.subarray(HEADER_BYTES + length);
  }
  return { types, tiles };
}

const paintedPixels = (tiles: readonly SentTile[]): number =>
  tiles.reduce((total, entry) => total + entry.width * entry.height, 0);

async function connect(hello: Hello = smallHello): Promise<{ link: MemoryLink; device: Esp32PulseDevice }> {
  const link = new MemoryLink();
  const attached = attach(link, tokens);
  link.receive(encodeHello(1, hello));
  const device = await attached;
  link.sent.length = 0;
  return { link, device };
}

describe("capabilities", () => {
  test("come from the device's hello, not from a table of model constants", () => {
    const capabilities = capabilitiesFor({ ...smallHello, width: 240, height: 536 });
    assert.deepEqual(capabilities.slots, [
      { id: SCREEN_SLOT, kind: "screen", paintable: true, width: 240, height: 536 },
    ]);
    assert.deepEqual(capabilities.inputs, ["tap", "swipe"]);
  });

  test("the panel table is documentation, and every entry is a panel a hello could declare", () => {
    for (const [name, panel] of Object.entries(PANELS)) {
      assert.ok(panel.width > 0 && panel.height > 0, `${name} has a size`);
      assert.ok(panel.width * panel.height <= MAX_PANEL_PIXELS, `${name} is within the hello ceiling`);
    }
  });
});

describe("transport", () => {
  test("loopback is loopback, and a LAN address is not", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1"]) {
      assert.equal(isLoopback(host), true, host);
    }
    for (const host of ["192.168.1.40", "anchor-pulse.local", "10.0.0.5", "127.example.com"]) {
      assert.equal(isLoopback(host), false, host);
    }
  });

  test("refuses to paint a LAN device with no pairing key", () => {
    // An Anchor surface carries wallet data, and everything on the LAN would otherwise see it. The
    // failure is silent by nature: the display works perfectly while showing the flat the flatmates.
    assert.throws(() => checkTransport("192.168.1.40", false), PairingError);
    assert.throws(() => checkTransport("anchor-pulse.local", false), PairingError);
  });

  test("allows a LAN device with a key, and loopback without one", () => {
    assert.doesNotThrow(() => checkTransport("192.168.1.40", true));
    assert.doesNotThrow(() => checkTransport("127.0.0.1", false));
  });
});

describe("handshake", () => {
  test("adopts the panel the device declares and answers with ready", async () => {
    const link = new MemoryLink();
    const attached = attach(link, tokens);
    link.receive(encodeHello(1, smallHello));
    const device = await attached;
    assert.equal(device.id, "esp32:pulse-test");
    assert.deepEqual(device.panel, { width: 128, height: 128 });
    assert.deepEqual(sent(link).types, [MessageType.Ready]);
    await device.close();
  });

  test("refuses a device speaking another protocol version rather than guessing", async () => {
    const link = new MemoryLink();
    const attached = attach(link, tokens, {}, 200);
    link.receive(encodeHello(1, { ...smallHello, version: PROTOCOL_VERSION + 1 }));
    await assert.rejects(attached, /protocol/);
  });

  test("gives up rather than waiting forever on a device that connects and says nothing", async () => {
    const link = new MemoryLink();
    await assert.rejects(attach(link, tokens, {}, 50), /no hello/);
  });
});

// Painting rasterises SVG, so this needs the real tool. Skipped with a reason rather than failed
// where it is absent — see raster.test.ts for why that is the honest shape.
const noRasteriser = rasteriserAvailable()
  ? false
  : "no working SVG rasteriser — install imagemagick and librsvg";

describe("paint", { skip: noRasteriser }, () => {
  test("the first paint covers the whole panel, and ends with exactly one commit", async () => {
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    const { types, tiles } = sent(link);
    assert.equal(paintedPixels(tiles), PANEL_PIXELS);
    // A commit is last, and there is one: a number that renders half-updated is a wrong reading
    // rather than a cosmetic glitch, and money is what is on this screen.
    assert.equal(types.at(-1), MessageType.Commit);
    assert.equal(types.filter((type) => type === MessageType.Commit).length, 1);
    await device.close();
  });

  test("an unchanged frame costs no traffic at all", async () => {
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    link.sent.length = 0;
    await device.paint(frameFor(tile("ready")));
    assert.deepEqual(link.sent, [], "an idle pulse display should not touch the radio");
    await device.close();
  });

  test("a changed label repaints a fraction of the panel, not the panel", async () => {
    // This is the whole case for shipping pixels. Without it the link carries a quarter of a
    // megabyte every time a portfolio ticks; with it, it carries the digits.
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    link.sent.length = 0;
    await device.paint(frameFor(tile("busy")));
    const { tiles } = sent(link);
    assert.ok(tiles.length > 0, "a changed surface must repaint something");
    assert.ok(
      paintedPixels(tiles) < PANEL_PIXELS / 2,
      `repainted ${paintedPixels(tiles)} of ${PANEL_PIXELS}`,
    );
    await device.close();
  });

  test("a flat surface compresses, so a full frame is far smaller than its pixels", async () => {
    // Anchor's faces are flat fills and text. If this ever stops holding, the RLE is not earning
    // its place in the firmware and the encoder should be deleted rather than defended.
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    const { tiles } = sent(link);
    const bytes = tiles.reduce((total, entry) => total + entry.payloadBytes, 0);
    assert.ok(bytes < PANEL_PIXELS * 2 * 0.5, `full frame took ${bytes} of ${PANEL_PIXELS * 2} raw bytes`);
    await device.close();
  });

  test("a device with a small tile buffer gets the frame in pieces that fit it", async () => {
    const { link, device } = await connect({ ...smallHello, maxTileBytes: 4096 });
    await device.paint(frameFor(tile("ready")));
    const { tiles } = sent(link);
    assert.ok(tiles.length > 1, "a 32 KB frame must not arrive as one 4 KB tile");
    for (const entry of tiles) assert.ok(entry.width * entry.height * 2 <= 4096);
    assert.equal(paintedPixels(tiles), PANEL_PIXELS);
    await device.close();
  });

  test("a theme change forgets the frame, so the next paint is a full one", async () => {
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    link.sent.length = 0;
    device.tokens = toTokens("Rose Pine", { mode: "dark", accent: "#ebbcba", background: "#191724" });
    await device.paint(frameFor(tile("ready")));
    assert.equal(paintedPixels(sent(link).tiles), PANEL_PIXELS);
    await device.close();
  });

  test("a frame with nothing for the screen slot paints nothing", async () => {
    const { link, device } = await connect();
    await device.paint(new Map([["key:0", tile("another device's slot")]]));
    assert.deepEqual(link.sent, []);
    await device.close();
  });

  test("blank clears the panel and forces a full repaint after it", async () => {
    // The session-lock path. `docs/security.md`: private wallet data must not stay on a screen the
    // desktop has locked, and a desk display cannot know it locked unless the host says so.
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    link.sent.length = 0;
    await device.blank();
    assert.deepEqual(sent(link).types, [MessageType.Blank]);
    link.sent.length = 0;
    await device.paint(frameFor(tile("ready")));
    assert.equal(paintedPixels(sent(link).tiles), PANEL_PIXELS);
    await device.close();
  });

  test("setBlanked is the contract's name for it, and unblanking repaints rather than restoring", async () => {
    // `AnchorDevice.setBlanked` is what a lock-signal subscriber calls, so an adapter that only had
    // `blank()` would be skipped by it silently — the display stays lit and nothing reports a fault.
    const { link, device } = await connect();
    await device.paint(frameFor(tile("ready")));
    link.sent.length = 0;

    await device.setBlanked(true);
    assert.deepEqual(sent(link).types, [MessageType.Blank]);
    link.sent.length = 0;

    // Coming back must not just turn the backlight up: the device dropped the frame when it went
    // dark, so brightness alone would light a panel holding nothing, or worse, something stale.
    await device.setBlanked(false);
    assert.deepEqual(sent(link).types, [MessageType.Brightness]);
    link.sent.length = 0;

    await device.paint(frameFor(tile("ready")));
    assert.equal(paintedPixels(sent(link).tiles), PANEL_PIXELS);
    await device.close();
  });
});

describe("liveness", () => {
  test("a pong is matched to the ping that asked for it", async () => {
    // The stream is ordered, so a pong answering a ping sent after a commit cannot arrive until the
    // device has finished with that frame. That is the only acknowledgement the protocol has, and
    // it is the instrument `tools/measure.ts` uses to time a real frame on real hardware.
    const { link, device } = await connect();
    const seq = await device.ping();
    assert.deepEqual(sent(link).types, [MessageType.Ping]);

    const seen: number[] = [];
    device.onPong((answered) => seen.push(answered));
    link.receive(encodeHeader(MessageType.Pong, seq, 0));
    assert.deepEqual(seen, [seq]);
    await device.close();
  });

  test("a device may not answer with anything but a pong", async () => {
    // The mirror of the firmware's own refusal. A device that replies to a ping with a tile is
    // trying to paint the host's idea of the panel, and the link goes down rather than parsing it.
    const { link, device } = await connect();
    link.receive(encodeHeader(MessageType.Tile, 1, 0));
    assert.equal(link.closed, true);
    await device.close();
  });
});

describe("input", () => {
  test("a touch arrives as a DeviceInput the panel already understands", async () => {
    const { link, device } = await connect();
    const seen: unknown[] = [];
    device.onInput((input) => seen.push(input));
    link.receive(encodeInput(1, { kind: "swipe", slot: SCREEN_SLOT, from: 10, to: 200 }));
    assert.deepEqual(seen, [{ kind: "swipe", slot: SCREEN_SLOT, from: 10, to: 200 }]);
    await device.close();
  });

  test("an input split across two segments is reassembled", async () => {
    const { link, device } = await connect();
    const seen: unknown[] = [];
    device.onInput((input) => seen.push(input));
    const message = encodeInput(1, { kind: "tap", slot: SCREEN_SLOT, x: 30, y: 40 });
    link.receive(message.subarray(0, 6));
    assert.deepEqual(seen, [], "half a message is not an input");
    link.receive(message.subarray(6));
    assert.deepEqual(seen, [{ kind: "tap", slot: SCREEN_SLOT, x: 30, y: 40 }]);
    await device.close();
  });

  test("a device that sends something it has no business sending is hung up on", async () => {
    const { link, device } = await connect();
    device.onInput(() => assert.fail("a forged message must not reach the panel"));
    // A Ready is host-to-device. A display sending one is either broken or someone else's.
    link.receive(Buffer.from([0xa5, MessageType.Ready, 0, 0, 6, 0, 0, 0, 1, 70, 0, 0, 0, 0]));
    assert.equal(link.closed, true);
  });
});

describe("the wire has no vocabulary for spending", () => {
  test("no message type names a key, a signature or an approval", () => {
    // Invariant 1 in AGENTS.md, as a test rather than as a comment. A future message that means
    // "approved" should have to delete this line to land, which is the point of writing it down.
    const names = Object.keys(MessageType).join(" ").toLowerCase();
    for (const forbidden of ["sign", "key", "approve", "approval", "tx", "transaction", "spend"]) {
      assert.equal(names.includes(forbidden), false, `MessageType must not contain ${forbidden}`);
    }
  });

  test("a device-to-host message carries a shape with no free text in it", () => {
    const { messages } = decodeMessages(encodeHello(1, smallHello), ALL_TYPES);
    assert.equal(messages.length, 1);
    assert.deepEqual(Object.keys(messages[0] ?? {}).sort(), ["hello", "seq", "type"]);
    const input = decodeMessages(encodeInput(2, { kind: "tap", slot: SCREEN_SLOT, x: 1, y: 2 }), ALL_TYPES);
    assert.deepEqual(Object.keys(input.messages[0] ?? {}).sort(), ["input", "seq", "type"]);
  });
});
