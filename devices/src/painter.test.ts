/**
 * The lock gate on the paint path, asserted on the bytes that would reach an ESP32.
 *
 * On that panel a COMMIT turns the backlight back up to its configured level, so a single frame
 * painted while the session is locked puts a portfolio back on the desk. The adapter is real and so
 * is the rasteriser; only the link is memory.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { attach, type Esp32PulseDevice, MemoryLink, SCREEN_SLOT } from "./adapters/esp32.ts";
import {
  encodeHello,
  encodeInput,
  HEADER_BYTES,
  MessageType,
  PixelFormat,
  PROTOCOL_VERSION,
} from "./adapters/esp32-wire.ts";
import { Painter } from "./painter.ts";
import { clearRasterCache, rasteriserAvailable } from "./raster.ts";
import { toTokens } from "./tokens.ts";
import type { Frame } from "./types.ts";

const frame: Frame = new Map([
  [SCREEN_SLOT, { kind: "tile", emphasis: "ground", label: "$12,480", meter: 0.6 }],
]);

function sentTypes(link: MemoryLink): number[] {
  const types: number[] = [];
  let buffer = link.written();
  while (buffer.length >= HEADER_BYTES) {
    types.push(buffer.readUInt8(1));
    buffer = buffer.subarray(HEADER_BYTES + buffer.readUInt32LE(4));
  }
  return types;
}

async function connect(): Promise<{ link: MemoryLink; device: Esp32PulseDevice }> {
  const link = new MemoryLink();
  const attached = attach(link, toTokens("Test", { accent: "#7aa2f7" }));
  link.receive(
    encodeHello(1, {
      version: PROTOCOL_VERSION,
      width: 128,
      height: 128,
      format: PixelFormat.Rgb565Le,
      maxTileBytes: 65535,
      inputs: ["tap", "swipe"],
      deviceId: "pulse-test",
    }),
  );
  const device = await attached;
  link.sent.length = 0;
  return { link, device };
}

async function pulse(): Promise<{ link: MemoryLink; device: Esp32PulseDevice; painter: Painter }> {
  const { link, device } = await connect();
  const painter = new Painter(
    () => device,
    async () => frame,
    (error) => assert.fail(String(error)),
  );
  return { link, device, painter };
}

const noRasteriser = (await rasteriserAvailable())
  ? false
  : "no working SVG rasteriser — install imagemagick and librsvg";

describe("a locked session", { skip: noRasteriser }, () => {
  test("gets no frame from a poll, an event or a key press, and one frame on unlock", async () => {
    const { link, device, painter } = await pulse();
    await painter.repaint();
    link.sent.length = 0;
    await painter.setBlanked(true);
    assert.deepEqual(sentTypes(link), [MessageType.Blank]);
    link.sent.length = 0;

    // What the daemon's callers do: a service poll's partial result and a Hyprland event each ask
    // for a repaint, and so does a touch, through the handler `cli.ts` attaches to the device.
    const pending: Promise<void>[] = [];
    device.onInput(() => pending.push(painter.repaint()));
    await painter.repaint();
    await painter.repaint();
    link.receive(encodeInput(1, { kind: "tap", slot: SCREEN_SLOT, x: 30, y: 40 }));
    assert.equal(pending.length, 1, "the touch reached the handler");
    await Promise.all(pending);
    assert.deepEqual(sentTypes(link), [], "nothing may reach a locked panel");

    // The control: the same rig does see a frame, once, as soon as the session unlocks.
    await painter.setBlanked(false);
    const types = sentTypes(link);
    assert.equal(types[0], MessageType.Brightness);
    assert.equal(types.at(-1), MessageType.Commit);
    assert.equal(types.filter((type) => type === MessageType.Commit).length, 1);
    await device.close();
  });

  test("a frame already on the wire when the session locks lands before the blank, not after it", async () => {
    const { link, device, painter } = await pulse();
    // A cached render would finish the whole paint in microtasks, before the lock could land.
    clearRasterCache();
    const painting = painter.repaint();
    // Let the frame compose and the adapter start rasterising it, then lock.
    await new Promise((resolve) => setImmediate(resolve));
    await painter.setBlanked(true);
    await painting;

    const types = sentTypes(link);
    assert.ok(types.includes(MessageType.Commit), "the frame was already under way");
    assert.equal(types.at(-1), MessageType.Blank, "the panel must end dark");
    await device.close();
  });
});

describe("a device that reconnects while the session is locked", () => {
  test("is sent BLANK after its brightness, once, and no frame", async () => {
    let current = await connect();
    const painter = new Painter(
      () => current.device,
      async () => frame,
      (error) => assert.fail(String(error)),
    );
    await painter.setBlanked(true);

    // What `reconnect` in cli.ts does with the fresh device: set its brightness, then ask for a
    // repaint. The old device was blanked; this one has only just booted and knows nothing of it.
    const old = current;
    current = await connect();
    await current.device.setBrightness(80);
    await painter.repaint();
    assert.deepEqual(sentTypes(current.link), [MessageType.Brightness, MessageType.Blank]);

    // The tick keeps asking every second. One BLANK is enough, and still no frame.
    await painter.repaint();
    assert.deepEqual(sentTypes(current.link), [MessageType.Brightness, MessageType.Blank]);
    await old.device.close();
    await current.device.close();
  });
});
