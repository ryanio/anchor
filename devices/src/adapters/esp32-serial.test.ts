/**
 * The serial link's one piece of judgement, with no serial port involved.
 *
 * Everything else in `esp32-serial.ts` is `fs` and `stty`. The part that can be wrong is the
 * resynchronisation, because it decides where the protocol starts on a wire that carries a boot log
 * first — and a resync that fires on the wrong byte strands a working display until someone
 * unplugs it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findHello, listPorts, MAX_PRESYNC_BYTES } from "./esp32-serial.ts";
import {
  decodeMessages,
  encodeHello,
  type Hello,
  MessageType,
  PixelFormat,
  PROTOCOL_VERSION,
} from "./esp32-wire.ts";

const hello: Hello = {
  version: PROTOCOL_VERSION,
  width: 240,
  height: 135,
  format: PixelFormat.Rgb565Be,
  maxTileBytes: 4096,
  inputs: ["press"],
  deviceId: "pulse",
};

/**
 * What a native-USB ESP32 actually puts on the CDC endpoint before the application runs.
 *
 * Taken from Espressif's documented second-stage bootloader output. It is here as a fixture rather
 * than as a comment because the whole point of `findHello` is that these bytes arrive first, and a
 * test that syncs on a clean stream tests nothing.
 */
const BOOT_LOG = Buffer.from(
  "ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\nrst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n" +
    "SPIWP:0xee\r\nmode:DIO, clock div:1\r\nload:0x3fce3808,len:0x44c\r\nentry:0x403c98d8\r\n",
  "utf8",
);

describe("resynchronising a serial link", () => {
  test("finds the hello that follows a boot log", () => {
    const stream = Buffer.concat([BOOT_LOG, encodeHello(1, hello)]);
    assert.equal(findHello(stream), BOOT_LOG.length);

    // And what is handed on from there is a stream the strict parser accepts, which is the actual
    // requirement — an offset that is merely plausible would still break the handshake.
    const { messages } = decodeMessages(stream.subarray(findHello(stream)));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.type, MessageType.Hello);
  });

  test("a clean stream syncs at zero", () => {
    assert.equal(findHello(encodeHello(1, hello)), 0);
  });

  test("does not sync on a stray magic byte with an implausible length", () => {
    // 0xA5 is not ASCII, so it will not appear in a log — but binary garbage from a half-flashed
    // device can contain anything, and the length field is what makes the match mean something.
    const decoy = Buffer.from([0xa5, MessageType.Hello, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(findHello(decoy), -1);
  });

  test("does not sync on a message the device is not allowed to send", () => {
    // Only a HELLO opens a conversation. A stream that begins mid-frame with something else is
    // noise that happens to look structured, and syncing to it would feed the parser a lie.
    const tile = Buffer.from([0xa5, MessageType.Tile, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00]);
    assert.equal(findHello(tile), -1);
  });

  test("waits rather than guessing when the header is incomplete", () => {
    const partial = encodeHello(1, hello).subarray(0, 5);
    assert.equal(findHello(partial), -1);
  });

  test("the pre-sync budget is large enough for a boot log and small enough to be a budget", () => {
    // The failure this guards is a port that babbles forever growing the process. Both halves are
    // the claim: the budget must not be so tight that a normal boot cannot fit inside it.
    assert.ok(MAX_PRESYNC_BYTES > BOOT_LOG.length * 4);
    assert.ok(MAX_PRESYNC_BYTES <= 1 << 16);
  });
});

describe("finding a port", () => {
  test("returns paths, never throws, on a machine with no device attached", () => {
    // `/dev/serial/by-id` does not exist until something is plugged in, and a device layer that
    // throws when nothing is attached is one no caller can probe.
    const ports = listPorts();
    assert.ok(Array.isArray(ports));
    for (const port of ports) assert.ok(port.startsWith("/dev/serial/by-id/"), port);
  });
});
