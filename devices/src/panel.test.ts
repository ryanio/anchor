/**
 * The panel against a device that does not exist.
 *
 * This is the test the device contract is *for*. If panel logic can be driven by a fake with
 * different slots from a Stream Deck, then the ESP32 and Cardputer adapters are a rendering problem
 * rather than a rewrite. A fake with only two keys and no strip stands in for the small device.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseConfig } from "./config.ts";
import type { PanelState } from "./panel.ts";
import { dialSlot, keySlot, Panel, readKeySource, SEGMENT_SOURCES, STRIP_SLOT, usd } from "./panel.ts";
import { EMPTY_SNAPSHOT } from "./state/desktop.ts";
import { toTokens } from "./tokens.ts";
import type { AnchorDevice, DeviceCapabilities, Frame, SlotSpec } from "./types.ts";

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

const streamDeckPlus = (): AnchorDevice =>
  fakeDevice([
    ...Array.from(
      { length: 8 },
      (_v, i): SlotSpec => ({
        id: keySlot(i),
        kind: "key",
        paintable: true,
        width: 120,
        height: 120,
      }),
    ),
    ...Array.from(
      { length: 4 },
      (_v, i): SlotSpec => ({
        id: dialSlot(i),
        kind: "encoder",
        paintable: false,
        width: 0,
        height: 0,
      }),
    ),
    { id: STRIP_SLOT, kind: "strip", paintable: true, width: 800, height: 100 },
  ]);

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
    const frame = panel.build(streamDeckPlus(), state());
    assert.equal(frame.size, 9, "8 keys and the strip");
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

  test("never paints a slot the device cannot paint", () => {
    const panel = new Panel(CONFIG, TOKENS);
    const frame = panel.build(streamDeckPlus(), state());
    // The Plus's encoders take input but have no display; a frame for one would be rasterised and
    // thrown away.
    assert.equal(frame.has(dialSlot(0)), false);
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
    { symbol: "ETH", usdValue: 18400.22, status: "OK" },
    { symbol: "USDC", usdValue: 6210.4, status: "OK" },
  ],
  nftCount: 42,
  topCollections: [{ slug: "azuki", count: 12 }],
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
