#!/usr/bin/env node

/**
 * `anchor-devices` — paint Anchor onto attached hardware.
 *
 * The loop is event-driven with a slow tick underneath it. Hyprland pushes workspace and window
 * changes over socket2; key presses arrive from the device; and a timer covers the things nothing
 * announces — the clock, CPU and memory. Repaints are coalesced, and the adapter skips any slot
 * whose face has not changed, so an idle panel does no USB traffic at all.
 *
 * A theme change is noticed through the snapshot rather than a hook: `omarchy theme current` is
 * already read every refresh, so comparing it costs nothing and needs no install step.
 */

import { NoDeviceError, open as openStreamDeck } from "./adapters/streamdeck.ts";

/** Build a hardware-free device for `--dry-run`. */
async function openVirtual(model: string) {
  const { GEOMETRIES, VirtualDevice } = await import("./adapters/virtual.ts");
  const geometry = GEOMETRIES[model];
  if (geometry === undefined) {
    process.stderr.write(`unknown model ${model}; have: ${Object.keys(GEOMETRIES).join(", ")}\n`);
    process.exit(2);
  }
  return new VirtualDevice(geometry, `virtual:${model}`);
}

import { loadConfig } from "./config.ts";
import { loadGlyphMetrics } from "./glyphs.ts";
import { Panel } from "./panel.ts";
import { clearRasterCache } from "./raster.ts";
import * as anchor from "./state/anchor.ts";
import { EMPTY_PORTFOLIO, type PortfolioSnapshot, type Timeframe } from "./state/anchor.ts";
import { DesktopState } from "./state/desktop.ts";
import * as hypr from "./state/hypr.ts";
import { loadTokens } from "./tokens.ts";

const TICK_MS = 1000;
const SERVICE_POLL_MS = 15000;

interface Options {
  configPath?: string;
  brightness?: number;
  once: boolean;
  list: boolean;
  preview?: string;
  page?: string;
  theme?: string;
  dryRun: boolean;
  model: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { once: false, list: false, dryRun: false, model: "plus" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") options.configPath = argv[++i];
    else if (arg === "--brightness") options.brightness = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--once") options.once = true;
    else if (arg === "--preview") options.preview = argv[++i];
    else if (arg === "--page") options.page = argv[++i];
    else if (arg === "--theme") options.theme = argv[++i];
    else if (arg === "--model") options.model = argv[++i] ?? "plus";
    else if (arg === "--dry-run") {
      options.dryRun = true;
      options.once = true;
    } else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "anchor-devices — Anchor on physical hardware\n\n" +
          "  --config <path>     panel config (default: ~/.config/anchor/devices.json)\n" +
          "  --brightness <0-100>  override configured brightness\n" +
          "  --once              paint one frame and exit\n" +
          "  --preview <file>    also write the frame to a PNG laid out like the device\n" +
          "  --page <name>       start on this page\n" +
          "  --theme <name>      render in this Omarchy theme instead of the active one\n" +
          "  --dry-run           render with no hardware attached; implies --once\n" +
          "  --model <name>      geometry for --dry-run (plus, original, mini, xl)\n" +
          "  --list              list attached devices and exit\n",
      );
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    const { listStreamDecks } = await import("@elgato-stream-deck/node");
    const found = await listStreamDecks();
    if (found.length === 0) process.stdout.write("no devices found\n");
    for (const device of found) {
      process.stdout.write(`${device.model}\t${device.path}\t${device.serialNumber ?? "-"}\n`);
    }
    return;
  }

  const { config, source } = loadConfig(options.configPath);
  let tokens = loadTokens(options.theme);
  const device = options.dryRun ? await openVirtual(options.model) : await openStreamDeck(tokens);
  const panel = new Panel(config, tokens);
  const desktop = new DesktopState();

  // Measure the glyphs this config uses before the first paint, so icons are centred from frame one.
  // Cached on disk per font, so this costs subprocesses once per machine rather than once per run.
  await loadGlyphMetrics(
    config.pages.flatMap((page) => [
      ...page.keys.map((key) => key.icon),
      ...page.dials.map((dial) => dial.icon),
      ...page.segments.map((segment) => segment.icon),
    ]),
  );

  process.stderr.write(
    `anchor-devices: ${device.id} · config ${source} · theme ${tokens.themeName} · ` +
      `${device.capabilities.slots.filter((s) => s.paintable).length} paintable slots\n`,
  );

  if (options.page !== undefined && !panel.setPage(options.page)) {
    process.stderr.write(
      `no page named ${options.page}; have: ${config.pages.map((p) => p.name).join(", ")}\n`,
    );
    process.exit(2);
  }

  await device.setBrightness(options.brightness ?? panel.brightness);

  let service = await anchor.status();
  let portfolio: PortfolioSnapshot = EMPTY_PORTFOLIO;
  let portfolioTimeframe: Timeframe | null = null;
  let painting = false;
  let repaintQueued = false;

  /**
   * Refresh portfolio data, but only when the panel is actually showing it.
   *
   * Three HTTP requests every 30 seconds for a page nobody is looking at is rude to a rate-limited
   * upstream. The service caches, so the cost of asking while the page *is* open is small.
   */
  const refreshPortfolio = async (force = false): Promise<void> => {
    const usesPortfolio =
      panel.page.keys.some(
        (key) =>
          key.source.startsWith("portfolio") ||
          key.source.startsWith("token") ||
          key.source.startsWith("collection"),
      ) || panel.page.segments.some((segment) => segment.source.startsWith("anchor."));
    if (!usesPortfolio) return;
    if (!force && portfolioTimeframe === panel.timeframe && portfolio.detail === "") return;
    portfolioTimeframe = panel.timeframe;
    portfolio = await anchor.portfolio(panel.timeframe);
  };

  const repaint = async (): Promise<void> => {
    if (painting) {
      repaintQueued = true;
      return;
    }
    painting = true;
    try {
      const snapshot = await desktop.get();
      // A pinned theme is a review aid; it must not be overwritten by what the desktop is wearing.
      if (options.theme === undefined && snapshot.theme !== "" && snapshot.theme !== tokens.themeName) {
        // The desktop re-themed; rebuild the palette and force every face to redraw.
        tokens = loadTokens(snapshot.theme);
        panel.tokens = tokens;
        if ("tokens" in device) (device as { tokens: typeof tokens }).tokens = tokens;
        clearRasterCache();
      }
      await device.paint(
        panel.build(device, {
          desktop: snapshot,
          service,
          themeName: tokens.themeName,
          portfolio,
          timeframe: panel.timeframe,
        }),
      );
    } catch (error) {
      process.stderr.write(`paint failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      painting = false;
      if (repaintQueued) {
        repaintQueued = false;
        void repaint();
      }
    }
  };

  await refreshPortfolio();

  if (options.once) {
    await repaint();
    if (options.preview !== undefined) {
      const { composeSvg, writePreview } = await import("./preview.ts");
      const snapshot = await desktop.get();
      const frame = panel.build(device, {
        desktop: snapshot,
        service,
        themeName: tokens.themeName,
        portfolio,
        timeframe: panel.timeframe,
      });
      await writePreview(composeSvg(frame, tokens, device.capabilities.slots), options.preview);
      process.stderr.write(`preview written to ${options.preview}\n`);
    }
    // Deliberately not closing through `device.close()`: that clears the panel, which is right on
    // shutdown and wrong here — the point of --once is to leave a frame on the hardware to look at.
    process.exit(0);
  }

  device.onInput((input) => {
    if (!panel.handle(input)) return;
    // A page switch or a timeframe scrub changes what data is wanted, so ask before repainting.
    void refreshPortfolio().then(() => repaint());
  });

  const unsubscribe = hypr.subscribe((name) => {
    if (
      name.startsWith("workspace") ||
      name.startsWith("active") ||
      name === "openwindow" ||
      name === "closewindow"
    ) {
      desktop.invalidate();
      void repaint();
    }
  });

  const tick = setInterval(() => void repaint(), TICK_MS);
  const servicePoll = setInterval(async () => {
    service = await anchor.status();
    await refreshPortfolio(true);
  }, SERVICE_POLL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    clearInterval(servicePoll);
    unsubscribe();
    await device.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await repaint();
}

main().catch((error: unknown) => {
  if (error instanceof NoDeviceError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
