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

/**
 * Open a Cardputer, over USB CDC.
 *
 * Imported lazily so the Stream Deck path is byte-for-byte what it was: nothing here opens a serial
 * port, shells out to `stty`, or reads `/dev/serial/by-id` unless someone asked for a Cardputer.
 *
 * A named port is taken at its word. A guessed one has to answer first — every ESP32-S3 with native
 * USB enumerates through the same Espressif JTAG/serial descriptor whatever is running on it, so
 * matching the port name identifies a chip family and not a device.
 */
/**
 * Open an ESP32 pulse display over its USB CDC port.
 *
 * The adapter and the serial link both existed; nothing connected them, so a working board sat
 * announcing itself to no one. Over a cable there is no socket to bind and no pairing key to hold,
 * which is why this path needs neither — the network transport in `esp32.ts` still keeps both.
 */
/**
 * Try every port that could be this device, and keep the one that answers as it.
 *
 * Every ESP32-S3 with native USB enumerates through the same Espressif JTAG/serial descriptor, so a
 * port name identifies a chip family and never a device: a Cardputer and a pulse display sitting on
 * one desk are indistinguishable until one of them speaks. Taking `listPorts()[0]` was therefore a
 * coin flip whenever both were plugged in, and the lost half of that flip is not a clean error — the
 * pulse driver opened the Cardputer's port, waited out its handshake timeout, exited 2, and systemd
 * restarted it into the same coin flip. That loop ran 6,601 times before anybody read the journal.
 *
 * A named path is still taken at its word, exactly as before: one candidate, and its error is the
 * one reported. Probing only decides between *several* candidates, and a probe that is not ours is
 * closed immediately rather than left holding a port another service needs.
 */
async function firstPortThatAnswers<T>(
  kind: string,
  candidates: readonly string[],
  attempt: (port: string) => Promise<T>,
): Promise<T> {
  if (candidates.length === 0) {
    process.stderr.write(`no serial port found for ${kind}\n`);
    process.exit(2);
  }
  const failures: string[] = [];
  for (const port of candidates) {
    try {
      return await attempt(port);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`  ${port}: ${detail}`);
      // One candidate and it failed: that is a named port, or the only port there is. Its own error
      // is more use than a summary of a list with one entry in it.
      if (candidates.length === 1) {
        process.stderr.write(`${detail}\n`);
        process.exit(2);
      }
    }
  }
  process.stderr.write(`no port answered as ${kind}:\n${failures.join("\n")}\n`);
  process.exit(2);
}

async function openEsp32(tokens: Tokens, path?: string) {
  const { listPorts, openSerialLink } = await import("./adapters/esp32-serial.ts");
  const { attach } = await import("./adapters/esp32.ts");
  const candidates = path === undefined ? listPorts() : [path];
  // Shorter than the 5s default when there is a list to get through: a pulse display sends HELLO
  // unprompted every 500ms, so a port that has not spoken in two seconds is not one.
  const timeoutMs = candidates.length > 1 ? 2000 : 5000;
  return await firstPortThatAnswers("an ESP32 pulse display", candidates, async (port) => {
    const link = openSerialLink(port);
    try {
      return await attach(link, tokens, {}, timeoutMs);
    } catch (error) {
      // Whatever this port is, it is not ours to hold open — the Cardputer service needs its own.
      link.close();
      throw error;
    }
  });
}

async function openCardputer(tokens: Tokens, path?: string) {
  const { listPorts, open } = await import("./adapters/cardputer.ts");
  const candidates = path === undefined ? listPorts() : [path];
  return await firstPortThatAnswers("a Cardputer", candidates, (port) =>
    // A named path keeps its old behaviour of being taken at its word; a guessed one has to answer.
    open(tokens, port, { confirmMs: path === undefined ? 3000 : 0 }),
  );
}

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
import { prefetch } from "./images.ts";
import { BROWSE_PAGES, Panel, type PanelState, STRIP_SLOT } from "./panel.ts";
import { clearRasterCache } from "./raster.ts";
import * as anchor from "./state/anchor.ts";
import { EMPTY_PORTFOLIO, type PortfolioSnapshot, type Timeframe } from "./state/anchor.ts";
import { DesktopState, sessionLocked } from "./state/desktop.ts";
import type { TrendingCollection, TrendingToken } from "./state/discovery.ts";
import * as discovery from "./state/discovery.ts";
import * as hypr from "./state/hypr.ts";
import { loadTokens, type Tokens } from "./tokens.ts";

const TICK_MS = 1000;
const SERVICE_POLL_MS = 15000;
/**
 * Liveness for a device that can tell the difference between an idle host and a dead one.
 *
 * An unchanged panel writes nothing, which is the whole reason an idle device costs no USB traffic
 * — but from the far end of the cable silence and a crashed host look identical. The Cardputer
 * firmware treats fifteen seconds of it as a lost link, so the host speaks every five.
 */
const PING_MS = 5000;

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
  cardputer: boolean;
  cardputerPath?: string;
  esp32: boolean;
  esp32Path?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    once: false,
    list: false,
    dryRun: false,
    model: "plus",
    cardputer: false,
    esp32: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") options.configPath = argv[++i];
    else if (arg === "--brightness") options.brightness = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--once") options.once = true;
    else if (arg === "--preview") options.preview = argv[++i];
    else if (arg === "--page") options.page = argv[++i];
    else if (arg === "--theme") options.theme = argv[++i];
    else if (arg === "--model") options.model = argv[++i] ?? "plus";
    else if (arg === "--cardputer") {
      options.cardputer = true;
      // An optional path, so `--cardputer /dev/ttyACM1` names one and `--cardputer` finds one.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) options.cardputerPath = argv[++i];
    } else if (arg === "--dry-run") {
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
          "  --cardputer [port]  drive an M5Stack Cardputer over USB CDC instead of a Stream Deck\n" +
          "  --esp32 [port]      drive an ESP32 pulse display over USB CDC\n" +
          "  --list              list attached devices and exit\n",
      );
      process.exit(0);
    } else if (arg === "--esp32") {
      options.esp32 = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) options.esp32Path = argv[++i];
    }
  }
  return options;
}

/**
 * Which piece a rotating gallery is showing.
 *
 * Six seconds. Derived from the clock rather than a counter so every key agrees without the panel
 * holding state, and so a repaint triggered by something else does not advance the gallery.
 */
const ROTATE_MS = 6000;
/**
 * The clock, as the panel is given it: which window, how far through it, and the reading itself.
 *
 * One `Date.now()` for all three, on purpose. Read separately they can straddle a window boundary
 * and hand the panel an index from one window with a progress from the next — a full sync bar over
 * an item that already changed, which is precisely the claim that bar exists to make honestly. The
 * raw reading goes too, because `Panel`'s tap hold is a deadline in milliseconds and it must be
 * measured against the same clock the rotation came from, not a second sample of it.
 */
function rotationNow(): { rotation: number; rotationProgress: number; nowMs: number } {
  const nowMs = Date.now();
  return {
    rotation: Math.floor(nowMs / ROTATE_MS),
    rotationProgress: (nowMs % ROTATE_MS) / ROTATE_MS,
    nowMs,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    const { listStreamDecks } = await import("@elgato-stream-deck/node");
    const { listPorts } = await import("./adapters/cardputer.ts");
    const found = await listStreamDecks();
    const ports = listPorts();
    if (found.length === 0 && ports.length === 0) process.stdout.write("no devices found\n");
    for (const device of found) {
      process.stdout.write(`${device.model}\t${device.path}\t${device.serialNumber ?? "-"}\n`);
    }
    // Listed as a candidate rather than as a Cardputer, because that is all the descriptor says.
    // Every ESP32-S3 with native USB enumerates through the same Espressif JTAG/serial device, and
    // the board on this desk that looked exactly like a Cardputer turned out to be an N16R8 devkit.
    // Only the handshake `--cardputer` performs can tell them apart.
    for (const port of ports) process.stdout.write(`esp32?\t${port}\t-\n`);
    return;
  }

  const { config, source } = loadConfig(options.configPath);
  let tokens = loadTokens(options.theme);
  const openDevice = async () =>
    options.dryRun
      ? await openVirtual(options.model)
      : options.esp32
        ? await openEsp32(tokens, options.esp32Path)
        : options.cardputer
          ? await openCardputer(tokens, options.cardputerPath)
          : await openStreamDeck(tokens);

  let device = await openDevice();
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
  let discoveryTokens: readonly TrendingToken[] = [];
  let discoveryCollections: readonly TrendingCollection[] = [];
  let discoveryTokensFetched = false;
  let discoveryCollectionsFetched = false;
  let discoveryDetail: PanelState["discoveryDetail"];
  let painting = false;
  let repaintQueued = false;
  let reconnecting = false;

  /**
   * Reopen the device after it stops answering.
   *
   * A USB device can go away and come back under the same path: an ESP32 resets and re-enumerates,
   * a Stream Deck wedges. The old handle stays open and writable and goes nowhere, so a panel that
   * opened once at startup paints into a dead file descriptor for as long as it runs — which looks
   * exactly like the hardware died. Reopening is the whole fix; the backoff is so a device that is
   * genuinely unplugged does not spin.
   *
   * Not used by `--once` or `--dry-run`: a single frame has nothing to recover into.
   */
  const reconnect = async (): Promise<void> => {
    if (reconnecting || options.once || options.dryRun) return;
    reconnecting = true;
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15_000)));
      try {
        try {
          await device.close();
        } catch {
          // The old handle is why we are here; failing to close it changes nothing.
        }
        device = await openDevice();
        listen();
        await device.setBrightness(deckBrightness);
        process.stderr.write(`reconnected to ${device.id}\n`);
        reconnecting = false;
        void repaint();
        return;
      } catch (error) {
        if (attempt === 0) {
          process.stderr.write(
            `device went away (${error instanceof Error ? error.message : String(error)}); retrying\n`,
          );
        }
      }
    }
  };

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
    portfolio = await anchor.portfolio(panel.timeframe, undefined, undefined, (partial) => {
      // The stat tiles, the tokens and the gallery each come from a different request; painting as
      // each lands is what turns a cold cache from one long "loading…" into tiles that fill in as
      // their own data actually arrives, instead of all of them waiting on the slowest.
      portfolio = { ...portfolio, ...partial };
      if (!options.once) void repaint();
    });
    // Warm the gallery. The daemon does it in the background — a rotation must never wait on a
    // socket — but a single frame has no second chance, so --once waits: a preview with the art
    // missing is not a preview of what the device shows.
    // The whole gallery, not a window of it: the rotation index sweeps every piece, so warming the
    // first two dozen leaves the rest blank exactly when their turn comes round. The set is bounded
    // by the request that fetched it and the images are small.
    const warming = prefetch(portfolio.nfts.map((piece) => piece.imageUrl));
    if (options.once) {
      await warming;
    } else {
      void warming.then(() => repaint());
    }
  };

  /**
   * Trending tokens/NFTs — what anyone can look up, not what Ryan owns, so unlike `refreshPortfolio`
   * this never needs a wallet configured. Fetched once per page, then kept warm by the same
   * `servicePoll` beat portfolio data already rides.
   */
  /**
   * The holders and buy/sell feed behind the one item the browse mode has open.
   *
   * Two requests, made only for the item somebody actually pressed Enter on — the trending list is
   * twenty rows and fetching all of their depth up front would be forty requests for the
   * nineteen nobody looked at. `onPartial` repaints as each half lands, exactly as
   * `refreshPortfolio` does, so the Holders facet fills in while the activity feed is still in
   * flight instead of both waiting on the slower one.
   *
   * The id is carried alongside the data and `Panel` refuses to paint rows whose id is not the open
   * item's, so a second item opened mid-flight shows "loading…" rather than the first one's holders
   * under its name.
   */
  const refreshBrowseDetail = async (): Promise<void> => {
    const open = panel.browseDetail;
    if (open === null || discoveryDetail?.id === open.id) return;
    discoveryDetail = { id: open.id };
    if (open.kind === "token") {
      const token = discoveryTokens.find((entry) => entry.address === open.id);
      if (token === undefined) return;
      await discovery.tokenDetail(token, (partial) => {
        discoveryDetail = { ...discoveryDetail, id: open.id };
        if (partial.holders !== undefined) {
          discoveryDetail = { ...discoveryDetail, id: open.id, tokenHolders: partial.holders };
        }
        if (partial.activity !== undefined) {
          discoveryDetail = { ...discoveryDetail, id: open.id, tokenActivity: partial.activity };
        }
        void repaint();
      });
      return;
    }
    await discovery.collectionDetail(open.id, (partial) => {
      if (partial.holders === undefined) return;
      discoveryDetail = { ...discoveryDetail, id: open.id, collectionHolders: partial.holders };
      void repaint();
    });
  };

  const refreshDiscovery = async (force = false): Promise<void> => {
    const pageName = panel.pageName;
    const browses = BROWSE_PAGES.get(pageName);
    if (browses !== undefined) {
      // A browse page needs the same trending list the ambient pages rotate through, plus the depth
      // behind whichever item is open. Same fetches, same module — the browse mode is a second view
      // of this data, not a second source for it.
      if (browses === "token" && (force || !discoveryTokensFetched)) {
        discoveryTokensFetched = true;
        discoveryTokens = await discovery.trendingTokens();
      }
      if (browses === "nft" && (force || !discoveryCollectionsFetched)) {
        discoveryCollectionsFetched = true;
        discoveryCollections = await discovery.trendingCollections();
      }
      await refreshBrowseDetail();
      return;
    }
    if (pageName !== "tokens" && pageName !== "nfts") return;
    if (pageName === "tokens") {
      if (!force && discoveryTokensFetched) return;
      discoveryTokensFetched = true;
      discoveryTokens = await discovery.trendingTokens();
      void prefetch(discoveryTokens.map((t) => t.imageUrl)).then(() => repaint());
    } else {
      if (!force && discoveryCollectionsFetched) return;
      discoveryCollectionsFetched = true;
      discoveryCollections = await discovery.trendingCollections();
      void prefetch(discoveryCollections.map((c) => c.imageUrl)).then(() => repaint());
    }
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
          ...rotationNow(),
          discoveryTokens,
          discoveryCollections,
          discoveryDetail,
        }),
      );
    } catch (error) {
      process.stderr.write(`paint failed: ${error instanceof Error ? error.message : String(error)}\n`);
      void reconnect();
    } finally {
      painting = false;
      if (repaintQueued) {
        repaintQueued = false;
        void repaint();
      }
    }
  };

  await refreshPortfolio();
  await refreshDiscovery();

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
        ...rotationNow(),
        discoveryTokens,
        discoveryCollections,
        discoveryDetail,
      });
      await writePreview(composeSvg(frame, tokens, device.capabilities.slots), options.preview);
      process.stderr.write(`preview written to ${options.preview}\n`);
    }
    // Deliberately not closing through `device.close()`: that clears the panel, which is right on
    // shutdown and wrong here — the point of --once is to leave a frame on the hardware to look at.
    process.exit(0);
  }

  let deckBrightness = panel.deckBrightness;
  /**
   * Attach input handling to whichever device is current.
   *
   * Called again after a reconnect: the handlers live on the device object, so a replacement opened
   * after a reset would take input from nobody. Keys going dead after a recovery is a worse bug
   * than the disconnect it recovered from, because it looks like the software is simply broken.
   */
  /*
   * Every input the device sends, when asked for.
   *
   * Off by default and not a log level: a daemon that narrates a person's keypresses into the
   * journal by default is the wrong shape. But the question "is this device sending anything at
   * all" is the first one to ask of any input that appears not to work, and without this the only
   * way to ask it is to stop the service and attach a bespoke script — which takes the panel down
   * and so cannot observe the device in the state anybody is complaining about. Set
   * ANCHOR_DEVICES_DEBUG=input and tap the thing.
   *
   * It prints inputs the panel *rejected* too, since "arrived and was ignored" and "never arrived"
   * are the two answers and they need telling apart.
   */
  const debugInput = (process.env.ANCHOR_DEVICES_DEBUG ?? "").split(",").includes("input");

  const listen = (): void => {
    device.onInput((input) => {
      if (debugInput) process.stderr.write(`input: ${JSON.stringify(input)}\n`);
      if (!panel.handle(input)) {
        if (debugInput) process.stderr.write(`input: ${input.kind} on ${input.slot} — panel ignored it\n`);
        return;
      }
      if (panel.deckBrightness !== deckBrightness) {
        deckBrightness = panel.deckBrightness;
        void device.setBrightness(deckBrightness);
      }
      // A page switch or a timeframe scrub changes what data is wanted, so ask before repainting.
      void refreshPortfolio().then(() => repaint());
      void refreshDiscovery().then(() => repaint());
    });
  };
  listen();

  /**
   * A committed filter string from a device with a keyboard.
   *
   * The decision to treat typed text as a filter is made here rather than in the adapter, and that
   * is deliberate: the Cardputer adapter never turns a keystroke into a `DeviceInput` at all — its
   * tests exhaust the key space to prove it — so a keyboard cannot manufacture panel input on its
   * own. This is the host choosing, at one call site, to narrow rows it already has. Nothing
   * evaluates the string, it never reaches `actions.dispatch`, and it is never a query parameter to
   * the data service; that would be an untrusted device steering the host's requests.
   */
  if ("onQuery" in device) {
    (device as { onQuery(handler: (text: string) => void): void }).onQuery((text) => {
      if (!panel.handle({ kind: "text", slot: STRIP_SLOT, value: text })) return;
      void repaint();
    });
  }

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

  // Blanking is checked on its own beat and only acted on when it changes, so a locked session
  // costs one subprocess per tick and no USB traffic at all.
  let blanked = false;
  const lockWatch = setInterval(async () => {
    const locked = await sessionLocked();
    if (locked === blanked) return;
    blanked = locked;
    await device.setBlanked?.(locked);
    if (!locked) void repaint();
  }, TICK_MS);

  const tick = setInterval(() => {
    if (!blanked) void repaint();
  }, TICK_MS);
  const servicePoll = setInterval(async () => {
    service = await anchor.status();
    await refreshPortfolio(true);
    await refreshDiscovery(true);
  }, SERVICE_POLL_MS);
  // Only a device that can lose the link needs one; a Stream Deck notices a dead host by being
  // unplugged from it.
  const ping =
    "ping" in device
      ? setInterval(() => {
          void (device as { ping(): Promise<void> }).ping();
        }, PING_MS)
      : null;

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    clearInterval(lockWatch);
    clearInterval(servicePoll);
    if (ping !== null) clearInterval(ping);
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
