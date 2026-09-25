/**
 * The panel against a device that does not exist.
 *
 * This is the test the device contract is *for*. If panel logic can be driven by a fake with
 * different slots from a Stream Deck, then the ESP32 and Cardputer adapters are a rendering problem
 * rather than a rewrite. A fake with only two keys and no strip stands in for the small device.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, describe, test } from "node:test";
import { useFakeProcesses } from "./actions.ts";
import { GEOMETRIES, type Geometry, VirtualDevice } from "./adapters/virtual.ts";
import { loadConfig, parseConfig } from "./config.ts";
import type { PanelState } from "./panel.ts";
import {
  dialSlot,
  keySlot,
  Panel,
  PRESS_FLASH_MS,
  readKeySource,
  SCREEN_SLOT,
  SEGMENT_SOURCES,
  STRIP_SLOT,
  usd,
} from "./panel.ts";
import { EMPTY_SNAPSHOT } from "./state/desktop.ts";
import { gridMetrics } from "./svg.ts";
import { toTokens } from "./tokens.ts";
import type { AnchorDevice, DeviceCapabilities, Frame, SlotSpec } from "./types.ts";

// `panel.handle({ kind: "press", ... })` on a key with a real action really dispatches it —
// that is the behaviour under test. Without this, a fixture NFT's fake `openseaUrl` was opening a
// real, broken opensea.io/item/1 in a real browser once per test run, because nothing here stood
// between `actions.dispatch` and the desktop it was written to command. A restorer per file, not
// per test: cheap, and it means a new test that presses a key needs to know nothing about this.
const fakeChild = (): EventEmitter & { unref(): void } => Object.assign(new EventEmitter(), { unref() {} });

let restoreProcesses: () => void;
const spawned: string[][] = [];
before(() => {
  restoreProcesses = useFakeProcesses(
    (command, args) => {
      spawned.push([command, ...args]);
      return fakeChild();
    },
    (_command, _args, callback) => {
      callback(new Error("fake execFile: no real process runs in this test file"), "", "");
      return fakeChild();
    },
  );
});
after(() => restoreProcesses());

const TOKENS = toTokens("Test", { accent: "#7aa2f7" });

const OFFLINE = { reachable: false, detail: "not running", hasWallet: false, primaryChain: "" };

function fakeDevice(slots: SlotSpec[]): AnchorDevice {
  const capabilities: DeviceCapabilities = { slots, inputs: ["press", "release", "rotate"] };
  return {
    id: "fake",
    capabilities,
    paint: async () => {},
    setBrightness: async () => {},
    onInput: () => {},
    close: async () => {},
  };
}

const streamDeckPlus = (): AnchorDevice => new VirtualDevice(GEOMETRIES.plus as Geometry);

const CONFIG = parseConfig({
  pages: [
    {
      name: "desktop",
      keys: [
        { index: 0, label: "One", action: "hypr workspace 1", state: "workspace:1" },
        { index: 1, label: "Go", action: "page other" },
      ],
      dials: [{ index: 0, label: "Vol", control: "volume", press: "volume mute" }],
      segments: [{ source: "workspace" }, { source: "theme" }],
    },
    { name: "other", keys: [{ index: 0, label: "Back", action: "page desktop" }] },
  ],
});

const state = (overrides: Partial<typeof EMPTY_SNAPSHOT> = {}) => ({
  desktop: { ...EMPTY_SNAPSHOT, ...overrides },
  service: OFFLINE,
});

describe("Panel.build", () => {
  test("fills configured keys and blanks the rest", () => {
    const panel = new Panel(CONFIG, TOKENS);
    const device = streamDeckPlus();
    const frame = panel.build(device, state());
    assert.equal(frame.size, 9, "8 keys and the strip");
    for (const slot of device.capabilities.slots) {
      if (slot.paintable) assert.ok(frame.has(slot.id), `${slot.id} was left unpainted`);
    }
    // The Plus's encoders take input but have no display; a frame for one would be rasterised and
    // thrown away.
    assert.equal(frame.has(dialSlot(0)), false);
    const configured = frame.get(keySlot(0));
    assert.equal(configured?.kind === "tile" && configured.label, "One");
    const blank = frame.get(keySlot(5));
    assert.equal(blank?.kind === "tile" && blank.label, undefined);
  });

  test("marks a key active from live state", () => {
    const panel = new Panel(CONFIG, TOKENS);
    const inactive = panel.build(streamDeckPlus(), state({ workspace: 2 })).get(keySlot(0));
    const active = panel.build(streamDeckPlus(), state({ workspace: 1 })).get(keySlot(0));
    assert.equal(inactive?.kind === "tile" && inactive.emphasis, "ground");
    assert.equal(active?.kind === "tile" && active.emphasis, "active");
  });

  test("drives a device with fewer slots and no strip", () => {
    const small = fakeDevice([{ id: keySlot(0), kind: "key", paintable: true, width: 64, height: 64 }]);
    const frame: Frame = new Panel(CONFIG, TOKENS).build(small, state());
    assert.deepEqual([...frame.keys()], [keySlot(0)]);
    assert.equal(frame.has(STRIP_SLOT), false);
  });

  test("the strip renders one segment per configured source", () => {
    const frame = new Panel(CONFIG, TOKENS).build(streamDeckPlus(), state({ workspace: 3, theme: "Nord" }));
    const bar = frame.get(STRIP_SLOT);
    assert.equal(bar?.kind, "bar");
    assert.deepEqual(bar?.kind === "bar" ? bar.segments.map((s) => s.text) : [], ["ws 3", "Nord"]);
  });
});

describe("Panel.handle", () => {
  test("a page action switches page, and the new page renders", () => {
    const panel = new Panel(CONFIG, TOKENS);
    assert.equal(panel.pageName, "desktop");
    panel.handle({ kind: "press", slot: keySlot(1) });
    assert.equal(panel.pageName, "other");
    const label = panel.build(streamDeckPlus(), state()).get(keySlot(0));
    assert.equal(label?.kind === "tile" && label.label, "Back");
  });

  test("a press then release changes emphasis so the key visibly depresses", () => {
    const panel = new Panel(CONFIG, TOKENS);
    panel.handle({ kind: "press", slot: keySlot(0) });
    const down = panel.build(streamDeckPlus(), state()).get(keySlot(0));
    assert.equal(down?.kind === "tile" && down.emphasis, "raised");
    panel.handle({ kind: "release", slot: keySlot(0) });
    const up = panel.build(streamDeckPlus(), state()).get(keySlot(0));
    assert.notEqual(up?.kind === "tile" && up.emphasis, "raised");
  });

  test("swiping the strip pages, and wraps at both ends", () => {
    const panel = new Panel(CONFIG, TOKENS);
    panel.handle({ kind: "swipe", slot: STRIP_SLOT, from: 700, to: 100 });
    assert.equal(panel.pageName, "other");
    panel.handle({ kind: "swipe", slot: STRIP_SLOT, from: 700, to: 100 });
    assert.equal(panel.pageName, "desktop", "should wrap round");
    panel.handle({ kind: "swipe", slot: STRIP_SLOT, from: 100, to: 700 });
    assert.equal(panel.pageName, "other", "should wrap backwards too");
  });

  test("setPage refuses a page that does not exist", () => {
    const panel = new Panel(CONFIG, TOKENS);
    assert.equal(panel.setPage("nope"), false);
    assert.equal(panel.pageName, "desktop");
  });

  test("input for a slot with nothing configured is harmless", () => {
    const panel = new Panel(CONFIG, TOKENS);
    assert.equal(panel.handle({ kind: "rotate", slot: dialSlot(3), delta: 1 }), false);
    assert.doesNotThrow(() => panel.handle({ kind: "press", slot: keySlot(7) }));
  });
});

/** Look up a segment source, failing the test if the name does not exist. */
function source(name: string, panelState: PanelState, page = "desktop"): string {
  const fn = SEGMENT_SOURCES[name];
  assert.ok(fn !== undefined, `no segment source named ${name}`);
  return fn(panelState, page);
}

describe("SEGMENT_SOURCES", () => {
  test("absent readings render as a dash, not a zero", () => {
    // A zero is a reading. On a machine with no backlight, claiming 0% brightness is a false one.
    assert.equal(source("brightness", state()), "—");
    assert.equal(source("workspace", state()), "—");
    assert.equal(source("cpu", state()), "—");
    assert.equal(source("theme", state()), "—");
  });

  test("the anchor segment distinguishes down, up-without-wallet, and ready", () => {
    const down = source("anchor.service", state(), "anchor");
    const noWallet = source(
      "anchor.service",
      {
        desktop: EMPTY_SNAPSHOT,
        service: { reachable: true, detail: "no wallet", hasWallet: false, primaryChain: "ethereum" },
      },
      "anchor",
    );
    const ready = source(
      "anchor.service",
      {
        desktop: EMPTY_SNAPSHOT,
        service: { reachable: true, detail: "", hasWallet: true, primaryChain: "ethereum" },
      },
      "anchor",
    );
    assert.match(down, /not running/);
    assert.match(noWallet, /no wallet/);
    assert.match(ready, /ready/);
    assert.notEqual(noWallet, ready, "a service with no wallet must not read as a working portfolio");
  });

  test("volume reports muted rather than a percentage", () => {
    assert.equal(source("volume", state({ volume: 0.5, muted: true })), "muted");
    assert.equal(source("volume", state({ volume: 0.5, muted: false })), "50%");
  });
});

const PORTFOLIO = {
  stats: {
    totalUsd: "125430.50",
    nftUsd: "98200",
    tokenUsd: "27230.50",
    pnlAbsolute: "1250.00",
    pnlPercentage: "1.01",
    timeframe: "DAY",
  },
  tokens: [
    { symbol: "ETH", usdValue: 18400.22, status: "OK", chain: "ethereum", openseaUrl: "" },
    { symbol: "USDC", usdValue: 6210.4, status: "OK", chain: "ethereum", openseaUrl: "" },
  ],
  nftCount: 42,
  topCollections: [{ slug: "azuki", count: 12 }],
  history: [2111.65, 2140.2, 2098.4, 2201.9, 2249.41, 2221.32],
  nfts: [
    {
      name: "OnChainChain #688",
      collection: "onchainchain",
      imageUrl: "https://example.test/a.png",
      openseaUrl: "",
    },
    { name: "Ofrenda #39", collection: "ofrenda", imageUrl: "https://example.test/b.png", openseaUrl: "" },
  ],
  chains: [
    { chain: "ethereum", usdValue: 1330.65 },
    { chain: "blast", usdValue: 129.35 },
    { chain: "base", usdValue: 114.34 },
  ],
  ageSeconds: 34,
  stale: false,
  detail: "",
};

const withPortfolio = { ...state(), portfolio: PORTFOLIO, timeframe: "DAY" as const };

describe("usd", () => {
  test("formats for a glance, grouping thousands", () => {
    assert.equal(usd("125430.50"), "$125,431");
    assert.equal(usd("12.5"), "$12.50");
  });

  test("an absent or unparseable amount is a dash, never $NaN", () => {
    assert.equal(usd(null), "—");
    assert.equal(usd("n/a"), "—");
    assert.equal(usd(""), "—");
  });
});

describe("KEY_SOURCES", () => {
  test("read the portfolio overview", () => {
    assert.equal(readKeySource("portfolio.total", withPortfolio)?.value, "$125,431");
    assert.equal(readKeySource("portfolio.nft", withPortfolio)?.value, "$98,200");
    assert.equal(readKeySource("portfolio.token", withPortfolio)?.value, "$27,231");
    assert.equal(readKeySource("portfolio.nftCount", withPortfolio)?.value, "42");
  });

  test("P&L carries its sign in the tone, not just the text", () => {
    // Colour is the only part of this a person reads from across a desk.
    const up = readKeySource("portfolio.pnl", withPortfolio);
    assert.equal(up?.value, "+1.01%");
    assert.equal(up?.tone, "positive");

    const down = readKeySource("portfolio.pnl", {
      ...withPortfolio,
      portfolio: { ...PORTFOLIO, stats: { ...PORTFOLIO.stats, pnlPercentage: "-4.2" } },
    });
    assert.equal(down?.value, "-4.20%");
    assert.equal(down?.tone, "negative");
  });

  test("a flat P&L is neither positive nor negative", () => {
    const flat = readKeySource("portfolio.pnl", {
      ...withPortfolio,
      portfolio: { ...PORTFOLIO, stats: { ...PORTFOLIO.stats, pnlPercentage: "0" } },
    });
    assert.equal(flat?.tone, undefined);
  });

  test("token:N selects by rank and captions itself with the symbol", () => {
    assert.equal(readKeySource("token:1", withPortfolio)?.label, "ETH");
    assert.equal(readKeySource("token:2", withPortfolio)?.label, "USDC");
  });

  test("a missing holding keeps its caption so the key still says what it is for", () => {
    const empty = readKeySource("token:3", withPortfolio);
    assert.equal(empty?.value, "—");
    assert.equal(empty?.label, "Top 3");
  });

  test("every reading is a dash, never a zero, with no data at all", () => {
    // A zero is a reading. "No wallet configured" must not render as a $0 portfolio.
    for (const source of ["portfolio.total", "portfolio.nft", "portfolio.pnl", "token:1", "collection:1"]) {
      assert.equal(readKeySource(source, state())?.value, "—", source);
    }
  });

  test("an unknown source is null rather than a guess", () => {
    assert.equal(readKeySource("portfolio.nonsense", withPortfolio), null);
  });
});

describe("the timeframe dial", () => {
  const config = parseConfig({
    pages: [
      {
        name: "portfolio",
        keys: [{ index: 0, source: "portfolio.total" }],
        dials: [{ index: 0, control: "timeframe" }],
      },
    ],
  });

  test("scrubs forward and wraps", () => {
    const panel = new Panel(config, TOKENS);
    assert.equal(panel.timeframe, "DAY");
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: 1 });
    assert.equal(panel.timeframe, "WEEK");
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: 1 });
    assert.equal(panel.timeframe, "MONTH");
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: 1 });
    assert.equal(panel.timeframe, "HOUR", "should wrap round");
  });

  test("scrubs backward too", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: -1 });
    assert.equal(panel.timeframe, "HOUR");
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: -1 });
    assert.equal(panel.timeframe, "MONTH", "should wrap backwards");
  });

  test("changes what the P&L key is captioned with", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "rotate", slot: dialSlot(0), delta: 1 });
    const reading = readKeySource("portfolio.pnl", { ...withPortfolio, timeframe: panel.timeframe });
    assert.equal(reading?.label, "P&L week");
  });
});

/** A device with one screen and no keys — a Cardputer or an ESP32 panel, in the abstract. */
const screenDevice = (): AnchorDevice =>
  fakeDevice([{ id: SCREEN_SLOT, kind: "screen", paintable: true, width: 240, height: 135 }]);

/** The panel Ryan is actually looking at: 368x448 of portrait AMOLED with a finger on it. */
const PULSE_SLOT: SlotSpec = { id: SCREEN_SLOT, kind: "screen", paintable: true, width: 368, height: 448 };
const pulseDevice = (): AnchorDevice => fakeDevice([PULSE_SLOT]);

describe("screen devices", () => {
  // Named "assets" rather than "portfolio" on purpose: that name is reserved now — a screen device on
  // the real `portfolio` (or `gallery`) page gets `pulseDetail`'s ambient view instead of a list, and
  // these tests are about list mechanics generically, not about that page.
  const config = parseConfig({
    pages: [
      {
        name: "assets",
        keys: [
          { index: 0, label: "Total", source: "portfolio.total" },
          { index: 1, label: "Ethereum", action: "exec true" },
          { index: 2, label: "Solana", action: "exec true" },
        ],
      },
    ],
  });

  test("the same page composes as a grid, with no adapter fetching anything", () => {
    // This is the claim of the whole layer: one page config, two very different devices.
    const frame = new Panel(config, TOKENS).build(screenDevice(), withPortfolio);
    const grid = frame.get(SCREEN_SLOT);
    assert.equal(grid?.kind, "grid");
    if (grid?.kind !== "grid") return;
    assert.deepEqual(
      grid.cells.map((c) => c.label),
      ["Total", "Ethereum", "Solana"],
    );
    assert.equal(grid.cells[0]?.value, "$125,431");
    // A key grid carries the same reading.
    const tile = new Panel(config, TOKENS).build(streamDeckPlus(), withPortfolio).get(keySlot(0));
    assert.equal(tile?.kind === "tile" && tile.value, "$125,431");
  });

  test("a cell says whether the thing it controls is on, which a row could not", () => {
    // The reason a grid is worth more than taller rows: the desktop page's toggles have a state,
    // and the list surface had no word for it, so a screen device could not show night light on.
    const toggles = parseConfig({
      pages: [
        {
          name: "desktop",
          keys: [
            { index: 0, label: "Night", action: "noop", state: "nightlight" },
            { index: 1, label: "Shot", action: "noop" },
          ],
        },
      ],
    });
    const lit = { ...withPortfolio, desktop: { ...withPortfolio.desktop, nightlight: true } };
    const grid = new Panel(toggles, TOKENS).build(pulseDevice(), lit).get(SCREEN_SLOT);
    assert.deepEqual(grid?.kind === "grid" ? grid.cells.map((c) => c.emphasis) : [], ["active", "ground"]);
  });

  test("rotation moves the selection, and the panel owns it", () => {
    const panel = new Panel(config, TOKENS);
    assert.equal(panel.selected, 0);
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: 1 });
    assert.equal(panel.selected, 1);
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: -1 });
    assert.equal(panel.selected, 0);
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: -1 });
    assert.equal(panel.selected, 0, "must not select above the first row");
  });

  test("selection is clamped to the cells that exist", () => {
    const panel = new Panel(config, TOKENS);
    for (let i = 0; i < 10; i++) panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: 1 });
    const grid = panel.build(screenDevice(), withPortfolio).get(SCREEN_SLOT);
    assert.equal(grid?.kind === "grid" && grid.selected, 2, "three cells means the last index is 2");
  });
});

/**
 * A tap on a cell, on a page that does not rotate.
 *
 * The geometry is `svg.gridCellAt`'s and is asserted there; what these are about is the panel's
 * half — that a touch reaches the key under the finger and only that key, that a touch reaching
 * nothing stays nothing, and that a filtered page does not run the key it used to have at that
 * index.
 */
describe("a tap on a grid cell", () => {
  const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const config = parseConfig({
    pages: [
      {
        name: "desktop",
        // Each key switches to its own page, so "which action ran" is a question with six distinct
        // answers rather than one that any of them could have produced.
        keys: NAMES.map((name, index) => ({ index, label: name, action: `page ${name}` })),
      },
      ...NAMES.map((name) => ({ name })),
    ],
  });

  /**
   * The centre of each cell, derived from `gridMetrics` rather than written out.
   *
   * These were six hardcoded pixel pairs, on the reasoning that a layout change should surface here
   * as a failing test rather than being followed silently. That reasoning is right and the place for
   * it is `svg.test.ts`, which pins the columns, the rows and the cell size against the panel's
   * measured ppi — one assertion about the geometry, in the file that owns it. Repeating it as
   * coordinates here bought nothing and cost this: the layout gained a margin to clear the panel's
   * rounded corners, and six tests about *what a tap reaches* began failing over *where a cell is*,
   * which is a different question and not theirs to answer.
   */
  const gridAt = (index: number): { x: number; y: number } => {
    const metrics = gridMetrics(PULSE_SLOT, NAMES.length);
    const column = index % metrics.columns;
    const row = Math.floor(index / metrics.columns);
    return {
      x: metrics.originX + column * metrics.cellWidth + Math.round(metrics.cellWidth / 2),
      y: metrics.originY + row * metrics.cellHeight + Math.round(metrics.cellHeight / 2),
    };
  };
  const CENTRES = NAMES.map((_name, index) => gridAt(index));

  const painted = (panel: Panel): Panel => {
    panel.build(pulseDevice(), state());
    return panel;
  };

  test("selects the cell the finger landed on", () => {
    const panel = painted(new Panel(config, TOKENS));
    const third = CENTRES[2] ?? { x: 0, y: 0 };
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...third }), true, "repaints");
    assert.equal(panel.selected, 2);
    // Back to the page that has the cells on it: the tap ran `page charlie`, and charlie has none.
    panel.setPage("desktop");
    const grid = panel.build(pulseDevice(), state()).get(SCREEN_SLOT);
    assert.equal(grid?.kind === "grid" && grid.selected, 2, "and the frame shows which one");
  });

  test("runs that cell's action, not the one that happened to be selected", () => {
    const panel = painted(new Panel(config, TOKENS));
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: 1 });
    painted(panel);
    assert.equal(panel.selected, 1);
    const fifth = CENTRES[4] ?? { x: 0, y: 0 };
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...fifth });
    assert.equal(panel.pageName, "echo", "the tapped cell's action ran, not the selected one's");
    assert.equal(panel.selected, 4);
  });

  test("a touch in the gutter between two tiles reaches neither", () => {
    // The sleeve case the old refusal existed for: between two targets is not a target.
    const panel = painted(new Panel(config, TOKENS));
    // The seam between the first two columns, found from the layout rather than written down.
    const metrics = gridMetrics(PULSE_SLOT, NAMES.length);
    const seam = { x: metrics.originX + metrics.cellWidth, y: CENTRES[0]?.y ?? 0 };
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...seam }), false);
    assert.equal(panel.pageName, "desktop", "nothing was dispatched");
  });

  test("a tap before anything has been painted resolves against nothing", () => {
    // `build` is what records where the boxes went. A tap that arrives first has no geometry to be
    // answered against, and guessing one would be answering with a key nobody can see.
    const panel = new Panel(config, TOKENS);
    const first = CENTRES[0] ?? { x: 0, y: 0 };
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...first }), false);
  });

  test("a filtered page runs the key that is showing, not the key at that index", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "delta" });
    painted(panel);
    const first = CENTRES[0] ?? { x: 0, y: 0 };
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...first });
    // One cell survives the filter, and it is the fourth key. Resolving through `page.keys[0]`
    // would have run alpha — a key that is not on the screen at all.
    assert.equal(panel.pageName, "delta");
    assert.equal(panel.selected, 0);
  });

  test("a tap landing between a page change and its repaint does nothing", () => {
    const panel = painted(new Panel(config, TOKENS));
    panel.setPage("alpha");
    const first = CENTRES[0] ?? { x: 0, y: 0 };
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...first }), false);
  });

  describe("the press flash", () => {
    const at = (nowMs: number): PanelState => ({ ...state(), nowMs });

    test("marks the tapped cell as pressed right after the tap", () => {
      const panel = painted(new Panel(config, TOKENS));
      const third = CENTRES[2] ?? { x: 0, y: 0 };
      panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...third });
      panel.setPage("desktop");
      const grid = panel.build(pulseDevice(), at(1_000)).get(SCREEN_SLOT);
      assert.equal(grid?.kind === "grid" && grid.pressed, 2);
    });

    test("clears once PRESS_FLASH_MS has passed, leaving the selection behind", () => {
      const panel = painted(new Panel(config, TOKENS));
      const third = CENTRES[2] ?? { x: 0, y: 0 };
      panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...third });
      panel.setPage("desktop");
      panel.build(pulseDevice(), at(1_000)); // settles the flash window against this clock reading
      const grid = panel.build(pulseDevice(), at(1_000 + PRESS_FLASH_MS)).get(SCREEN_SLOT);
      assert.equal(grid?.kind === "grid" && grid.pressed, undefined, "the flash is gone");
      assert.equal(grid?.kind === "grid" && grid.selected, 2, "the selection is not");
    });

    test("never flashes when nothing supplies a clock", () => {
      // The same fallback `TAP_HOLD_MS` takes: no injected `nowMs` means no time-windowed effect,
      // rather than one that reads as permanently on.
      const panel = painted(new Panel(config, TOKENS));
      const third = CENTRES[2] ?? { x: 0, y: 0 };
      panel.handle({ kind: "tap", slot: SCREEN_SLOT, ...third });
      panel.setPage("desktop");
      const grid = panel.build(pulseDevice(), state()).get(SCREEN_SLOT);
      assert.equal(grid?.kind === "grid" && grid.pressed, undefined);
    });
  });
});

describe("a tap steers the rotation", () => {
  // Two pages: one that rotates through items and one that is a list of things to choose between.
  // A tap means something on the first and deliberately nothing on the second.
  const config = parseConfig({
    pages: [
      { name: "gallery" },
      // `noop` rather than a real verb: a tap on a keyed page now *dispatches*, and `hypr ...` goes
      // out through `state/hypr.ts` rather than through the exits `useFakeProcesses` replaces —
      // this test file would have started talking to the running compositor.
      { name: "desktop", keys: [{ index: 0, label: "One", action: "noop" }] },
    ],
  });

  // No `imageUrl`: `pulseDetail` asks `#pulseArt` for the art of whatever piece it settles on, and
  // a URL here would start a real fetch from a test. These assertions are about *which* piece the
  // page settles on, which the title carries.
  const PIECES = ["Alpha", "Beta", "Gamma", "Delta"].map((name) => ({
    name,
    collection: "onchainchain",
    imageUrl: "",
    openseaUrl: "",
  }));

  /** The clock, as the runner injects it: a window index, a position in it, and the raw reading. */
  const clock = (rotation: number, nowMs: number): PanelState => ({
    ...state(),
    portfolio: { ...PORTFOLIO, nfts: PIECES },
    rotation,
    rotationProgress: 0,
    nowMs,
  });

  /** The piece a panel is showing, read off the frame it would paint. */
  const showing = (panel: Panel, at: PanelState): string => {
    const surface = panel.build(screenDevice(), at).get(SCREEN_SLOT);
    assert.equal(surface?.kind, "detail");
    return surface?.kind === "detail" ? surface.title : "";
  };

  test("a tap advances to the next piece at once, and again on a second tap", () => {
    const panel = new Panel(config, TOKENS);
    assert.equal(showing(panel, clock(10, 0)), "Gamma", "10 % 4 pieces");
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 100, y: 200 }), true, "repaints");
    assert.equal(showing(panel, clock(10, 10)), "Delta", "the clock has not moved; the tap did");
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 100, y: 200 });
    assert.equal(showing(panel, clock(10, 20)), "Alpha", "a second tap advances from the held piece");
  });

  test("the hold keeps the summoned piece past the flip, then gives the page back", () => {
    // The whole point of the hold: a tap that lands just before the clock flips must not have its
    // answer taken away before anyone has read it.
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 1, y: 1 });
    assert.equal(showing(panel, clock(10, 0)), "Delta");
    assert.equal(showing(panel, clock(12, 9_000)), "Delta", "two windows on, still held");
    assert.equal(showing(panel, clock(12, 10_001)), "Alpha", "hold spent: the clock has the page");
  });

  test("two untouched panels agree, and a tapped one rejoins them", () => {
    // The multi-unit property: several pulse panels on a desk derive the item from a wall clock
    // they already share, so they agree with no link between them. A tap steers one unit and must
    // not cost the rest that agreement — nor cost the tapped unit its place once the hold is spent.
    const left = new Panel(config, TOKENS);
    const right = new Panel(config, TOKENS);
    for (const rotation of [7, 8, 9]) {
      const at = clock(rotation, rotation * 6_000);
      assert.equal(showing(left, at), showing(right, at), `untouched units agree at ${rotation}`);
    }

    left.handle({ kind: "tap", slot: SCREEN_SLOT, x: 1, y: 1 });
    const tapped = clock(9, 54_000);
    assert.notEqual(showing(left, tapped), showing(right, tapped), "the tapped unit steps ahead");

    const later = clock(12, 72_000);
    assert.equal(showing(left, later), showing(right, later), "and is back in step once it expires");
    assert.equal(showing(left, later), "Alpha", "in step with the clock, not merely with each other");
  });

  test("the sync bar counts down the hold while one is running", () => {
    // The bar's claim is "what you are looking at changes when this fills". During a hold that is
    // the hold's own deadline, not the next shared flip, or the bar would fill and nothing happen.
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 1, y: 1 });
    // The hold is stamped on the first frame after the tap, which is the frame the summoned piece
    // first appears on — the clock it is measured from is the one that paints it, not an earlier one.
    assert.equal(showing(panel, clock(10, 0)), "Delta");
    const held = panel.build(screenDevice(), clock(10, 5_000)).get(SCREEN_SLOT);
    assert.equal(held?.kind, "detail");
    assert.equal(held?.kind === "detail" ? held.syncProgress : undefined, 0.5);

    const expired = { ...clock(14, 20_000), rotationProgress: 0.25 };
    const free = panel.build(screenDevice(), expired).get(SCREEN_SLOT);
    assert.equal(free?.kind === "detail" ? free.syncProgress : undefined, 0.25, "back to the shared window");
  });

  test("a tap on a page of keys chooses a cell rather than steering the rotation", () => {
    // Two gestures share one input kind, and the page decides which it is. A tap on the desktop
    // page must not leave a rotation pin behind for the gallery page to inherit.
    const panel = new Panel(config, TOKENS);
    panel.setPage("desktop");
    panel.build(screenDevice(), clock(10, 0));
    const grid = panel.build(screenDevice(), clock(10, 0)).get(SCREEN_SLOT);
    assert.equal(grid?.kind, "grid", "a page of keys is a grid");
    assert.equal(panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 120, y: 67 }), true, "hit a cell");
    panel.setPage("gallery");
    assert.equal(showing(panel, clock(10, 0)), "Gamma", "the gallery is where the clock says");
  });

  test("a tap on the touch strip leaves the rotation alone", () => {
    // The Stream Deck's strip emits taps as well. Advancing the gallery keys from a brush against
    // the strip is a different feature, and not this one.
    const panel = new Panel(config, TOKENS);
    assert.equal(panel.handle({ kind: "tap", slot: STRIP_SLOT, x: 1, y: 1 }), false);
    assert.equal(showing(panel, clock(10, 0)), "Gamma", "unmoved");
  });

  test("changing page drops the hold rather than carrying it over", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "tap", slot: SCREEN_SLOT, x: 1, y: 1 });
    panel.setPage("desktop");
    panel.setPage("gallery");
    assert.equal(showing(panel, clock(10, 0)), "Gamma", "the page arrived at is the one the clock says");
  });
});

/**
 * Browsing what is trending, on a device that has both keys and a screen.
 *
 * Three claims, and they are separable. That a `layout: "screen"` page fills one half of the device
 * and blanks the other — the Cardputer is the first device with both, so "never both" is a rule that
 * had nothing to break before now. That the state machine on top of it opens, pages its facets and
 * closes on the inputs the contract already had, without a new `Surface` kind or a new `DeviceInput`
 * between them. And that a facet never shows rows fetched for a different item.
 */
describe("browsing trending tokens and collections", () => {
  const config = parseConfig({
    pages: [
      { name: "desktop", keys: [{ index: 0, label: "One", action: "exec notify-send one" }] },
      { name: "browse-tokens", layout: "screen" },
      { name: "browse-nfts", layout: "screen" },
    ],
  });

  /** The Cardputer's shape, in the abstract: nine tiles, a strip, and a screen over the tiles. */
  const cardputerish = (): AnchorDevice =>
    fakeDevice([
      ...Array.from(
        { length: 9 },
        (_v, i): SlotSpec => ({ id: keySlot(i), kind: "key", paintable: true, width: 80, height: 35 }),
      ),
      { id: STRIP_SLOT, kind: "strip", paintable: true, width: 240, height: 18 },
      { id: SCREEN_SLOT, kind: "screen", paintable: true, width: 240, height: 105 },
    ]);

  const TRENDING: PanelState["discoveryTokens"] = [
    {
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain: "ethereum",
      name: "Alpha",
      symbol: "ALP",
      imageUrl: "",
      usdPrice: 1.5,
      marketCapUsd: 1_000_000,
      volume24h: 4200,
      priceChange24h: 4.2,
      openseaUrl: "",
    },
    {
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chain: "solana",
      name: "Bravo",
      symbol: "BRV",
      imageUrl: "",
      usdPrice: 0.25,
      marketCapUsd: null,
      volume24h: null,
      priceChange24h: -1.5,
      openseaUrl: "",
    },
  ];

  const COLLECTIONS: PanelState["discoveryCollections"] = [
    { slug: "onchainchain", name: "Onchain Chain", imageUrl: "", openseaUrl: "" },
    { slug: "pudgies", name: "Pudgies", imageUrl: "", openseaUrl: "" },
  ];

  const BRAVO_DEPTH: PanelState["discoveryDetail"] = {
    id: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tokenHolders: {
      holders: [
        {
          ownerAddress: "0x1111111111111111111111111111111111111111",
          ownerDisplayName: "whale.eth",
          percentageHeld: 12.5,
          usdValue: 900,
        },
        {
          ownerAddress: "0x2222222222222222222222222222222222222222",
          ownerDisplayName: null,
          percentageHeld: 3,
          usdValue: 100,
        },
      ],
      totalCount: 1240,
      healthScore: 61,
      healthLabel: "Healthy",
    },
    tokenActivity: [
      {
        timestamp: 1_757_000_000,
        senderAddress: "0x3333333333333333333333333333333333333333",
        fromSymbolOrAddress: "WETH",
        toSymbolOrAddress: "BRV",
        amountUsd: 512,
      },
    ],
  };

  const browsing = (overrides: Partial<PanelState> = {}): PanelState => ({
    ...state(),
    discoveryTokens: TRENDING,
    discoveryCollections: COLLECTIONS,
    ...overrides,
  });

  /** A panel that has painted at least once, which is what records the rows an Enter resolves in. */
  const painted = (page: string, overrides: Partial<PanelState> = {}): Panel => {
    const panel = new Panel(config, TOKENS);
    panel.setPage(page);
    panel.build(cardputerish(), browsing(overrides));
    return panel;
  };

  const surfaceOn = (panel: Panel, overrides: Partial<PanelState> = {}) =>
    panel.build(cardputerish(), browsing(overrides)).get(SCREEN_SLOT);

  /** Tab, as the Cardputer sends it: the panel's existing paging gesture. */
  const TAB = { kind: "swipe", slot: STRIP_SLOT, from: 0, to: 1 } as const;
  const SHIFT_TAB = { kind: "swipe", slot: STRIP_SLOT, from: 0, to: -1 } as const;
  /** Esc: the one press that belongs to no key and no cell. */
  const ESC = { kind: "press", slot: STRIP_SLOT } as const;
  const ENTER = { kind: "press", slot: SCREEN_SLOT } as const;

  test("a screen page fills the screen and blanks the keys, never both", () => {
    const frame = new Panel(config, TOKENS).build(cardputerish(), browsing());
    // The key page first: the same device, the same build, and the screen is left alone.
    assert.equal(frame.get(SCREEN_SLOT), undefined, "a page of keys does not claim the screen");
    assert.equal(frame.get(keySlot(0))?.kind === "tile" && frame.get(keySlot(0))?.kind, "tile");

    const panel = painted("browse-tokens");
    const browse = panel.build(cardputerish(), browsing());
    assert.equal(browse.get(SCREEN_SLOT)?.kind, "list");
    const key = browse.get(keySlot(0));
    // Blanked rather than absent: the adapter diffs against what it last sent, so a tile left out
    // of this frame would still be believed to be on the glass under the surface covering it, and
    // the next key page would repaint nothing at all.
    assert.equal(key?.kind === "tile" && key.label, undefined, "the keys are blanked, not filled");
  });

  test("the list is the trending tokens, priced, and signed by their 24h move", () => {
    const list = surfaceOn(painted("browse-tokens"));
    assert.equal(list?.kind, "list");
    if (list?.kind !== "list") return;
    assert.deepEqual(
      list.rows.map((row) => row.label),
      ["ALP", "BRV"],
    );
    assert.deepEqual(
      list.rows.map((row) => row.value),
      ["$1.50", "$0.25"],
    );
    assert.deepEqual(
      list.rows.map((row) => row.tone),
      ["positive", "negative"],
    );
    assert.equal(list.selected, 0);
  });

  test("an empty list says it is still loading rather than showing nothing", () => {
    const panel = new Panel(config, TOKENS);
    panel.setPage("browse-tokens");
    const list = panel.build(cardputerish(), { ...state() }).get(SCREEN_SLOT);
    assert.equal(list?.kind === "list" && list.rows.length, 0);
    assert.equal(list?.kind === "list" && list.empty, "loading…");
  });

  test("up and down move the selection, by encoder or by keyboard", () => {
    const panel = painted("browse-tokens");
    // The Cardputer has no encoder: its arrows arrive as a swipe on the screen itself.
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: 1 });
    assert.equal(panel.selected, 1);
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: -1 });
    assert.equal(panel.selected, 0);
    // And a device that does have one still moves the same selection.
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: 1 });
    assert.equal(panel.selected, 1);
  });

  test("enter opens the selected row, not the one that was selected a frame ago", () => {
    const panel = painted("browse-tokens");
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: 1 });
    assert.equal(panel.handle(ENTER), true, "repaints");
    assert.deepEqual(panel.browseDetail, { kind: "token", id: TRENDING?.[1]?.address, facet: 0 });
    const detail = surfaceOn(panel);
    assert.equal(detail?.kind, "detail");
    assert.equal(detail?.kind === "detail" && detail.title, "Bravo (BRV)");
    assert.equal(detail?.kind === "detail" && detail.badge, "Overview");
    assert.deepEqual(detail?.kind === "detail" ? detail.lines.map((line) => line.label) : [], [
      "Price",
      "24h",
      "Volume",
      "Chain",
    ]);
  });

  test("the facets cycle Overview → Holders → Activity, and wrap both ways", () => {
    const panel = painted("browse-tokens");
    panel.handle(ENTER);
    assert.equal(surfaceOn(panel)?.kind, "detail", "Overview is a detail surface");

    panel.handle(TAB);
    assert.equal(panel.browseDetail?.facet, 1);
    assert.equal(surfaceOn(panel)?.kind, "list", "Holders is a list");

    panel.handle(TAB);
    assert.equal(panel.browseDetail?.facet, 2);
    assert.equal(surfaceOn(panel)?.kind, "list", "Activity is a list");

    panel.handle(TAB);
    assert.equal(panel.browseDetail?.facet, 0, "and round");
    assert.equal(panel.pageName, "browse-tokens", "a facet step is not a page step");

    panel.handle(SHIFT_TAB);
    assert.equal(panel.browseDetail?.facet, 2, "backwards wraps too");
  });

  test("paging still pages the panel once nothing is open", () => {
    // The whole `handle` change is additive: close the detail and Tab is the page gesture again.
    const panel = painted("browse-tokens");
    panel.handle(ENTER);
    panel.handle(ESC);
    panel.handle(TAB);
    assert.equal(panel.pageName, "browse-nfts");
  });

  test("escape closes the detail and the selection survives it", () => {
    const panel = painted("browse-tokens");
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: 1 });
    panel.handle(ENTER);
    panel.handle(TAB);
    assert.equal(panel.handle(ESC), true);
    assert.equal(panel.browseDetail, null);
    assert.equal(panel.selected, 1, "back at the row it was opened from");
    const list = surfaceOn(panel);
    assert.equal(list?.kind === "list" && list.selected, 1, "and the frame says so");
  });

  test("enter again backs out, because the device has one confirm key", () => {
    const panel = painted("browse-tokens");
    panel.handle(ENTER);
    assert.notEqual(panel.browseDetail, null);
    panel.handle(ENTER);
    assert.equal(panel.browseDetail, null);
  });

  test("the holders facet shows the depth fetched for that token", () => {
    const panel = painted("browse-tokens");
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: 1 });
    panel.handle(ENTER);
    panel.handle(TAB);
    const holders = surfaceOn(panel, { discoveryDetail: BRAVO_DEPTH });
    assert.equal(holders?.kind, "list");
    if (holders?.kind !== "list") return;
    assert.deepEqual(
      holders.rows.map((row) => row.label),
      ["Holders · BRV", "Distribution", "1. whale.eth", "2. 0x2222…2222"],
    );
    assert.equal(holders.rows[0]?.value, "1,240", "the header carries how many there are in total");
    assert.equal(holders.rows[2]?.value, "12.50%");
  });

  test("a facet never shows rows fetched for a different item", () => {
    // The failure AGENTS.md puts above every other one here: a plausible answer to a question
    // nobody asked. Between opening a second token and its fetch landing, the depth in hand is
    // still the first token's, and showing it under this name would be indistinguishable from data
    // that is simply wrong.
    const panel = painted("browse-tokens");
    panel.handle(ENTER); // Alpha, not Bravo
    panel.handle(TAB);
    const holders = surfaceOn(panel, { discoveryDetail: BRAVO_DEPTH });
    assert.equal(holders?.kind, "list");
    if (holders?.kind !== "list") return;
    assert.deepEqual(
      holders.rows.map((row) => row.label),
      ["Holders · ALP", "loading…"],
    );
  });

  test("the activity facet is the buy/sell feed, in the API's own words", () => {
    const panel = painted("browse-tokens");
    panel.handle({ kind: "swipe", slot: SCREEN_SLOT, from: 0, to: 1 });
    panel.handle(ENTER);
    panel.handle(TAB);
    panel.handle(TAB);
    const activity = surfaceOn(panel, { discoveryDetail: BRAVO_DEPTH });
    assert.equal(activity?.kind, "list");
    if (activity?.kind !== "list") return;
    assert.deepEqual(
      activity.rows.map((row) => row.label),
      ["Activity · BRV", "WETH → BRV"],
    );
    assert.equal(activity.rows[1]?.value, "$512.00");
  });

  test("the NFT side browses collections through the same machine", () => {
    const panel = painted("browse-nfts");
    const list = surfaceOn(panel);
    assert.deepEqual(list?.kind === "list" ? list.rows.map((row) => row.label) : [], [
      "Onchain Chain",
      "Pudgies",
    ]);
    panel.handle(ENTER);
    assert.deepEqual(panel.browseDetail, { kind: "nft", id: "onchainchain", facet: 0 });
    assert.equal(surfaceOn(panel)?.kind === "detail" && surfaceOn(panel)?.kind, "detail");
    panel.handle(TAB);
    const holders = surfaceOn(panel, {
      discoveryDetail: {
        id: "onchainchain",
        collectionHolders: [
          { address: "0x4444444444444444444444444444444444444444", quantity: 7, percentage: 0.5 },
        ],
      },
    });
    assert.deepEqual(holders?.kind === "list" ? holders.rows.map((row) => row.label) : [], [
      "Holders · Onchain Chain",
      "1. 0x4444…4444",
    ]);
  });

  test("leaving the page drops what was open rather than carrying it over", () => {
    const panel = painted("browse-tokens");
    panel.handle(ENTER);
    panel.setPage("desktop");
    assert.equal(panel.browseDetail, null);
    // And an Enter arriving after the page change, before its repaint, runs nothing. Desktop's key 0
    // is at the selected index, but it is not on the glass yet, so nobody chose it.
    spawned.length = 0;
    panel.handle(ENTER);
    assert.deepEqual(spawned, []);
    assert.equal(panel.pageName, "desktop");
    assert.equal(panel.browseDetail, null);
  });

  test("a filter narrows the list, and a row opens the token that is showing", () => {
    const panel = painted("browse-tokens");
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "brv" });
    panel.build(cardputerish(), browsing());
    const list = surfaceOn(panel);
    assert.deepEqual(list?.kind === "list" ? list.rows.map((row) => row.label) : [], ["BRV"]);
    panel.handle(ENTER);
    // Resolving through the unfiltered list would have opened Alpha — a token not on the screen.
    assert.equal(panel.browseDetail?.id, TRENDING?.[1]?.address);
  });
});

describe("text input", () => {
  const config = parseConfig({
    pages: [
      {
        name: "p",
        keys: [
          { index: 0, label: "Ethereum", action: "exec true" },
          { index: 1, label: "Solana", action: "exec true" },
          { index: 2, label: "Base", action: "exec true" },
        ],
      },
      { name: "other", keys: [] },
    ],
  });

  test("narrows the cells and nothing else", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "sol" });
    const grid = panel.build(screenDevice(), state()).get(SCREEN_SLOT);
    assert.deepEqual(grid?.kind === "grid" ? grid.cells.map((c) => c.label) : [], ["Solana"]);
  });

  test("an empty grid says why it is empty", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "zzz" });
    const grid = panel.build(screenDevice(), state()).get(SCREEN_SLOT);
    assert.equal(grid?.kind === "grid" && grid.cells.length, 0);
    assert.match(grid?.kind === "grid" ? (grid.empty ?? "") : "", /zzz/);
  });

  test("filter text is never dispatched as an action", () => {
    // The whole safety argument for having a keyboard at all: this is a filter, not a command.
    // `other` exists, so dispatching the text as `page other` would switch to it.
    const panel = new Panel(config, TOKENS);
    const before = panel.pageName;
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "page other" });
    assert.equal(panel.pageName, before, "text must not switch pages");
    const grid = panel.build(screenDevice(), state()).get(SCREEN_SLOT);
    assert.match(grid?.kind === "grid" ? (grid.empty ?? "") : "", /page other/, "it is kept as a filter");
  });

  test("a filter stays on the page it was typed on", () => {
    // The Cardputer hides its filter box once the text is committed, so a filter carried to the next
    // page narrows that grid with nothing on the glass saying why.
    const twoPages = parseConfig({
      pages: [
        { name: "p", keys: [{ index: 0, label: "Solana", action: "exec true" }] },
        {
          name: "q",
          keys: [
            { index: 0, label: "Ethereum", action: "exec true" },
            { index: 1, label: "Base", action: "exec true" },
          ],
        },
      ],
    });
    const panel = new Panel(twoPages, TOKENS);
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "sol" });
    assert.equal(panel.setPage("q"), true);
    const grid = panel.build(screenDevice(), state()).get(SCREEN_SLOT);
    assert.deepEqual(grid?.kind === "grid" ? grid.cells.map((c) => c.label) : [], ["Ethereum", "Base"]);
  });

  test("committing text resets the selection to the top of the new grid", () => {
    const panel = new Panel(config, TOKENS);
    panel.handle({ kind: "rotate", slot: SCREEN_SLOT, delta: 1 });
    panel.handle({ kind: "text", slot: SCREEN_SLOT, value: "a" });
    assert.equal(panel.selected, 0);
  });
});

describe("keys that show something can open it", () => {
  const config = parseConfig({
    pages: [
      {
        name: "portfolio",
        keys: [
          { index: 0, source: "nft:1" },
          { index: 1, source: "token:1" },
        ],
      },
    ],
  });

  const withLinks = {
    ...withPortfolio,
    portfolio: {
      ...PORTFOLIO,
      nfts: [
        {
          name: "Piece",
          collection: "c",
          imageUrl: "https://x/a.png",
          openseaUrl: "https://opensea.io/item/1",
        },
      ],
      tokens: [
        {
          symbol: "ETH",
          usdValue: 1,
          status: "OK",
          chain: "ethereum",
          openseaUrl: "https://opensea.io/token/eth",
        },
      ],
    },
  };

  test("a rotating piece carries the action for the piece actually on the key", () => {
    // The action cannot live in config: what the key shows changes every few seconds, and opening
    // the wrong piece would be worse than opening nothing.
    const reading = readKeySource("nft:1", withLinks);
    assert.match(reading?.action ?? "", /opensea\.io\/item\/1/);
    // The piece's own name, never blanked once its art arrives.
    assert.equal(reading?.label, "Piece");
  });

  test("a holding opens the token it is showing", () => {
    assert.match(readKeySource("token:1", withLinks)?.action ?? "", /opensea\.io\/token\/eth/);
  });

  test("a piece with no link offers no action rather than a broken one", () => {
    const noLink = {
      ...withPortfolio,
      portfolio: {
        ...PORTFOLIO,
        nfts: [{ name: "P", collection: "c", imageUrl: "https://x/a.png", openseaUrl: "" }],
      },
    };
    assert.equal(readKeySource("nft:1", noLink)?.action, undefined);
  });

  test("pressing the key dispatches what it was showing when it was painted", () => {
    const panel = new Panel(config, TOKENS);
    panel.build(streamDeckPlus(), withLinks);
    // A press arrives with no state, so the panel has to have remembered.
    spawned.length = 0;
    panel.handle({ kind: "press", slot: keySlot(0) });
    assert.deepEqual(spawned, [["omarchy", "launch", "browser", "https://opensea.io/item/1"]]);
  });

  test("no shipped key is dead except the ones listed as dead on purpose", () => {
    // "All buttons should have a click that does something useful": a key with neither a configured
    // action nor a source that supplies one is a dead key. A few shipped keys are dead today, and
    // they are named here so that a new one fails this test instead of passing among them.
    //
    // The six chain shares are readings only. `chain:N` supplies no action, and giving a chain
    // share something to open is a product decision that has not been made, so they stay dead.
    const neverAct = ["chains/0", "chains/1", "chains/2", "chains/3", "chains/4", "chains/5"];
    // The two sparklines open the wallet's OpenSea profile, so without a configured wallet they
    // have nothing to open. That is the product as designed, not a gap.
    const needAWallet = ["portfolio/0", "portfolio/1"];

    // Everything a key could want: a wallet, two linked holdings, a linked piece.
    const loaded = {
      ...withLinks,
      service: { ...withLinks.service, wallet: "0x00a839de7922491683f547a67795204763ff8237" },
      portfolio: {
        ...withLinks.portfolio,
        tokens: [
          ...withLinks.portfolio.tokens,
          {
            symbol: "USDC",
            usdValue: 1,
            status: "OK",
            chain: "base",
            openseaUrl: "https://opensea.io/token/usdc",
          },
        ],
      },
    };
    const noWallet = { ...loaded, service: withLinks.service };

    const { config: shipped } = loadConfig(new URL("../config/panel.json", import.meta.url).pathname);
    const dead = (state: typeof noWallet): string[] =>
      shipped.pages
        .flatMap((page) =>
          page.keys
            .filter(
              (key) =>
                key.action === "" &&
                (key.source === "" || readKeySource(key.source, state)?.action === undefined),
            )
            .map((key) => `${page.name}/${key.index}`),
        )
        .sort();

    assert.deepEqual(dead(loaded), [...neverAct].sort(), "dead even with everything loaded");
    assert.deepEqual(dead(noWallet), [...neverAct, ...needAWallet].sort(), "dead without a wallet");
  });
});
