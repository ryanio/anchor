/**
 * A real Anchor frame, as bytes, for the simulator to decode.
 *
 * The harness can run the firmware without a board, but a *frame* still has to come from
 * somewhere, and inventing one here would put a second encoder in this repository — the exact
 * thing `docs/devices-esp32.md` refuses when it argues for one renderer. So this drives the real
 * `Esp32PulseDevice` through the real `MemoryLink`, in the shape `esp32-firmware.test.ts` already
 * established, and writes what the host actually put on the wire.
 *
 *   node tools/frame.ts /tmp/frame.bin
 *   sim/run.sh --feed /tmp/frame.bin --shot /tmp/pulse --quit-after 3000
 *
 * The HELLO it answers is this board's: 368x448, RGB565 little-endian, 8 KB tiles — the same
 * numbers `app/app.ino` declares, because the host paints whatever geometry it is told and a
 * mismatch here would be a test of nothing.
 *
 * It needs the rasteriser (`magick`), for the same reason the conformance test does: the pixels are
 * rendered from SVG by the same path the desk uses.
 */

import { writeFileSync } from "node:fs";
import { attach, MemoryLink, SCREEN_SLOT } from "../../../../src/adapters/esp32.ts";
import {
  encodeHello,
  type Hello,
  PixelFormat,
  PROTOCOL_VERSION,
} from "../../../../src/adapters/esp32-wire.ts";
import { toTokens } from "../../../../src/tokens.ts";
import type { Frame, Surface } from "../../../../src/types.ts";

const HELLO: Hello = {
  version: PROTOCOL_VERSION,
  width: 368,
  height: 448,
  format: PixelFormat.Rgb565Le,
  maxTileBytes: 8192,
  inputs: ["tap", "swipe"],
  deviceId: "anchor-pulse-s3-sim",
};

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

const surface: Surface = {
  kind: "detail",
  title: "portfolio",
  lines: [
    { label: "total", value: "$12,418.60" },
    { label: "24h", value: "+2.4%", tone: "positive" },
    { label: "nfts", value: "37" },
    { label: "wallets", value: "9 of 9" },
  ],
  footer: "read 12s ago",
};

const out = process.argv[2] ?? "/tmp/anchor-pulse-frame.bin";

const link = new MemoryLink();
const attached = attach(link, tokens);
link.receive(encodeHello(1, HELLO));
const device = await attached;
const frame: Frame = new Map([[SCREEN_SLOT, surface]]);
await device.paint(frame);

/*
 * Read the wire before closing, not after.
 *
 * `close()` sends BLANK — correctly: the adapter is telling a device that is about to lose its host
 * to clear the pixels rather than keep showing a portfolio nobody is behind. Including it here
 * produced a capture that decoded perfectly and left the panel black, which looked exactly like a
 * broken decoder for as long as it took to notice the last four bytes.
 */
const bytes = link.written();
await device.close();
writeFileSync(out, bytes);
console.log(`wrote ${bytes.length} bytes to ${out}`);
