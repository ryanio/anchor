#!/usr/bin/env node
/**
 * Put one frame on an attached pulse display, over the USB cable, and hold it there.
 *
 * This is the smallest end-to-end path: open the port, read the device's HELLO, send READY, paint
 * one surface, repaint it every second so the device's stale timer never fires. It is deliberately
 * not `cli.ts` — the panel, the config file and the page machinery are a second thing that can be
 * wrong, and the question this script answers is only whether pixels rendered on the desktop arrive
 * on the glass.
 *
 *   node devices/firmware/esp32/tools/bringup.ts [--port /dev/ttyACM0] [--theme <name>] [--once]
 *
 * With no `--port` it takes the first Espressif-looking device in `/dev/serial/by-id`. If that
 * directory is empty and `/dev/ttyACM0` exists, it says so rather than guessing, because painting
 * a portfolio at whatever else happens to be on a serial port is not a mistake worth making
 * silently.
 *
 * Nothing here binds a socket. See the header of `esp32-serial.ts` for why that is the point.
 */

import { existsSync } from "node:fs";
import { attach, SCREEN_SLOT } from "../../../src/adapters/esp32.ts";
import { listPorts, openSerialLink } from "../../../src/adapters/esp32-serial.ts";
import { loadTokens } from "../../../src/tokens.ts";
import type { Frame } from "../../../src/types.ts";

function parse(argv: readonly string[]): { port?: string; theme?: string; once: boolean } {
  const options: { port?: string; theme?: string; once: boolean } = { once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = argv[++i];
    else if (arg === "--theme") options.theme = argv[++i];
    else if (arg === "--once") options.once = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "anchor pulse bring-up\n\n" +
          "  --port <path>   serial device (default: first Espressif port in /dev/serial/by-id)\n" +
          "  --theme <name>  render in this Omarchy theme instead of the active one\n" +
          "  --once          paint one frame and exit, leaving it on the panel\n",
      );
      process.exit(0);
    }
  }
  return options;
}

function choosePort(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const found = listPorts();
  if (found.length > 0) return found[0] as string;
  if (existsSync("/dev/ttyACM0")) {
    throw new Error(
      "no Espressif port in /dev/serial/by-id, but /dev/ttyACM0 exists. Pass it explicitly with " +
        "--port /dev/ttyACM0 once you are sure that is the display and not another serial device.",
    );
  }
  throw new Error("no serial device found. Check the board is plugged in over USB-C.");
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const path = choosePort(options.port);
  const tokens = loadTokens(options.theme);

  const link = openSerialLink(path);
  // Ten seconds rather than five: the sketch repeats its HELLO twice a second, but a board that
  // was only just plugged in spends the first moments in a bootloader that is not listening.
  const device = await attach(link, tokens, {}, 10_000);

  const { width, height } = device.panel;
  process.stdout.write(
    `${device.id} · ${width}x${height} · ${path} · theme ${tokens.themeName}\n` +
      `inputs: ${device.capabilities.inputs.join(", ") || "none reported"}\n`,
  );

  device.onInput((input) => process.stdout.write(`input: ${JSON.stringify(input)}\n`));

  /*
   * A `detail` surface rather than a portfolio value.
   *
   * `docs/devices.md` is clear that the Anchor page does not yet render a portfolio number, because
   * the shape of `/portfolio/value` has never been measured against a live credentialed service and
   * this project has already spent an afternoon on a plausible number taken for a true one. A
   * bring-up frame should not be the place that changes.
   */
  const frame: Frame = new Map([
    [
      SCREEN_SLOT,
      {
        kind: "detail" as const,
        title: "anchor",
        lines: [
          { label: "device", value: device.id },
          { label: "panel", value: `${width}x${height}` },
          { label: "theme", value: tokens.themeName },
        ],
        footer: "display only · nothing is signed here",
      },
    ],
  ]);

  await device.paint(frame);
  process.stdout.write("painted\n");
  if (options.once) {
    // Exit without closing the device: `close()` sends BLANK, and the whole point of --once is to
    // leave a frame on the panel to look at. The open serial streams would otherwise hold the event
    // loop open forever, so this is an exit rather than a return.
    process.exit(0);
  }

  /*
   * Repaint on a timer even though nothing changes.
   *
   * The paint itself costs no bytes — the dirty-rect diff finds nothing and sends nothing — so this
   * is not traffic, it is the keepalive proving the link is still there. What it demonstrates is
   * the property worth demonstrating: an idle Anchor display puts nothing on the wire at all.
   */
  const timer = setInterval(() => void device.paint(frame).catch(() => {}), 1000);
  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await device.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
