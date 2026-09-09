/**
 * The panel: config plus live state, in, frames and actions, out.
 *
 * This is the layer that knows nothing about HID. It is given a device's capabilities — how many
 * key slots, how big, whether there is a strip — and produces a `Frame`. That is what makes the next
 * device cheap: a Cardputer with one screen and no encoders gets the same panel logic, and simply
 * has no key slots to fill.
 */

import * as actions from "./actions.ts";
import type { PageConfig, PanelConfig } from "./config.ts";
import { cachedThumbnail } from "./images.ts";
import type { ServiceStatus } from "./state/anchor.ts";
import { describeAge, type PortfolioSnapshot, TIMEFRAMES, type Timeframe } from "./state/anchor.ts";
import type { DesktopSnapshot } from "./state/desktop.ts";
import type { Tokens } from "./tokens.ts";
import type { AnchorDevice, BarSegment, DeviceInput, Frame, ListRow, Surface, TokenName } from "./types.ts";

export interface PanelState {
  readonly desktop: DesktopSnapshot;
  readonly service: ServiceStatus;
  /** The palette being painted. Defaults to the desktop's theme; pinned by `--theme`. */
  readonly themeName?: string;
  readonly portfolio?: PortfolioSnapshot;
  readonly timeframe?: Timeframe;
  /** Advances on a slow beat so galleries rotate. Set by the runner, not by a clock in here. */
  readonly rotation?: number;
}

/** What a data-backed key shows: a reading, an optional caption, and a tone. */
export interface KeyReading {
  readonly value: string;
  readonly label?: string;
  readonly tone?: TokenName;
  readonly spark?: readonly number[];
  readonly slices?: readonly { readonly value: number; readonly tone?: TokenName }[];
  readonly image?: string;
  /**
   * What pressing this key should do, when the key itself is showing something.
   *
   * A key whose content rotates cannot have its action written in config: the piece on it changes
   * every few seconds, and the useful thing to do is open *that* piece. So the source supplies the
   * action alongside the reading, and config only has to say what the key is for.
   */
  readonly action?: string;
}

/**
 * Format a USD string from the API for a 120px key.
 *
 * The API sends money as a string and `anchor.ts` keeps it as one, because parsing to re-format is
 * how precision goes missing. Here it is parsed *for display only*: a key is a glance, and
 * "125430.5" is not one. Anything unparseable becomes an em dash rather than `$NaN`.
 */
export function usd(value: string | null): string {
  if (value === null) return "—";
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return "—";
  const digits = Math.abs(amount) >= 1000 ? 0 : 2;
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Signed percentage, e.g. "+1.01%". Tone is decided by the caller from the sign. */
function percent(value: string | null): string {
  if (value === null) return "—";
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return "—";
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function signTone(value: string | null): TokenName | undefined {
  if (value === null) return undefined;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount === 0) return undefined;
  return amount > 0 ? "positive" : "negative";
}

const NOT_LOADED: KeyReading = { value: "—" };

/** Open the wallet's own OpenSea page, when the service knows which wallet that is. */
function profileAction(service: ServiceStatus): string | undefined {
  return service.wallet === undefined || service.wallet === ""
    ? undefined
    : `omarchy launch browser https://opensea.io/${service.wallet}`;
}

/**
 * Readings a key can show. The argument after `:` selects a rank, so `token:1` is the largest
 * holding — which keeps three top-token keys from needing three near-identical sources.
 */
export const KEY_SOURCES: Readonly<Record<string, (state: PanelState, argument: string) => KeyReading>> = {
  "portfolio.total": ({ portfolio }) => ({ value: usd(portfolio?.stats?.totalUsd ?? null), label: "Total" }),
  "portfolio.nft": ({ portfolio }) => ({ value: usd(portfolio?.stats?.nftUsd ?? null), label: "NFTs" }),
  "portfolio.token": ({ portfolio }) => ({ value: usd(portfolio?.stats?.tokenUsd ?? null), label: "Tokens" }),
  "portfolio.pnl": ({ portfolio, timeframe }) => {
    const pnl = portfolio?.stats?.pnlPercentage ?? null;
    return { value: percent(pnl), label: `P&L ${(timeframe ?? "DAY").toLowerCase()}`, tone: signTone(pnl) };
  },
  "portfolio.pnlAbsolute": ({ portfolio }) => {
    const pnl = portfolio?.stats?.pnlAbsolute ?? null;
    return { value: usd(pnl), label: "P&L", tone: signTone(pnl) };
  },
  "portfolio.nftCount": ({ portfolio }) => ({
    value:
      portfolio?.nftCount === null || portfolio?.nftCount === undefined ? "—" : String(portfolio.nftCount),
    label: "Held",
  }),
  token: ({ portfolio }, argument) => {
    const rank = Math.max(1, Number.parseInt(argument || "1", 10));
    const holdings = portfolio?.tokens ?? [];
    const holding = holdings[rank - 1];
    // Keep the caption when there is no holding, so an empty page still says what each key is for.
    if (holding === undefined) return { ...NOT_LOADED, label: `Top ${rank}` };
    // Across 29 chains the same ticker appears repeatedly — three keys reading "ETH" name nothing.
    // The chain is only added when the symbol is actually ambiguous, so the common case stays short.
    const ambiguous = holdings.filter((other) => other.symbol === holding.symbol).length > 1;
    const label = ambiguous && holding.chain !== "" ? `${holding.symbol}·${holding.chain}` : holding.symbol;
    return {
      value: usd(String(holding.usdValue)),
      label,
      action: holding.openseaUrl === "" ? undefined : `omarchy launch browser ${holding.openseaUrl}`,
    };
  },
  "portfolio.spark": ({ portfolio, timeframe, service }) => {
    const pnl = portfolio?.stats?.pnlPercentage ?? null;
    return {
      action: profileAction(service),
      value: usd(portfolio?.stats?.totalUsd ?? null),
      label: (timeframe ?? "DAY").toLowerCase(),
      tone: signTone(pnl),
      spark: portfolio?.history,
    };
  },
  "portfolio.pnlSpark": ({ portfolio, timeframe, service }) => {
    const pnl = portfolio?.stats?.pnlPercentage ?? null;
    return {
      action: profileAction(service),
      value: percent(pnl),
      label: `P&L ${(timeframe ?? "DAY").toLowerCase()}`,
      tone: signTone(pnl),
      spark: portfolio?.history,
    };
  },
  "portfolio.split": ({ portfolio }) => {
    const nft = Number.parseFloat(portfolio?.stats?.nftUsd ?? "");
    const token = Number.parseFloat(portfolio?.stats?.tokenUsd ?? "");
    if (!Number.isFinite(nft) && !Number.isFinite(token)) return { ...NOT_LOADED, label: "Split" };
    const total = (Number.isFinite(nft) ? nft : 0) + (Number.isFinite(token) ? token : 0);
    const nftShare = total === 0 ? 0 : Math.round(((Number.isFinite(nft) ? nft : 0) / total) * 100);
    return {
      value: `${nftShare}%`,
      label: "NFT share",
      slices: [
        { value: Number.isFinite(nft) ? nft : 0, tone: "accent" },
        { value: Number.isFinite(token) ? token : 0, tone: "positive" },
      ],
    };
  },
  "portfolio.chains": ({ portfolio }) => {
    const chains = portfolio?.chains ?? [];
    if (chains.length === 0) return { ...NOT_LOADED, label: "Chains" };
    return {
      value: String(chains.length),
      label: "Chains",
      // Top five carry their own colour; the tail is summed so the donut still totals the portfolio.
      slices: [
        ...chains.slice(0, 5).map((entry) => ({ value: entry.usdValue })),
        {
          value: chains.slice(5).reduce((sum, entry) => sum + entry.usdValue, 0),
          tone: "inkDim" as TokenName,
        },
      ],
    };
  },
  /**
   * An owned piece, rotating.
   *
   * `nft:2` is offset by one from `nft:1`, so a row of these shows different pieces rather than the
   * same one repeated. The artwork appears when the fetcher has it; until then the key carries the
   * name, which is still more use than a blank.
   */
  nft: ({ portfolio, rotation }, argument) => {
    const offset = Math.max(1, Number.parseInt(argument || "1", 10)) - 1;
    const pieces = portfolio?.nfts ?? [];
    if (pieces.length === 0) return { ...NOT_LOADED, label: "Gallery" };
    const piece = pieces[((rotation ?? 0) + offset) % pieces.length];
    if (piece === undefined) return { ...NOT_LOADED, label: "Gallery" };
    const art = cachedThumbnail(piece.imageUrl);
    return {
      action: piece.openseaUrl === "" ? undefined : `omarchy launch browser ${piece.openseaUrl}`,
      value: "",
      // No caption once the art is here: a title over a picture is a label on a painting, and the
      // key is 120px. Until the art arrives the name is all there is, so it stands in.
      label: art === null ? piece.name || piece.collection || "Untitled" : "",
      image: art ?? undefined,
    };
  },
  chain: ({ portfolio }, argument) => {
    const rank = Math.max(1, Number.parseInt(argument || "1", 10));
    const entry = portfolio?.chains[rank - 1];
    if (entry === undefined) return { ...NOT_LOADED, label: `Chain ${rank}` };
    return { value: usd(String(entry.usdValue)), label: entry.chain };
  },
  collection: ({ portfolio }, argument) => {
    const rank = Math.max(1, Number.parseInt(argument || "1", 10));
    const entry = portfolio?.topCollections[rank - 1];
    if (entry === undefined) return { ...NOT_LOADED, label: `Coll ${rank}` };
    return { value: String(entry.count), label: entry.slug };
  },
};

export function readKeySource(name: string, state: PanelState): KeyReading | null {
  const marker = name.indexOf(":");
  const key = marker === -1 ? name : name.slice(0, marker);
  const argument = marker === -1 ? "" : name.slice(marker + 1);
  const source = KEY_SOURCES[key];
  return source === undefined ? null : source(state, argument);
}

/** Slot ids the adapters agree on. Kept here so panel and adapter cannot drift apart. */
export const keySlot = (index: number): string => `key:${index}`;
export const dialSlot = (index: number): string => `dial:${index}`;
export const screenSlot = (index: number): string => `screen:${index}`;
export const STRIP_SLOT = "strip:0";
/**
 * The screen of a device that has one instead of a key grid.
 *
 * It lives here rather than in an adapter because two adapters needed it independently, and a slot
 * id defined twice is a slot id that will eventually be spelled two ways.
 */
export const SCREEN_SLOT = screenSlot(0);

/**
 * Named values a strip segment can show.
 *
 * Anything absent renders as an em dash rather than a zero. A zero is a reading; a dash says there
 * is nothing to read, and on a device with no backlight those are very different claims.
 */
export const SEGMENT_SOURCES: Readonly<Record<string, (state: PanelState, page: string) => string>> = {
  workspace: ({ desktop }) => (desktop.workspace === null ? "—" : `ws ${desktop.workspace}`),
  window: ({ desktop }) => desktop.windowTitle || "—",
  volume: ({ desktop }) => (desktop.muted ? "muted" : `${Math.round(desktop.volume * 100)}%`),
  brightness: ({ desktop }) => (desktop.brightness === null ? "—" : `${desktop.brightness}%`),
  cpu: ({ desktop }) => (desktop.cpu === "" ? "—" : `cpu ${desktop.cpu}`),
  // `omarchy system stats` reports "6.7GB / 15GB". The total is fixed and knowable; on a strip
  // competing for width, the half that changes is the half worth showing.
  memory: ({ desktop }) => (desktop.memory === "" ? "—" : (desktop.memory.split("/")[0] ?? "").trim()),
  // Reports the palette actually being painted, not the desktop's setting. Normally identical; they
  // differ under `--theme`, and a preview that names a theme it is not wearing misleads the review.
  theme: ({ themeName, desktop }) => themeName || desktop.theme || "—",
  page: (_state, page) => page,
  clock: () => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  // Principle 7 in theme/README.md: say what a view covers, on the view. "up" alone would let a
  // service with no wallet configured read as a working portfolio.
  "anchor.service": ({ service }) =>
    service.reachable
      ? service.hasWallet
        ? "anchor ready"
        : "anchor · no wallet"
      : `anchor · ${service.detail}`,
  "anchor.chain": ({ service }) => service.primaryChain || "—",
  "anchor.timeframe": ({ timeframe }) => (timeframe ?? "DAY").toLowerCase(),
  "anchor.total": ({ portfolio }) => usd(portfolio?.stats?.totalUsd ?? null),
  // Provenance, per theme/README.md principle 6: a number attached to how old it is can be checked;
  // one that simply appears cannot. `stale` means the service served a cached value after a failure.
  "anchor.age": ({ portfolio }) => {
    if (portfolio === undefined || portfolio.detail !== "") return portfolio?.detail ?? "—";
    if (portfolio.ageSeconds === null) return "—";
    return `${describeAge(portfolio.ageSeconds)}${portfolio.stale ? " (stale)" : ""}`;
  },
};

/**
 * Width to reserve per segment source, in characters.
 *
 * Sized to the widest realistic reading rather than the current one: cpu reaches "cpu 100%", volume
 * reaches "muted", a workspace id can reach two digits. Sources whose width is already stable, or
 * which sit last on the strip, are absent and simply take the room they need.
 */
export const SEGMENT_MIN_CHARS: Readonly<Record<string, number>> = {
  cpu: 8,
  memory: 7,
  volume: 5,
  workspace: 5,
  brightness: 4,
  clock: 5,
  "anchor.total": 9,
  "anchor.timeframe": 5,
  "anchor.age": 9,
};

export class Panel {
  readonly #config: PanelConfig;
  #pageName: string;
  #tokens: Tokens;
  #pressed = new Set<string>();
  #timeframe: Timeframe = "DAY";
  #selected = 0;
  #filter = "";
  #deckBrightness = 70;
  /**
   * The action each key would perform, as of the last frame.
   *
   * Recorded during `build` because that is where the reading is known, and a press arrives later
   * with no state attached. Keyed by slot, so the action always matches the thing on the key rather
   * than whatever the gallery has rotated to since.
   */
  readonly #dynamicActions = new Map<string, string>();

  constructor(config: PanelConfig, tokens: Tokens) {
    const first = config.pages[0];
    // `parseConfig` already refuses an empty page list; this makes that guarantee visible to the
    // type checker instead of asserting it away.
    if (first === undefined) throw new Error("a panel needs at least one page");
    this.#config = config;
    this.#tokens = tokens;
    this.#pageName = first.name;
  }

  get tokens(): Tokens {
    return this.#tokens;
  }

  set tokens(next: Tokens) {
    this.#tokens = next;
  }

  get pageName(): string {
    return this.#pageName;
  }

  /** The window the portfolio page is reporting over. Scrubbed by a dial, read by the poller. */
  get timeframe(): Timeframe {
    return this.#timeframe;
  }

  /**
   * The device's own backlight, 0-100.
   *
   * Distinct from `brightness`, which is the desktop's display. On a machine used remotely the deck
   * is the thing in the room, so its own brightness is the more useful control — and it is the one
   * dial that needs no desktop at all.
   */
  get deckBrightness(): number {
    return this.#deckBrightness;
  }

  /** The filter text a keyboard device has committed. Narrows rows; never dispatched. */
  get filter(): string {
    return this.#filter;
  }

  get selected(): number {
    return this.#selected;
  }

  /**
   * The page's keys as rows, filtered.
   *
   * A key and a row are the same thing said for different hardware: a label, an optional reading,
   * and something to do when it is chosen. Composing rows here rather than in an adapter is what
   * stops a screen device having to fetch its own data.
   */
  rows(state: PanelState): ListRow[] {
    const needle = this.#filter.trim().toLowerCase();
    return this.page.keys
      .map((key) => {
        const reading = key.source === "" ? null : readKeySource(key.source, state);
        return {
          key,
          row: {
            label: key.label || reading?.label || `Key ${key.index}`,
            value: reading?.value,
            icon: key.icon || undefined,
            tone: reading?.tone ?? key.tone,
          } satisfies ListRow,
        };
      })
      .filter(({ row }) => needle === "" || row.label.toLowerCase().includes(needle))
      .map(({ row }) => row);
  }

  get page(): PageConfig {
    const found = this.#config.pages.find((p) => p.name === this.#pageName) ?? this.#config.pages[0];
    if (found === undefined) throw new Error("a panel needs at least one page");
    return found;
  }

  get brightness(): number {
    return this.#config.brightness;
  }

  setPage(name: string): boolean {
    if (!this.#config.pages.some((p) => p.name === name)) return false;
    this.#pageName = name;
    return true;
  }

  /** Build the frame for a device, filling only the slots that device actually has. */
  build(device: AnchorDevice, state: PanelState): Frame {
    const frame = new Map<string, Surface>();
    const page = this.page;
    const slots = new Set(device.capabilities.slots.filter((slot) => slot.paintable).map((slot) => slot.id));

    // Blank every paintable key first, so a page with fewer keys than the device clears the rest
    // rather than leaving the previous page's faces behind.
    for (const slot of device.capabilities.slots) {
      if (slot.kind === "key" && slot.paintable) frame.set(slot.id, { kind: "tile", emphasis: "ground" });
    }

    for (const key of page.keys) {
      const id = keySlot(key.index);
      if (!slots.has(id)) continue;
      const active = actions.resolveActive(key.state, state.desktop, this.#pageName);
      const reading = key.source === "" ? null : readKeySource(key.source, state);
      if (reading?.action === undefined) this.#dynamicActions.delete(id);
      else this.#dynamicActions.set(id, reading.action);
      frame.set(id, {
        kind: "tile",
        icon: key.icon || undefined,
        // A configured label wins, so a key can be captioned by hand; otherwise the source names
        // itself, which is what lets `token:1` render as the symbol it happens to be today.
        label: key.label || reading?.label || undefined,
        value: reading?.value,
        spark: reading?.spark,
        slices: reading?.slices,
        image: reading?.image,
        emphasis: this.#pressed.has(id) ? "raised" : active ? "active" : "ground",
        tone: reading?.tone ?? key.tone,
      });
    }

    // A dial's readout occupies the key above it where the device pairs them; on the Stream Deck +
    // the encoders have no display of their own, so the strip carries their labels instead.
    for (const dial of page.dials) {
      const id = dialSlot(dial.index);
      if (!slots.has(id)) continue;
      frame.set(id, {
        kind: "tile",
        icon: dial.icon || undefined,
        label: dial.label || undefined,
        emphasis: "ground",
        tone: dial.tone,
        meter: dial.control === "volume" ? state.desktop.volume : undefined,
      });
    }

    // A screen device gets the same page as a list. Selection is clamped here because the row count
    // depends on the filter, which only the panel knows.
    for (const slot of device.capabilities.slots) {
      if (!slot.paintable || slot.kind !== "screen") continue;
      const rows = this.rows(state);
      this.#selected = rows.length === 0 ? 0 : Math.min(this.#selected, rows.length - 1);
      frame.set(slot.id, {
        kind: "list",
        rows,
        selected: rows.length === 0 ? undefined : this.#selected,
        empty: this.#filter === "" ? "nothing on this page" : `nothing matches "${this.#filter}"`,
      });
    }

    if (slots.has(STRIP_SLOT)) {
      const segments: BarSegment[] = page.segments.map((segment) => ({
        icon: segment.icon || undefined,
        text: (SEGMENT_SOURCES[segment.source] ?? (() => `?${segment.source}`))(state, this.#pageName),
        tone: segment.tone,
        minChars: SEGMENT_MIN_CHARS[segment.source],
      }));
      frame.set(STRIP_SLOT, {
        kind: "bar",
        segments,
        // Only where it means something: the desktop strip has no portfolio behind it.
        background: state.portfolio?.history,
      });
    }

    return frame;
  }

  /**
   * Apply an input. Returns true when the panel should repaint.
   *
   * Press and release both repaint so a key visibly depresses; without it the panel feels dead on a
   * device whose keys have no travel.
   */
  handle(input: DeviceInput): boolean {
    const context: actions.ActionContext = { setPage: (name) => void this.setPage(name) };
    const page = this.page;

    switch (input.kind) {
      case "press": {
        this.#pressed.add(input.slot);
        if (input.slot.startsWith("screen:")) {
          // On a screen device the chosen row is the action, and the panel knows which row that is.
          const key = this.page.keys[this.#selected];
          if (key !== undefined && key.action !== "") actions.dispatch(key.action, context);
          return true;
        }
        const key = page.keys.find((k) => keySlot(k.index) === input.slot);
        // Config wins; otherwise do whatever the key is currently showing.
        const dynamic = this.#dynamicActions.get(input.slot);
        if (key && key.action !== "") actions.dispatch(key.action, context);
        else if (dynamic !== undefined) actions.dispatch(dynamic, context);
        const dial = page.dials.find((d) => dialSlot(d.index) === input.slot);
        if (dial && dial.press !== "") actions.dispatch(dial.press, context);
        return true;
      }
      case "release":
        this.#pressed.delete(input.slot);
        return true;
      case "rotate": {
        if (input.slot.startsWith("screen:")) {
          this.#selected = Math.max(0, this.#selected + (input.delta > 0 ? 1 : -1));
          return true;
        }
        const dial = page.dials.find((d) => dialSlot(d.index) === input.slot);
        if (!dial) return false;
        if (dial.control === "deck") {
          const step = dial.step === 0 ? 5 : dial.step;
          this.#deckBrightness = Math.min(
            100,
            Math.max(5, this.#deckBrightness + (input.delta > 0 ? step : -step)),
          );
          return true;
        }
        if (dial.control === "timeframe") {
          // The one dial that changes what is *shown* rather than what the machine is doing. A
          // physical control over a data dimension is the thing a dial is genuinely better at than
          // a keyboard shortcut.
          const at = TIMEFRAMES.indexOf(this.#timeframe);
          const next = (at + (input.delta > 0 ? 1 : -1) + TIMEFRAMES.length) % TIMEFRAMES.length;
          this.#timeframe = TIMEFRAMES[next] ?? this.#timeframe;
          return true;
        }
        const control = actions.DIAL_CONTROLS[dial.control];
        if (control === undefined) return false;
        control(input.delta * dial.step);
        return true;
      }
      case "swipe": {
        // Swiping the strip pages the panel, which is the gesture the hardware invites.
        const names = this.#config.pages.map((p) => p.name);
        const index = names.indexOf(this.#pageName);
        const next = input.to > input.from ? index + 1 : index - 1;
        const target = names[(next + names.length) % names.length];
        if (target !== undefined) this.setPage(target);
        return true;
      }
      case "text":
        // A filter, and only a filter. It narrows what is already on screen; nothing evaluates it,
        // and it never reaches `actions.dispatch`.
        this.#filter = input.value;
        this.#selected = 0;
        return true;
      case "tap":
        return false;
      default:
        return false;
    }
  }
}
