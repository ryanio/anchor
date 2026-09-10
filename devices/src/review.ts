/**
 * Every device, in every state worth looking at, rendered without hardware.
 *
 * ## Why this is here and not in `scripts/`
 *
 * `scripts/review.ts` already knows how to *review*: it pairs a surface with a PNG, builds the
 * walkthrough page, keeps the notes and says which shots are stale. None of that is device
 * knowledge, and none of it is duplicated here. What lives here is the half `scripts/` cannot know
 * — which devices exist, which states the panel can be in, and how to paint one — and it lives in
 * this workspace because that is where `Panel`, the adapters and the fixtures already are, and
 * because `npm test` here can hold it honest.
 *
 * So the split is: this file produces PNGs and a list of cases; `scripts/review.ts` turns any list
 * of cases into a page a person marks up. Adding a device or a state touches this file only.
 *
 * ## What "a state" means
 *
 * A live machine is in exactly one of these at a time, and the interesting ones are the states
 * nobody can arrange on purpose: the service refusing, a wallet that is not configured yet, a
 * reading that has not arrived, a figure the service served stale after a failure. Those are read
 * out of `state/anchor.ts` and `panel.ts` rather than invented — every `detail` string below is one
 * the real client produces, and every em dash is one `KEY_SOURCES` actually emits.
 *
 * The numbers are fixtures and are nobody's portfolio. AGENTS.md has already had one developer's
 * figures taken back out of this repository; a review tool is exactly the sort of thing that would
 * put them back in.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARDPUTER_FLINT,
  capabilitiesFor as cardputerCapabilities,
  slotRects,
} from "./adapters/cardputer.ts";
import { capabilitiesFor as esp32Capabilities } from "./adapters/esp32.ts";
import { PixelFormat } from "./adapters/esp32-wire.ts";
import { capabilitiesFor as deckCapabilities, GEOMETRIES } from "./adapters/virtual.ts";
import { loadConfig, type PanelConfig } from "./config.ts";
import { loadGlyphMetrics } from "./glyphs.ts";
import { prefetch, seedThumbnail } from "./images.ts";
import { keySlot, Panel, type PanelState, SCREEN_SLOT } from "./panel.ts";
import { composeSvg, type PreviewRect, writePreview } from "./preview.ts";
import type { OwnedNft, PortfolioSnapshot, Timeframe } from "./state/anchor.ts";
import { EMPTY_PORTFOLIO, type ServiceStatus } from "./state/anchor.ts";
import { type DesktopSnapshot, EMPTY_SNAPSHOT } from "./state/desktop.ts";
import { themeOnDisk } from "./themes.ts";
import { deviceTokens, type Tokens } from "./tokens.ts";
import type { AnchorDevice, DeviceCapabilities, DeviceInput, Frame, Surface } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Devices
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceProfile {
  readonly id: string;
  readonly title: string;
  /** One line about the hardware, shown on the card so a reviewer knows what they are judging. */
  readonly note: string;
  readonly capabilities: DeviceCapabilities;
  /** Keys per row, for a device whose keys are physically separate screens. */
  readonly columns: number;
  /**
   * Slot geometry for a device that is one framebuffer.
   *
   * Taken from the adapter that drives it, never re-derived: the Cardputer draws its status bar at
   * the *top* and butts its tiles against each other, and a preview that laid it out on the generic
   * grid would put the bar at the bottom with 12px of imaginary plastic between the keys.
   */
  readonly rects?: ReadonlyMap<string, PreviewRect>;
}

/** Only reachable if `virtual.ts` loses a model; keeps `DEVICES` total without an assertion. */
const FALLBACK_GEOMETRY = {
  keys: 8,
  keyWidth: 120,
  keyHeight: 120,
  columns: 4,
  encoders: 0,
  strip: null,
} as const;

/**
 * The devices Anchor can paint, as one list.
 *
 * Capabilities come from each adapter's own `capabilitiesFor`, so a device cannot appear here with
 * a geometry the adapter would not actually produce. The ESP32 entries pass the panel dimensions
 * the board reports in HELLO; `PANELS` in `esp32.ts` is documentation of the boards that exist and
 * these are two of them.
 */
export const DEVICES: readonly DeviceProfile[] = [
  {
    id: "deck-plus",
    title: "Stream Deck +",
    note: "8 keys at 120×120, an 800×100 touch strip, 4 encoders with no display of their own.",
    capabilities: deckCapabilities(GEOMETRIES.plus ?? GEOMETRIES.original ?? { ...FALLBACK_GEOMETRY }),
    columns: GEOMETRIES.plus?.columns ?? 4,
  },
  {
    id: "deck-xl",
    title: "Stream Deck XL",
    note: "32 keys at 96×96 and no strip. The page has eight keys, so most of it stays dark.",
    capabilities: deckCapabilities(GEOMETRIES.xl ?? { ...FALLBACK_GEOMETRY }),
    columns: GEOMETRIES.xl?.columns ?? 8,
  },
  {
    id: "deck-mini",
    title: "Stream Deck Mini",
    note: "6 keys at 80×80. Two of the page's eight keys have nowhere to go.",
    capabilities: deckCapabilities(GEOMETRIES.mini ?? { ...FALLBACK_GEOMETRY }),
    columns: GEOMETRIES.mini?.columns ?? 3,
  },
  {
    id: "pulse-amoled",
    title: "ESP32 pulse — 1.8in AMOLED",
    note: "One 368×448 screen, no keys. The page becomes a list; the same config, a different shape.",
    capabilities: esp32Capabilities({
      version: 1,
      width: 368,
      height: 448,
      format: PixelFormat.Rgb565Le,
      maxTileBytes: 32768,
      inputs: ["tap"],
      deviceId: "review",
    }),
    columns: 1,
    rects: new Map([[SCREEN_SLOT, { x: 0, y: 0, w: 368, h: 448 }]]),
  },
  {
    id: "pulse-round",
    title: "ESP32 pulse — 1.28in round",
    note: "240×240, and round in real life. Anything in a corner of this picture is off the glass.",
    capabilities: esp32Capabilities({
      version: 1,
      width: 240,
      height: 240,
      format: PixelFormat.Rgb565Le,
      maxTileBytes: 32768,
      inputs: [],
      deviceId: "review",
    }),
    columns: 1,
    rects: new Map([[SCREEN_SLOT, { x: 0, y: 0, w: 240, h: 240 }]]),
  },
  {
    id: "cardputer",
    title: "M5Stack Cardputer",
    note: "240×123 of screen above flint's own status bar: an 18px strip and nine 80×35 tiles, butted.",
    capabilities: cardputerCapabilities(CARDPUTER_FLINT),
    columns: CARDPUTER_FLINT.columns,
    rects: slotRects(CARDPUTER_FLINT),
  },
];

export function deviceById(id: string): DeviceProfile | null {
  return DEVICES.find((device) => device.id === id) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Nothing has answered yet: no compositor, no `omarchy system stats`, no backlight. */
const DESKTOP_COLD: DesktopSnapshot = EMPTY_SNAPSHOT;

const DESKTOP_LIVE: DesktopSnapshot = {
  workspace: 3,
  occupied: new Set([1, 2, 3]),
  windowTitle: "nvim — devices/src/panel.ts",
  volume: 0.62,
  muted: false,
  nightlight: false,
  stayingAwake: false,
  brightness: 55,
  cpu: "9%",
  memory: "7.5GB / 31GB",
  theme: "Tokyo Night",
};

/** Two toggles on at once, so the active-key fill is judged next to an inactive one. */
const DESKTOP_TOGGLED: DesktopSnapshot = {
  ...DESKTOP_LIVE,
  workspace: 2,
  muted: true,
  volume: 0,
  nightlight: true,
  stayingAwake: true,
};

/**
 * A window title long enough to have to be cut, which is the ordinary case rather than a stunt.
 * Anything sourced from a marketplace is untrusted text (AGENTS.md) and gets the same treatment.
 */
const DESKTOP_LONG: DesktopSnapshot = {
  ...DESKTOP_LIVE,
  windowTitle: "Pudgy Penguins #4821 — Collection Offers, Traits and Activity | OpenSea — Mozilla Firefox",
  cpu: "100%",
  memory: "30.8GB / 31GB",
  theme: "Catppuccin Latte",
};

const SERVICE_DOWN: ServiceStatus = {
  reachable: false,
  detail: "not running",
  hasWallet: false,
  primaryChain: "",
};

const SERVICE_REFUSING: ServiceStatus = {
  reachable: false,
  detail: "health 503",
  hasWallet: false,
  primaryChain: "",
};

const SERVICE_NO_WALLET: ServiceStatus = {
  reachable: true,
  detail: "no wallet",
  hasWallet: false,
  primaryChain: "",
};

const SERVICE_READY: ServiceStatus = {
  reachable: true,
  wallet: "0x00000000000000000000000000000000000a11ce",
  detail: "",
  hasWallet: true,
  primaryChain: "ethereum",
};

/** Invented, shaped like a real day: a drift up with a dip in it, so the sparkline has something to say. */
const HISTORY: readonly number[] = Array.from(
  { length: 48 },
  (_, i) => 44_800 + Math.round(Math.sin(i / 4.5) * 1700 + Math.sin(i / 17) * 900 + i * 62),
);

const GALLERY: readonly OwnedNft[] = [
  { name: "Opepen 018", collection: "opepen-edition", imageUrl: "fixture://1", openseaUrl: "" },
  { name: "Checks 4419", collection: "checks-vv", imageUrl: "fixture://2", openseaUrl: "" },
  { name: "Terraforms 8812", collection: "terraforms", imageUrl: "fixture://3", openseaUrl: "" },
  { name: "Pudgy Penguin 4821", collection: "pudgy-penguins", imageUrl: "fixture://4", openseaUrl: "" },
  { name: "Autoglyph 271", collection: "autoglyphs", imageUrl: "fixture://5", openseaUrl: "" },
  { name: "Fidenza 313", collection: "fidenza", imageUrl: "fixture://6", openseaUrl: "" },
  { name: "Ringers 92", collection: "ringers", imageUrl: "fixture://7", openseaUrl: "" },
  { name: "Meridian 44", collection: "meridian", imageUrl: "fixture://8", openseaUrl: "" },
];

const PORTFOLIO_FULL: PortfolioSnapshot = {
  stats: {
    totalUsd: "48213.55",
    nftUsd: "31980.00",
    tokenUsd: "16233.55",
    pnlAbsolute: "1284.40",
    pnlPercentage: "2.74",
    timeframe: "DAY",
  },
  // ETH twice on purpose: `KEY_SOURCES.token` only appends the chain when a symbol is ambiguous,
  // and a rule that only fires sometimes is a rule nobody has seen fire.
  tokens: [
    { symbol: "ETH", usdValue: 9120.4, status: "OK", openseaUrl: "", chain: "ethereum" },
    { symbol: "USDC", usdValue: 4310, status: "OK", openseaUrl: "", chain: "base" },
    { symbol: "ETH", usdValue: 1802.1, status: "OK", openseaUrl: "", chain: "base" },
    { symbol: "DEGEN", usdValue: 1001.05, status: "OK", openseaUrl: "", chain: "base" },
  ],
  nftCount: 37,
  topCollections: [
    { slug: "pudgy-penguins", count: 12 },
    { slug: "opepen-edition", count: 9 },
    { slug: "checks-vv", count: 7 },
  ],
  history: HISTORY,
  chains: [
    { chain: "ethereum", usdValue: 9120.4 },
    { chain: "base", usdValue: 7113.15 },
    { chain: "arbitrum", usdValue: 2841.2 },
    { chain: "optimism", usdValue: 941.7 },
    { chain: "zora", usdValue: 216.8 },
    { chain: "polygon", usdValue: 40.3 },
  ],
  nfts: GALLERY,
  ageSeconds: 12,
  stale: false,
  detail: "",
};

/** Served from cache after the upstream failed. The figure is real; it is just not current. */
const PORTFOLIO_STALE: PortfolioSnapshot = { ...PORTFOLIO_FULL, ageSeconds: 2760, stale: true };

/**
 * Everything else arrived and the headline did not.
 *
 * `readStats` returns null when `totalValueUsd` is absent, and the panel then shows an em dash on
 * every money key while the strip still says the service is ready. That combination is the one most
 * likely to be read as "you have nothing", so it is the one most worth looking at.
 */
const PORTFOLIO_NO_STATS: PortfolioSnapshot = { ...PORTFOLIO_FULL, stats: null };

const PORTFOLIO_NO_GALLERY: PortfolioSnapshot = {
  ...PORTFOLIO_FULL,
  nfts: [],
  nftCount: null,
  topCollections: [],
};

const PORTFOLIO_DOWN: PortfolioSnapshot = {
  ...PORTFOLIO_FULL,
  stats: {
    totalUsd: "1204880.55",
    nftUsd: "812430.00",
    tokenUsd: "392450.55",
    pnlAbsolute: "-38104.90",
    pnlPercentage: "-3.06",
    timeframe: "MONTH",
  },
  history: HISTORY.map((value) => 2 * (HISTORY[0] ?? 0) - value),
};

/** Long everywhere a label can be long: a ticker, a chain, a collection slug. */
const PORTFOLIO_LONG: PortfolioSnapshot = {
  ...PORTFOLIO_FULL,
  tokens: [
    { symbol: "WSTETH", usdValue: 21_940.44, status: "OK", openseaUrl: "", chain: "arbitrum-nova" },
    { symbol: "WSTETH", usdValue: 3402.1, status: "OK", openseaUrl: "", chain: "ethereum" },
    { symbol: "GRIMACECOIN", usdValue: 812.4, status: "OK", openseaUrl: "", chain: "base" },
  ],
  topCollections: [
    { slug: "pudgy-penguins-official-collection", count: 128 },
    { slug: "checks-vv-originals-editions", count: 41 },
    { slug: "a", count: 1 },
  ],
  chains: [
    { chain: "arbitrum-nova", usdValue: 21_940.44 },
    { chain: "ethereum", usdValue: 3402.1 },
  ],
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// States
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface StateFixture {
  readonly id: string;
  readonly desktop: DesktopSnapshot;
  readonly service: ServiceStatus;
  readonly portfolio: PortfolioSnapshot;
  readonly timeframe: Timeframe;
}

/**
 * The states a panel is actually ever in.
 *
 * Each pairs a `ServiceStatus` with the `PortfolioSnapshot` that status really produces —
 * `portfolio()` returns `service not running` when the socket refuses and `no wallet configured` on
 * a 428, so a fixture that put a full portfolio behind an unreachable service would be reviewing
 * something that cannot happen.
 */
export const STATES: readonly StateFixture[] = [
  {
    id: "cold",
    desktop: DESKTOP_COLD,
    service: SERVICE_DOWN,
    portfolio: EMPTY_PORTFOLIO,
    timeframe: "DAY",
  },
  {
    id: "service-down",
    desktop: DESKTOP_LIVE,
    service: SERVICE_DOWN,
    portfolio: { ...EMPTY_PORTFOLIO, detail: "service not running" },
    timeframe: "DAY",
  },
  {
    id: "service-refusing",
    desktop: DESKTOP_LIVE,
    service: SERVICE_REFUSING,
    portfolio: { ...EMPTY_PORTFOLIO, detail: "portfolio 502" },
    timeframe: "DAY",
  },
  {
    id: "no-wallet",
    desktop: DESKTOP_LIVE,
    service: SERVICE_NO_WALLET,
    portfolio: { ...EMPTY_PORTFOLIO, detail: "no wallet configured" },
    timeframe: "DAY",
  },
  {
    id: "loading",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: EMPTY_PORTFOLIO,
    timeframe: "DAY",
  },
  {
    id: "ready",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_FULL,
    timeframe: "DAY",
  },
  {
    id: "toggled",
    desktop: DESKTOP_TOGGLED,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_FULL,
    timeframe: "DAY",
  },
  {
    id: "stale",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_STALE,
    timeframe: "WEEK",
  },
  {
    id: "no-stats",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_NO_STATS,
    timeframe: "DAY",
  },
  {
    id: "no-gallery",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_NO_GALLERY,
    timeframe: "DAY",
  },
  {
    id: "down-day",
    desktop: DESKTOP_LIVE,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_DOWN,
    timeframe: "MONTH",
  },
  {
    id: "long",
    desktop: DESKTOP_LONG,
    service: SERVICE_READY,
    portfolio: PORTFOLIO_LONG,
    timeframe: "HOUR",
  },
];

export function stateById(id: string): StateFixture | null {
  return STATES.find((state) => state.id === id) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The matrix
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** The theme every card wears unless it is about a theme. Stock, so it resolves on any Omarchy. */
export const DEFAULT_THEME = "tokyo-night";

export interface CaseSpec {
  readonly id: string;
  readonly title: string;
  readonly looking: string;
  readonly category: string;
  readonly device: string;
  readonly state: string;
  /** A page name from the config, or null when `frame` supplies the surfaces instead. */
  readonly page?: string;
  readonly theme?: string;
  /** Which piece a rotating gallery is showing. Fixed per case so a re-render is identical. */
  readonly rotation?: number;
  /** Redraw one key as held down. Never through `Panel.handle` — see `buildFrame`. */
  readonly pressedKey?: number;
  /** The device is blanked: the lock fired and it must be showing nothing at all. */
  readonly blank?: boolean;
  /** Surfaces to paint directly, for a contract surface the panel has no producer for yet. */
  readonly frame?: (device: DeviceProfile) => Frame;
}

/**
 * The review, in the order a person meets it.
 *
 * Curated rather than a cross product. Six devices times twelve states times four pages is 288
 * cards, which is a list nobody reads — the same failure `review-page.ts` was rebuilt to avoid.
 * Each card below is here because it shows something no other card shows.
 */
export const CASES: readonly CaseSpec[] = [
  // ── every device ──────────────────────────────────────────────────────────────────────────────
  {
    id: "deck-plus",
    category: "Every device",
    device: "deck-plus",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "Stream Deck + — the portfolio page",
    looking:
      "The reference frame. Eight keys, a strip and a sparkline behind it. Check the gaps are even, " +
      "that every key's content sits on the same baseline as its neighbours, and that the strip's " +
      "segments do not crowd each other at the right-hand end.",
  },
  {
    id: "deck-xl",
    category: "Every device",
    device: "deck-xl",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "Stream Deck XL — eight keys on a deck of thirty-two",
    looking:
      "The page fills one corner and the other twenty-four keys are blank. Does the blank area read " +
      "as 'nothing configured' or as 'broken'? A deck this size is mostly empty and that has to look " +
      "deliberate.",
  },
  {
    id: "deck-mini",
    category: "Every device",
    device: "deck-mini",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "Stream Deck Mini — six keys for a page of eight",
    looking:
      "Two keys of the page have nowhere to go and are silently dropped. At 80×80 the readings are " +
      "at their smallest: check `$48,214` is still legible and that the labels have not collapsed " +
      "into their captions.",
  },
  {
    id: "pulse-amoled",
    category: "Every device",
    device: "pulse-amoled",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "ESP32 pulse, 368×448 — the portfolio ambient view",
    looking:
      "A big screen with no keys is a display, not a smaller Stream Deck: the portfolio page becomes " +
      "`pulseDetail`'s stats over a rotating piece of art rather than a list of rows. Check the scrim " +
      "leaves every line legible over the art behind it, and that the footer's age reading survives " +
      "at the panel's own font size.",
  },
  {
    id: "pulse-gallery",
    category: "Every device",
    device: "pulse-amoled",
    state: "ready",
    page: "gallery",
    rotation: 0,
    title: "ESP32 pulse — the gallery page as an ambient art frame",
    looking:
      "The one piece in rotation, full-bleed, with its own name as the title rather than a row of " +
      "thumbnails. Check the title never falls back to \"Untitled\" for a piece that has a name, and " +
      "that the scrim still leaves the title readable over a mostly-light piece of art.",
  },
  {
    id: "pulse-round",
    category: "Every device",
    device: "pulse-round",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "ESP32 pulse, 240×240 round — the corners are not there",
    looking:
      "This panel is round in real life, so anything within about 35px of a corner of this square is " +
      "off the glass. `pulseDetail`'s title, lines and footer are all laid out from `pad`, the same " +
      "fraction of the panel every other surface uses — check none of them reach into a corner.",
  },
  {
    id: "cardputer",
    category: "Every device",
    device: "cardputer",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    title: "Cardputer — nine 80×35 tiles under an 18px bar",
    looking:
      "The smallest surface Anchor paints, and the only one where tiles butt against each other with " +
      "no gap. Check the status strip at the top does not collide with the first row of tiles, and " +
      "that a reading at this size is a number rather than a smudge.",
  },

  // ── a day on the deck ─────────────────────────────────────────────────────────────────────────
  {
    id: "page-desktop",
    category: "A day on the deck",
    device: "deck-plus",
    state: "ready",
    page: "desktop",
    title: "Desktop — the page it sits on most of the time",
    looking:
      "Four workspaces and four actions. The current workspace is the one filled key: does it read " +
      "as 'on' from across a desk, and do the other seven read as pressable rather than disabled?",
  },
  {
    id: "page-desktop-toggled",
    category: "A day on the deck",
    device: "deck-plus",
    state: "toggled",
    page: "desktop",
    title: "Desktop — night light on, output muted",
    looking:
      "Two keys active at once, in different tones. Compare their fills against each other and " +
      "against the inactive keys, and check the icons and labels on a filled key are still legible.",
  },
  {
    id: "page-chains",
    category: "A day on the deck",
    device: "deck-plus",
    state: "ready",
    page: "chains",
    title: "Chains — six readings and two links out",
    looking:
      "Six money keys in a row is where inconsistent number widths show up. Are the values optically " +
      "the same size, or has `autoSize` shrunk one of them out of step with its neighbours?",
  },
  {
    id: "page-gallery",
    category: "A day on the deck",
    device: "deck-plus",
    state: "ready",
    page: "gallery",
    rotation: 0,
    title: "Gallery — six owned pieces, art loaded",
    looking:
      "The one tile layout that is entirely different: art clipped to the key's radius, no caption, " +
      "a scrim only where there is one to protect. Check the art fills the key corner to corner and " +
      "the two navigation keys still read as buttons beside it.",
  },
  {
    id: "page-gallery-cold",
    category: "A day on the deck",
    device: "deck-plus",
    state: "ready",
    page: "gallery",
    rotation: 3,
    title: "Gallery — art has not arrived yet",
    looking:
      "The first repaint after a page switch, before the fetcher has the images. Each key carries the " +
      "piece's name instead. Is the name legible, and does the key look like it is loading rather " +
      "than like it is broken?",
  },

  // ── before it knows anything ──────────────────────────────────────────────────────────────────
  {
    id: "cold-desktop",
    category: "Before it knows anything",
    device: "deck-plus",
    state: "cold",
    page: "desktop",
    title: "Nothing has answered — no compositor, no stats, no service",
    looking:
      "Every strip segment is an em dash and no key is active. An em dash is the truth here and a " +
      "zero would be a lie. Does the strip read as 'not known yet' rather than as 'all zero'?",
  },
  {
    id: "no-wallet-portfolio",
    category: "Before it knows anything",
    device: "deck-plus",
    state: "no-wallet",
    page: "portfolio",
    title: "The service is up and no wallet is configured",
    looking:
      "The most important thing on this frame is the strip saying `anchor · no wallet`. Eight blank " +
      "money keys with a cheerful 'anchor ready' would be indistinguishable from a wallet worth " +
      "nothing. Is the reason visible without hunting for it?",
  },
  {
    id: "loading-portfolio",
    category: "Before it knows anything",
    device: "deck-plus",
    state: "loading",
    page: "portfolio",
    title: "Configured, answering, first fetch still in flight",
    looking:
      "Em dashes with `anchor ready` beside them. This is the frame a cold start shows for a few " +
      "seconds and it must not be mistakable for the no-wallet frame above. Flip between the two.",
  },
  {
    id: "no-wallet-pulse",
    category: "Before it knows anything",
    device: "pulse-amoled",
    state: "no-wallet",
    page: "portfolio",
    title: "No wallet, on a screen with no strip to say so",
    looking:
      "The list has no status strip, so the reason has to survive in the rows themselves. Can a " +
      "person tell from this screen that nothing is wrong with their money?",
  },

  // ── something is wrong ────────────────────────────────────────────────────────────────────────
  {
    id: "service-down-portfolio",
    category: "When the data is wrong",
    device: "deck-plus",
    state: "service-down",
    page: "portfolio",
    title: "The data service is not running",
    looking:
      "`anchor · not running` on the strip, dashes above it. The failure names itself; check it is " +
      "not so quiet that it reads as an empty portfolio.",
  },
  {
    id: "service-refusing-portfolio",
    category: "When the data is wrong",
    device: "deck-plus",
    state: "service-refusing",
    page: "portfolio",
    title: "The service answered, and answered badly (503)",
    looking:
      "A different failure from the one above and it has to look different. The status code is the " +
      "whole content of the message — is it legible at strip size, or has it been ellipsised away?",
  },
  {
    id: "stale-portfolio",
    category: "When the data is wrong",
    device: "deck-plus",
    state: "stale",
    page: "portfolio",
    title: "Stale — a real figure, served from cache after a failure",
    looking:
      "The numbers are correct and 46 minutes old. `anchor.age` says `46m ago (stale)` and that is " +
      "the only thing separating this from the healthy frame. Is that enough? Flip against " +
      "'the portfolio page' in the first chapter.",
  },
  {
    id: "no-stats-portfolio",
    category: "When the data is wrong",
    device: "deck-plus",
    state: "no-stats",
    page: "portfolio",
    title: "Everything loaded except the headline figure",
    looking:
      "Holdings arrived, the total did not, so the money keys are dashes while the strip says the " +
      "service is fine. The worst reading of this frame is 'you have nothing'. Does anything on it " +
      "prevent that reading?",
  },
  {
    id: "no-gallery",
    category: "When the data is wrong",
    device: "deck-plus",
    state: "no-gallery",
    page: "gallery",
    title: "An empty gallery — nothing owned, or nothing left after the filters",
    looking:
      "Six keys captioned `Gallery` with a dash. `excludeCollections` can empty this on a wallet that " +
      "does own things. Does the page say enough to tell those apart, and does an empty key look " +
      "intentional?",
  },
  {
    id: "no-gallery-pulse",
    category: "When the data is wrong",
    device: "pulse-amoled",
    state: "no-gallery",
    page: "gallery",
    title: "An empty list, on the screen device",
    looking:
      "The list surface has an `empty` message for exactly this. Is it centred, legible, and does it " +
      "say *why* rather than just that there is nothing?",
  },

  // ── the awkward cases ─────────────────────────────────────────────────────────────────────────
  {
    id: "long-labels",
    category: "The awkward cases",
    device: "deck-plus",
    state: "long",
    page: "portfolio",
    title: "Long everywhere — ticker, chain, window title",
    looking:
      "`WSTETH·arbitrum-nova` on a 120px key, a 90-character window title on the strip. Truncation is " +
      "correct; truncation that leaves a label saying nothing is not. Is each cut label still " +
      "identifiable, and does the ellipsis sit inside the key rather than on its edge?",
  },
  {
    id: "long-labels-cardputer",
    category: "The awkward cases",
    device: "cardputer",
    state: "long",
    page: "chains",
    title: "Long labels at 80×35 — the tightest tile there is",
    looking:
      "Where truncation bites hardest. Check nothing overflows its tile into the next one, that the " +
      "strip at the top is not a row of ellipses, and that a value is still readable.",
  },
  {
    id: "big-numbers",
    category: "The awkward cases",
    device: "deck-plus",
    state: "down-day",
    page: "portfolio",
    title: "A seven-figure total, and a bad month",
    looking:
      "`$1,204,880` shrinks to fit rather than truncating, because the last digits of a number are " +
      "not optional. Check the shrunk reading still shares a baseline with the unshrunk ones beside " +
      "it, and that the negative P&L reads red without shouting.",
  },
  {
    id: "pressed-key",
    category: "The awkward cases",
    device: "deck-plus",
    state: "ready",
    page: "desktop",
    pressedKey: 5,
    title: "A key held down",
    looking:
      "The sixth key is `raised` rather than `ground`. A deck key has no travel, so this tint is the " +
      "only feedback a press gets. Is it visible through a diffuser — that is, obvious here without " +
      "being told which key to look at?",
  },
  {
    id: "list-selected",
    category: "The awkward cases",
    device: "pulse-amoled",
    state: "ready",
    page: "desktop",
    title: "A list with a row selected",
    looking:
      "The selected row gets a raised fill. Check it is distinguishable from the ground on this " +
      "theme, that the fill spans the full row width, and that the row's own text stays legible.",
  },

  // ── wearing the theme ─────────────────────────────────────────────────────────────────────────
  {
    id: "theme-latte",
    category: "Wearing the theme",
    device: "deck-plus",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    theme: "catppuccin-latte",
    title: "A light theme",
    looking:
      "Everything inverts. The gap between keys is now darker than the keys, the sparkline is a dark " +
      "line on a light key, and the active fill has less headroom to work with. Is the hierarchy the " +
      "same as it was on the dark theme, or has it flattened?",
  },
  {
    id: "theme-white",
    category: "Wearing the theme",
    device: "deck-plus",
    state: "toggled",
    page: "desktop",
    theme: "white",
    title: "`white` — a #ffffff ground with no headroom above it",
    looking:
      "The extreme case for the raised surface: there is no lighter colour than the ground, so depth " +
      "has to go downward instead. Can you still tell a pressed key, an active key and an ordinary " +
      "key apart?",
  },
  {
    id: "theme-vantablack",
    category: "Wearing the theme",
    device: "deck-plus",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    theme: "vantablack",
    title: "`vantablack` — #000000, with nothing below it",
    looking:
      "The opposite extreme. The tile edge is doing all the work of separating one key from the next. " +
      "Is each key still a shape, or has the grid become one black slab?",
  },
  {
    id: "theme-harbor",
    category: "Wearing the theme",
    device: "cardputer",
    state: "ready",
    page: "portfolio",
    rotation: 0,
    theme: "harbor",
    title: "A theme this repo ships, on the smallest device",
    looking:
      "`themes/harbor` is ours, so anything wrong here is ours to fix in the palette rather than in " +
      "the renderer. Check the accent against the tile and the strip against the tiles under it.",
  },

  // ── blanked ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "blank-deck",
    category: "Blanked by the lock",
    device: "deck-plus",
    state: "ready",
    page: "portfolio",
    blank: true,
    title: "The session locked — the deck is showing nothing",
    looking:
      "Correct is an empty rectangle. The deck sits in a room its owner has walked out of, so a " +
      "portfolio still on it after the lock is a security bug, not a nicety. Anything visible here " +
      "other than the ground is a finding.",
  },
  {
    id: "blank-pulse",
    category: "Blanked by the lock",
    device: "pulse-amoled",
    state: "ready",
    page: "portfolio",
    blank: true,
    title: "The pulse display, blanked",
    looking:
      "Same rule, and this one matters more: a desk display is the device most likely to be left " +
      "alone in a room. The outline is the panel edge — nothing inside it should carry a figure.",
  },

  // ── contract surfaces ─────────────────────────────────────────────────────────────────────────
  {
    id: "contract-detail",
    category: "Surfaces at their edges",
    device: "pulse-amoled",
    state: "ready",
    title: "`detail` — every field at once, painted directly rather than through a page",
    looking:
      "`pulseDetail` never sets a badge or this many lines; this is the shape the contract allows " +
      "rather than the shape a page asks for today, so a future producer does not discover a collision " +
      "`svg.ts` never had to handle. Check the footer is whole (never truncated by design), the badge " +
      "does not collide with the title, and the lines have room to breathe.",
    frame: () =>
      new Map<string, Surface>([
        [
          SCREEN_SLOT,
          {
            kind: "detail",
            title: "Pudgy Penguin 4821",
            badge: "held",
            lines: [
              { label: "Collection", value: "pudgy-penguins" },
              { label: "Chain", value: "ethereum" },
              { label: "Floor", value: "$9,140", tone: "accent" },
              { label: "Held for", value: "412 days" },
              { label: "Last sale", value: "$7,880", tone: "negative" },
            ],
            footer: "Approval happens on the desktop, never here.",
          },
        ],
      ]),
  },
];

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** What `scripts/review.ts` needs to put a case on the review page. */
export interface DeviceCase {
  readonly id: string;
  readonly title: string;
  readonly looking: string;
  readonly category: string;
  /** Where the PNG lands under `review/`. */
  readonly file: string;
  readonly device: DeviceProfile;
  readonly state: StateFixture;
  readonly theme: string;
  readonly spec: CaseSpec;
}

/**
 * Every case, resolved.
 *
 * A spec naming a device or state that does not exist is dropped rather than thrown, and
 * `review.test.ts` asserts none is — so a typo fails the suite instead of quietly shrinking the
 * review, which is the failure mode this page already had once with the panel gallery.
 */
export function deviceCases(): DeviceCase[] {
  return CASES.flatMap((spec): DeviceCase[] => {
    const device = deviceById(spec.device);
    const state = stateById(spec.state);
    if (device === null || state === null) return [];
    return [
      {
        // Namespaced, because the review page's ids are global across the widget, the bar and this.
        id: `dev-${spec.id}`,
        title: spec.title,
        looking: `${spec.looking} — ${device.title}: ${device.note}`,
        category: spec.category,
        file: `devices/${spec.id}.png`,
        device,
        state,
        theme: spec.theme ?? DEFAULT_THEME,
        spec,
      },
    ];
  });
}

/** A device that paints nowhere. `Panel.build` only reads `capabilities`, so this is all it needs. */
class StillDevice implements AnchorDevice {
  readonly id = "review";
  readonly capabilities: DeviceCapabilities;
  constructor(capabilities: DeviceCapabilities) {
    this.capabilities = capabilities;
  }
  async paint(): Promise<void> {}
  async setBrightness(): Promise<void> {}
  onInput(_handler: (input: DeviceInput) => void): void {}
  async close(): Promise<void> {}
}

/**
 * Build the frame for one case.
 *
 * A held key is applied by rewriting the tile's emphasis rather than by feeding a `press` through
 * `Panel.handle`. That is not tidiness: `handle` *dispatches the key's action*, so rendering a
 * review of the desktop page would run `omarchy capture screenshot region` and cycle the user's
 * theme. The resulting surface is the same one `handle` would have produced.
 */
export function buildFrame(entry: DeviceCase, config: PanelConfig, tokens: Tokens): Frame {
  const { spec, device, state } = entry;
  // The lock blanks the device: every adapter clears the panel and drops the backlight to zero, and
  // nothing repaints until it unlocks. An empty frame is what the hardware is actually showing.
  if (spec.blank === true) return new Map<string, Surface>();
  if (spec.frame !== undefined) return spec.frame(device);

  const panel = new Panel(config, tokens);
  if (spec.page !== undefined && !panel.setPage(spec.page)) {
    throw new Error(`case ${spec.id}: no page named ${spec.page}`);
  }
  const panelState: PanelState = {
    desktop: state.desktop,
    service: state.service,
    themeName: tokens.themeName,
    portfolio: state.portfolio,
    timeframe: state.timeframe,
    rotation: spec.rotation ?? 0,
  };
  const frame = panel.build(new StillDevice(device.capabilities), panelState);

  if (spec.pressedKey === undefined) return frame;
  const held = new Map(frame);
  const slot = keySlot(spec.pressedKey);
  const surface = held.get(slot);
  if (surface !== undefined && surface.kind === "tile") held.set(slot, { ...surface, emphasis: "raised" });
  return held;
}

/** The palette for a case, read off disk so a name that is not installed fails loudly. */
export function tokensFor(theme: string): Tokens {
  const found = themeOnDisk(theme);
  if (found === null) {
    throw new Error(
      `theme "${theme}" is not installed — install it, or change the case. Rendering it through ` +
        "loadTokens would silently paint Tokyo Night under a card captioned with this name.",
    );
  }
  return deviceTokens(found.name, found.colors);
}

/** Crop a region of a repo image, for gallery fixtures. Bytes only; nothing is fetched. */
function cropRegion(file: string, gravity: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      "magick",
      [file, "-gravity", gravity, "-crop", "45%x45%+0+0", "+repage", "JPEG:-"],
      { encoding: "buffer", maxBuffer: 1 << 26, timeout: 20_000 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

const ART_SOURCES = ["site/assets/hero-deep.jpg", "site/assets/og.jpg"];
const ART_GRAVITIES = ["NorthWest", "North", "NorthEast", "West", "Center", "East", "SouthWest", "South"];

/**
 * Give the gallery fixtures something to show.
 *
 * Two images this repository already owns, cropped eight ways, pushed into the art cache under the
 * fixture urls. The alternative — fetching real artwork — would make the review depend on the open
 * internet and on somebody's wallet, and would put marketplace bytes into a tool that runs
 * unattended.
 */
export async function seedGallery(): Promise<number> {
  let seeded = 0;
  for (const [index, piece] of GALLERY.entries()) {
    const source = join(REPO, ART_SOURCES[index % ART_SOURCES.length] ?? "");
    const gravity = ART_GRAVITIES[index % ART_GRAVITIES.length] ?? "Center";
    let bytes: Buffer | null = null;
    try {
      bytes = await cropRegion(source, gravity);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      // Fall back to the whole image rather than skipping: a gallery of identical keys still
      // reviews the art layout, and a gallery of blanks does not.
      try {
        bytes = readFileSync(source);
      } catch {
        continue;
      }
    }
    if ((await seedThumbnail(piece.imageUrl, bytes)) !== null) seeded++;
  }
  // `prefetch` is what the daemon calls; going through it here means the review exercises the same
  // path rather than a shortcut around it. Everything is already in memory, so it opens no sockets.
  await prefetch(GALLERY.map((piece) => piece.imageUrl));
  return seeded;
}

export interface RenderResult {
  readonly id: string;
  readonly file: string;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Render cases to PNGs under `outDir`.
 *
 * Concurrent, because each case is one ImageMagick process and they do not contend: the whole set
 * is a few seconds serially and well under one in parallel, which is the difference between a loop
 * you use while iterating and one you run once and stop running.
 */
export async function renderCases(
  cases: readonly DeviceCase[],
  outDir: string,
  concurrency = 8,
): Promise<RenderResult[]> {
  const { config } = loadConfig(join(REPO, "devices/config/panel.json"));
  for (const dir of new Set(cases.map((entry) => dirname(join(outDir, entry.file))))) {
    mkdirSync(dir, { recursive: true });
  }

  // Measure the glyphs the config uses once, before anything paints, so icons are centred in every
  // frame rather than in the ones rendered after the cache warmed.
  await loadGlyphMetrics(
    config.pages.flatMap((page) => [
      ...page.keys.map((key) => key.icon),
      ...page.dials.map((dial) => dial.icon),
      ...page.segments.map((segment) => segment.icon),
    ]),
  );
  await seedGallery();

  const palettes = new Map<string, Tokens>();
  const results: RenderResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const entry = cases[index];
      if (entry === undefined) return;
      try {
        let tokens = palettes.get(entry.theme);
        if (tokens === undefined) {
          tokens = tokensFor(entry.theme);
          palettes.set(entry.theme, tokens);
        }
        const frame = buildFrame(entry, config, tokens);
        const layout = composeSvg(frame, tokens, entry.device.capabilities.slots, {
          columns: entry.device.columns,
          rects: entry.device.rects,
        });
        await writePreview(layout, join(outDir, entry.file));
        results[index] = { id: entry.spec.id, file: entry.file, ok: true };
      } catch (error) {
        results[index] = {
          id: entry.spec.id,
          file: entry.file,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
