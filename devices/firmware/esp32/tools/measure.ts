#!/usr/bin/env node
/**
 * What a frame actually costs, on the hardware, end to end.
 *
 * `docs/devices-esp32.md` rests on one claim — that shipping pixels rather than a drawing model is
 * affordable — and it states its own falsification test: *if a full frame on real hardware costs
 * more than a few hundred milliseconds end to end, or a dirty rect costs more than about 50 ms, the
 * argument in this document is wrong.* Every number in that document up to now was computed on the
 * desktop from the encoder alone. This measures the other half.
 *
 * The instrument is a PING. The stream is ordered, so a PONG answering a ping issued after a COMMIT
 * cannot come back until the device has read, decoded and presented every byte before it. That
 * makes the round trip an upper bound on the whole path — host write, USB, decode, blit — with no
 * cooperation from the firmware beyond the one reply the protocol already requires.
 *
 *   node devices/firmware/esp32/tools/measure.ts [--port /dev/ttyACM0] [--rounds 10]
 *
 * Reported separately: the first paint, which is a full frame because the device has nothing to
 * diff against, and subsequent paints of a changed value, which are dirty rectangles. Those are the
 * two numbers the doc names.
 */

import { existsSync } from "node:fs";
import { attach, type Esp32PulseDevice, SCREEN_SLOT } from "../../../src/adapters/esp32.ts";
import { listPorts, openSerialLink } from "../../../src/adapters/esp32-serial.ts";
import { loadTokens } from "../../../src/tokens.ts";
import type { Frame, Surface } from "../../../src/types.ts";

function parse(argv: readonly string[]): { port?: string; rounds: number } {
  const options: { port?: string; rounds: number } = { rounds: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") options.port = argv[++i];
    else if (argv[i] === "--rounds") options.rounds = Number.parseInt(argv[++i] ?? "", 10) || 10;
  }
  return options;
}

function choosePort(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const found = listPorts();
  if (found.length > 0) return found[0] as string;
  if (existsSync("/dev/ttyACM0")) return "/dev/ttyACM0";
  throw new Error("no serial device found");
}

/** Time from the ping to its own pong. Any other pong — a keepalive's — is ignored. */
async function roundTrip(device: Esp32PulseDevice, timeoutMs = 15_000): Promise<number> {
  // Pongs are recorded before the ping is sent and matched afterwards. Registering the handler and
  // only then learning which sequence number to wait for leaves a window where the device's reply
  // arrives first and is dropped — on a 12 Mbit link that window is not theoretical.
  const seen = new Map<number, bigint>();
  let wake: (() => void) | null = null;
  device.onPong((seq) => {
    seen.set(seq, process.hrtime.bigint());
    wake?.();
  });

  const started = process.hrtime.bigint();
  const expected = await device.ping();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const at = seen.get(expected);
    if (at !== undefined) return Number(at - started) / 1e6;
    if (Date.now() > deadline) throw new Error("no pong within the timeout");
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 5);
    });
  }
}

const surfaceFor = (value: string): Surface => ({
  kind: "tile",
  emphasis: "ground",
  icon: "\u{f0e4}",
  label: "anchor",
  value,
});

const frameOf = (surface: Surface): Frame => new Map([[SCREEN_SLOT, surface]]);

function summarise(name: string, samples: readonly number[]): void {
  if (samples.length === 0) return;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  process.stdout.write(
    `${name.padEnd(18)} n=${samples.length}  min ${sorted[0]?.toFixed(1)}ms  ` +
      `median ${median.toFixed(1)}ms  max ${sorted[sorted.length - 1]?.toFixed(1)}ms\n`,
  );
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const path = choosePort(options.port);
  const tokens = loadTokens();
  const link = openSerialLink(path);
  const device = await attach(link, tokens, {}, 10_000);
  const { width, height } = device.panel;

  process.stdout.write(
    `${device.id} · ${width}x${height} · ${path} · theme ${tokens.themeName}\n` +
      `frame is ${(width * height * 2).toLocaleString()} bytes uncompressed\n\n`,
  );

  // A baseline with nothing painted, so the frame numbers below can be read as frame cost rather
  // than as the cost of the link. Without this an 8ms USB round trip looks like an 8ms blit.
  const idle: number[] = [];
  for (let i = 0; i < 5; i++) idle.push(await roundTrip(device));
  summarise("ping only", idle);

  // The first paint has nothing to diff against, so every pixel of the panel goes out.
  const full = process.hrtime.bigint();
  await device.paint(frameOf(surfaceFor("0.00")));
  const fullRoundTrip = await roundTrip(device);
  const fullTotal = Number(process.hrtime.bigint() - full) / 1e6;
  process.stdout.write(
    `full frame         render+send ${(fullTotal - fullRoundTrip).toFixed(1)}ms  ` +
      `then ${fullRoundTrip.toFixed(1)}ms to the pong\n`,
  );

  // Subsequent paints change one number, so only the rectangles containing it are sent. This is the
  // number that decides whether a portfolio can tick.
  const dirty: number[] = [];
  for (let round = 0; round < options.rounds; round++) {
    const started = process.hrtime.bigint();
    await device.paint(frameOf(surfaceFor((round + 1).toFixed(2))));
    await roundTrip(device);
    dirty.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  summarise("dirty rect", dirty);

  // Repainting an unchanged frame must cost nothing at all — the diff finds no rectangles and the
  // adapter sends no bytes, so this should collapse to the idle round trip above.
  const unchanged: number[] = [];
  const same = surfaceFor("static");
  await device.paint(frameOf(same));
  await roundTrip(device);
  for (let i = 0; i < 5; i++) {
    const started = process.hrtime.bigint();
    await device.paint(frameOf(same));
    await roundTrip(device);
    unchanged.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  summarise("unchanged frame", unchanged);

  await device.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
