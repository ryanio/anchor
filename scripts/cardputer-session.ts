#!/usr/bin/env node

/**
 * Capture one host session for the Cardputer, as bytes.
 *
 * ```bash
 * node scripts/cardputer-session.ts > session.ndjson
 * node scripts/cardputer-session.ts --page anchor --theme "Tokyo Night"
 * ```
 *
 * The firmware's simulator needs something to render, and the honest something is what the adapter
 * actually writes down the cable rather than a hand-typed approximation of it. This runs the real
 * `Panel` over the real config through the real `CardputerDevice`, against `MemoryLink` instead of
 * a serial port, and prints the lines that would have gone to the device.
 *
 * The desktop snapshot is empty and the service is reported unreachable, because a fixture must not
 * depend on what this machine happens to be doing — and because "anchor is not running" is a state
 * the panel has to render correctly anyway. The palette is the live Omarchy theme, so a capture
 * taken under a different theme is a different, equally valid capture.
 *
 * Nothing here talks to the network, and nothing it prints could ask a device to do anything: the
 * host vocabulary has no verb beyond paint, theme, backlight and ping.
 */

import { CARDPUTER_FLINT, CardputerDevice, MemoryLink } from "../devices/src/adapters/cardputer.ts";
import { loadConfig } from "../devices/src/config.ts";
import { Panel } from "../devices/src/panel.ts";
import { EMPTY_SNAPSHOT } from "../devices/src/state/desktop.ts";
import { loadTokens } from "../devices/src/tokens.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const { config } = loadConfig(flag("config"));
const tokens = loadTokens(flag("theme"));
const link = new MemoryLink();
const device = new CardputerDevice(link, tokens, "capture", CARDPUTER_FLINT);
const panel = new Panel(config, tokens);
const page = flag("page");
if (page !== undefined && !panel.setPage(page)) {
  process.stderr.write(`no page named ${page}\n`);
  process.exit(2);
}

await device.greet();
await device.setBrightness(panel.brightness);
await device.paint(
  panel.build(device, {
    desktop: EMPTY_SNAPSHOT,
    service: { reachable: false, detail: "not running", hasWallet: false, primaryChain: "" },
    themeName: tokens.themeName,
  }),
);

/**
 * Optionally, somebody typing a filter.
 *
 * Driven through `handleKey` rather than written out, so the `query` messages in the capture are
 * the ones the adapter actually emits, including the mode it enters and the escape that abandons
 * it. Worth having in a fixture precisely because it is the sharpest surface on the device: while
 * the box is open no keystroke produces a `DeviceInput` at all, and the committed string only ever
 * narrows rows the host already has.
 */
const filter = flag("filter");
if (filter !== undefined) {
  device.handleKey("/", true);
  for (const character of filter) device.handleKey(character, true);
  device.handleKey("esc", true);
}

process.stdout.write(link.written.join(""));
