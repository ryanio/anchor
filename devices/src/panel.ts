/**
 * The panel: config plus live state, in, frames and actions, out.
 *
 * This is the layer that knows nothing about HID. It is given a device's capabilities — how many
 * key slots, how big, whether there is a strip — and produces a `Frame`. That is what makes the next
 * device cheap: a Cardputer with one screen and no encoders gets the same panel logic, and simply
 * has no key slots to fill.
 */

import * as actions from "./actions.ts";
import type { KeyConfig, PageConfig, PanelConfig } from "./config.ts";
import { cachedThumbnail, thumbnail } from "./images.ts";
import type { ServiceStatus } from "./state/anchor.ts";
import { describeAge, type PortfolioSnapshot, TIMEFRAMES, type Timeframe } from "./state/anchor.ts";
import type { TrendingCollection, TrendingToken } from "./state/discovery.ts";
import type { DesktopSnapshot } from "./state/desktop.ts";
import type { Tokens } from "./tokens.ts";
import { gridCellAt } from "./svg.ts";
import type {
  AnchorDevice,
  BarSegment,
  DeviceInput,
  Frame,
  GridCell,
  SlotSpec,
  Surface,
  TokenName,
} from "./types.ts";

export interface PanelState {
  readonly desktop: DesktopSnapshot;
  readonly service: ServiceStatus;
  /** The palette being painted. Defaults to the desktop's theme; pinned by `--theme`. */
  readonly themeName?: string;
  readonly portfolio?: PortfolioSnapshot;
  readonly timeframe?: Timeframe;
  /** Advances on a slow beat so galleries rotate. Set by the runner, not by a clock in here. */
  readonly rotation?: number;
  /**
   * 0 to 1: how far through the current rotation window `rotation` is, for `pulseDetail`'s sync
   * bar. Set by the runner from the same wall clock `rotation` comes from, so it needs no state of
   * its own to stay in step with it.
   */
  readonly rotationProgress?: number;
  /**
   * The wall clock in milliseconds, from the same reading `rotation` was derived from.
   *
   * Only the tap hold uses it (see `TAP_HOLD_MS`), and it is here rather than a `Date.now()` inside
   * this file for the same reason `rotation` is: a panel that reads a clock cannot be driven to a
   * known frame by a test or by `review.ts`, and every assertion in `panel.test.ts` rests on
   * `build` being a function of what it was handed. A runner that leaves it out still gets the
   * tap's advance — it just gets no hold, rather than a page frozen on one item for ever.
   */
  readonly nowMs?: number;
  /** What's moving, not what's owned — the `tokens`/`nfts` pages' data. See `state/discovery.ts`. */
  readonly discoveryTokens?: readonly TrendingToken[];
  readonly discoveryCollections?: readonly TrendingCollection[];
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
      // The piece is named whether or not its picture has arrived. Suppressing the caption over
      // artwork is `renderTile`'s job, because it is a decision about a 120px key and `types.ts`
      // rule 1 says nothing outside a renderer knows a pixel size. Blanking it here also broke the
      // devices that have no keys: the same page drawn as a list read "Key 2" where the gallery is.
      label: piece.name || piece.collection || "Untitled",
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
/**
 * How many pieces the gallery dial can put in rotation, at each end.
 *
 * `MAX` matches `/portfolio?limit=50` in `state/anchor.ts` — the dial cannot scrub past what was
 * ever fetched, so its top end starts as "everything" rather than as a number invented here. `MIN`
 * is one rather than zero: a dial that can turn a gallery empty is a dial that can make a page whose
 * whole point is the art show `nothing to show`, which is a bug wearing a control's clothing.
 */
export const MAX_GALLERY_NFTS = 50;
export const MIN_GALLERY_NFTS = 1;

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

/**
 * The pages that rotate through a list of items on the wall clock, and so are the pages a tap can
 * steer. `pulseDetail` returns a surface for exactly these and null for everything else; the guard
 * at the top of it reads this set so the two cannot disagree about which pages rotate. Add a page
 * there and it renders nothing until it is named here, which is a loud failure rather than a page
 * whose tap silently does nothing.
 */
export const ROTATING_PAGES: ReadonlySet<string> = new Set(["portfolio", "gallery", "tokens", "nfts"]);

/**
 * How long a tapped item stays put before the wall clock takes the page back.
 *
 * Reasoned, not measured — there is no hardware emitting taps yet, so this is a judgement about
 * reading time and it should be re-decided against a real panel and a real thumb. What it is sized
 * against: `ROTATE_MS` in `cli.ts` is six seconds, chosen for a glance from across a desk, and a
 * tap is the opposite of a glance — someone is now looking *at* the thing and reading a collection
 * name, a price and a 24h change off it. Ten seconds is longer than one rotation window, which is
 * the failure this exists to prevent: a tap landing 200ms before the clock flips would otherwise
 * summon a piece and have it yanked away before the eye arrived, and that reads as the tap having
 * done something random rather than what was asked. It is under two windows so a panel someone
 * tapped and walked away from is ambient again, and back in step with the units beside it, inside a
 * quarter of a minute — a hold that outlives the interest in it is just a broken rotation.
 */
export const TAP_HOLD_MS = 10_000;

export class Panel {
  readonly #config: PanelConfig;
  #pageName: string;
  #tokens: Tokens;
  #pressed = new Set<string>();
  #timeframe: Timeframe = "DAY";
  #selected = 0;
  #filter = "";
  #deckBrightness = 70;
  /** How many pieces are in the gallery's rotation, scrubbed by the `gallery` dial control. */
  #nftLimit = MAX_GALLERY_NFTS;
  /**
   * The action each key would perform, as of the last frame.
   *
   * Recorded during `build` because that is where the reading is known, and a press arrives later
   * with no state attached. Keyed by slot, so the action always matches the thing on the key rather
   * than whatever the gallery has rotated to since.
   */
  readonly #dynamicActions = new Map<string, string>();
  /**
   * The grid a screen slot was last painted with: the slot it went into, the page it came from, and
   * the key behind each cell.
   *
   * Recorded during `build` for the same reason `#dynamicActions` is — an input arrives later with
   * nothing attached to it — and it is what lets a tap be answered at all. A tap carries pixels;
   * `svg.gridCellAt` turns those into a cell index, and that needs the slot's own dimensions, which
   * only a device ever states. The page name travels with it so a tap landing between a page change
   * and the repaint that follows resolves against nothing rather than against the page it left.
   */
  #grid: { readonly slot: SlotSpec; readonly page: string; readonly keys: readonly KeyConfig[] } | null =
    null;
  /**
   * `url|size` keys currently being fetched by `#pulseArt`, so a piece that stays on screen for
   * several ticks before the network answers gets one request rather than one every second.
   */
  readonly #artWarming = new Set<string>();
  /**
   * Taps taken but not yet turned into a pin, because `handle` is given an input and nothing else.
   *
   * A tap has to be answered against the clock reading it happened under, and the clock arrives
   * through `PanelState` on the next `build` — which the runner performs immediately, because
   * `handle` returns true. Counting rather than flagging is what makes a fast double tap scrub two
   * items forward instead of one: the second tap must not be swallowed by the first.
   */
  #tapAdvances = 0;
  /**
   * The item a tap steered this panel to, and the moment the wall clock gets the page back.
   *
   * `index` is a rotation index, not a list position, so everything downstream — `pulseDetail`, the
   * `nft:N` key source, the strip — keeps taking `state.rotation % list.length` and none of them
   * has to learn that taps exist. Null means this panel is showing exactly what the clock says,
   * which is the state every untouched unit at a desk is in and the reason they agree.
   */
  #tapPin: { readonly index: number; readonly until: number } | null = null;

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

  /** How many pieces are currently in the gallery's rotation. Scrubbed by the `gallery` dial. */
  get nftLimit(): number {
    return this.#nftLimit;
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
   * The page's keys as grid cells, filtered, each still holding the key it came from.
   *
   * A key and a cell are the same thing said for different hardware: a label, an optional reading,
   * whether the thing it controls is currently on, and something to do when it is chosen. Composing
   * them here rather than in an adapter is what stops a screen device having to fetch its own data.
   *
   * The `key` alongside each cell is what makes a filtered page safe to act on. `#selected` indexes
   * the cells a person can actually see, and the page's own key list is longer whenever a filter is
   * narrowing it — so resolving a choice through `page.keys[selected]` runs the wrong key the moment
   * anything has been typed. Nothing on a pulse panel types today; the Cardputer's keyboard does.
   */
  #keyCells(state: PanelState): Array<{ readonly key: KeyConfig; readonly cell: GridCell }> {
    const needle = this.#filter.trim().toLowerCase();
    return this.page.keys
      .map((key) => {
        const reading = key.source === "" ? null : readKeySource(key.source, state);
        return {
          key,
          cell: {
            label: key.label || reading?.label || `Key ${key.index}`,
            value: reading?.value,
            icon: key.icon || undefined,
            tone: reading?.tone ?? key.tone,
            // The one thing a row had no word for, and the reason a grid is worth more than bigger
            // rows: a list of the desktop page could not say that night light is currently on.
            emphasis: actions.resolveActive(key.state, state.desktop, this.#pageName)
              ? ("active" as const)
              : ("ground" as const),
          } satisfies GridCell,
        };
      })
      .filter(({ cell }) => needle === "" || cell.label.toLowerCase().includes(needle));
  }

  /** The page's keys as grid cells, filtered. The shape a screen device is painted from. */
  cells(state: PanelState): GridCell[] {
    return this.#keyCells(state).map(({ cell }) => cell);
  }

  /**
   * The cached large art for a pulse page, warming it in the background when it is missing.
   *
   * `cachedThumbnail` is synchronous and never fetches — `build` cannot await, so the piece a screen
   * device is currently showing would stay art-less forever without something to start the fetch.
   * `prefetch` already warms the small size the Stream Deck's tiles use; this is the same idea at the
   * one size a big screen actually wants, for the one piece it is actually showing right now rather
   * than the whole gallery a strip's filmstrip needs.
   */
  #pulseArt(url: string): string | undefined {
    const size = 400;
    const cached = cachedThumbnail(url, size);
    if (cached !== null) return cached;
    const key = `${size}|${url}`;
    if (!this.#artWarming.has(key)) {
      this.#artWarming.add(key);
      void thumbnail(url, size).finally(() => this.#artWarming.delete(key));
    }
    return undefined;
  }

  /**
   * The rotation the frame is actually painted at: the wall clock, unless a tap has steered it.
   *
   * The clock stays the source. A tap adds an *offset* on top of it and a deadline under it, and
   * the moment the clock catches up with where the tap pushed the page to, the pin is dropped and
   * this panel is once again showing precisely what `Date.now()` says — which is the property the
   * whole rotation design exists for. Several pulse panels on one desk rotate together with no link
   * between them because each one derives the item from a clock they already share; a panel that
   * answered a tap by starting a private counter would never rejoin, and the desk would look
   * broken in a way no single unit could reveal. So the untouched unit's behaviour is unchanged to
   * the millisecond, a touched one is out of step only for as long as someone is looking at it, and
   * the divergence has an expiry rather than a lifetime.
   *
   * Three states, in the order they happen:
   *
   * 1. Held — the clock is overridden outright, so the summoned item cannot be taken away mid-look.
   * 2. Expired but ahead of the clock (only reachable by tapping several times): the pin still wins,
   *    because falling back to the clock here would step *backwards* through the list, which looks
   *    like a fault rather than a rotation.
   * 3. Caught up — the pin is dropped and this panel is an untouched one again.
   *
   * Returns the progress bar's value along with it, because during a hold the bar's claim changes:
   * it means "what you are looking at changes when this fills", and what it is counting toward is
   * the end of the hold rather than the next shared flip.
   */
  #steerRotation(state: PanelState): { rotation: number; progress: number | undefined } {
    const clock = state.rotation ?? 0;
    const now = state.nowMs;
    if (this.#tapAdvances > 0) {
      // From wherever the page is *showing*, not from wherever the clock is: a tap during a hold
      // advances from the held item, which is the only item the person tapping can see.
      const from = this.#tapPin === null ? clock : Math.max(clock, this.#tapPin.index);
      this.#tapPin = { index: from + this.#tapAdvances, until: (now ?? 0) + TAP_HOLD_MS };
      this.#tapAdvances = 0;
    }
    const pin = this.#tapPin;
    if (pin === null) return { rotation: clock, progress: state.rotationProgress };
    // No injected clock means no hold — see `PanelState.nowMs`. The advance still lands, and the
    // clock reclaims the page one window later, which is the sane half of the feature rather than a
    // panel pinned to one piece until it is restarted.
    const remaining = now === undefined ? 0 : pin.until - now;
    if (remaining > 0) return { rotation: pin.index, progress: 1 - remaining / TAP_HOLD_MS };
    if (clock < pin.index) {
      // Parked ahead of the clock with the hold spent. The bar would be counting toward a flip that
      // is more than one window away, and a bar that fills without anything changing is worse than
      // no bar: it is the sync claim in `types.ts` made falsely.
      return { rotation: pin.index, progress: undefined };
    }
    this.#tapPin = null;
    return { rotation: clock, progress: state.rotationProgress };
  }

  /**
   * The portfolio and gallery pages, as a screen device's ambient display rather than a menu.
   *
   * Returns `null` for every other page, which tells `build` to fall back to `rows` — a desktop or
   * chains page is a set of things to choose between, and stays a list. These two are not: one is a
   * number worth glancing at from across a desk, the other is a piece of art worth having up at all,
   * and `renderDetail`'s `artwork` field exists for exactly this.
   */
  pulseDetail(state: PanelState): Surface | null {
    // Every branch below is a page that rotates, and `handle` needs that list to decide whether a
    // tap means anything. Reading the set here rather than keeping a second copy of the four names
    // is what stops the two drifting: a page added below but not to the set renders nothing at all,
    // which is noticed on the first look, unlike a tap that quietly does nothing.
    if (!ROTATING_PAGES.has(this.#pageName)) return null;

    const age =
      state.portfolio === undefined || state.portfolio.detail !== ""
        ? (state.portfolio?.detail ?? "loading…")
        : state.portfolio.ageSeconds === null
          ? "—"
          : `${describeAge(state.portfolio.ageSeconds)}${state.portfolio.stale ? " (stale)" : ""}`;

    if (this.#pageName === "portfolio") {
      const stats = state.portfolio?.stats ?? null;
      const nfts = state.portfolio?.nfts ?? [];
      const piece = nfts.length === 0 ? undefined : nfts[(state.rotation ?? 0) % nfts.length];
      return {
        kind: "detail",
        title: "Portfolio",
        lines: [
          { label: "Total", value: usd(stats?.totalUsd ?? null) },
          { label: "P&L", value: percent(stats?.pnlPercentage ?? null), tone: signTone(stats?.pnlPercentage ?? null) },
          { label: "NFTs", value: state.portfolio?.nftCount === null ? "—" : `${state.portfolio?.nftCount ?? "—"}` },
          { label: "Window", value: (state.timeframe ?? "DAY").toLowerCase() },
        ],
        footer: age,
        artwork: piece === undefined ? undefined : this.#pulseArt(piece.imageUrl),
        syncProgress: nfts.length > 1 ? state.rotationProgress : undefined,
      };
    }

    if (this.#pageName === "gallery") {
      const nfts = state.portfolio?.nfts ?? [];
      const piece = nfts.length === 0 ? undefined : nfts[(state.rotation ?? 0) % nfts.length];
      if (piece === undefined) {
        return {
          kind: "detail",
          title: "Gallery",
          lines: [],
          footer: state.portfolio === undefined || state.portfolio.detail === "" ? "nothing to show" : age,
        };
      }
      return {
        kind: "detail",
        title: piece.name || "Untitled",
        lines: piece.collection === "" ? [] : [{ label: "Collection", value: piece.collection }],
        footer: nfts.length > 1 ? `${nfts.length} pieces in rotation` : undefined,
        artwork: this.#pulseArt(piece.imageUrl),
        syncProgress: nfts.length > 1 ? state.rotationProgress : undefined,
      };
    }

    // Discovery: what is moving, not what is owned. Neither page needs a wallet configured, and
    // both rotate on the same wall-clock formula the gallery does — the whole reason several units
    // at a desk showing the same page settle on the same item at the same time with no coordination
    // between them at all: `rotation` is `Date.now() / ROTATE_MS`, not a per-process counter.
    if (this.#pageName === "tokens") {
      const list = state.discoveryTokens ?? [];
      const item = list.length === 0 ? undefined : list[(state.rotation ?? 0) % list.length];
      if (item === undefined) {
        return { kind: "detail", title: "Trending Tokens", lines: [], footer: "loading…" };
      }
      const change = item.priceChange24h;
      const changeStr = change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
      return {
        kind: "detail",
        title: `${item.name || item.symbol} (${item.symbol})`,
        lines: [
          { label: "Price", value: item.usdPrice === null ? "—" : usd(String(item.usdPrice)) },
          {
            label: "24h",
            value: changeStr,
            tone: change === null || change === 0 ? undefined : change > 0 ? "positive" : "negative",
          },
          { label: "Volume", value: item.volume24h === null ? "—" : usd(String(item.volume24h)) },
          { label: "Chain", value: item.chain },
        ],
        footer: `${list.length} trending`,
        artwork: this.#pulseArt(item.imageUrl),
        syncProgress: list.length > 1 ? state.rotationProgress : undefined,
      };
    }

    if (this.#pageName === "nfts") {
      const list = state.discoveryCollections ?? [];
      const item = list.length === 0 ? undefined : list[(state.rotation ?? 0) % list.length];
      if (item === undefined) {
        return { kind: "detail", title: "Trending NFTs", lines: [], footer: "loading…" };
      }
      return {
        kind: "detail",
        title: item.name || item.slug,
        lines: [],
        footer: `${list.length} trending`,
        artwork: this.#pulseArt(item.imageUrl),
        syncProgress: list.length > 1 ? state.rotationProgress : undefined,
      };
    }

    return null;
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
    // A pin is an answer to "hold *this* item", and the item belonged to the page being left. Kept
    // across a page change it would hand the new page an offset nobody asked for and a hold that
    // freezes a page the person has only just arrived at — a swipe that appears not to have worked.
    this.#tapPin = null;
    this.#tapAdvances = 0;
    return true;
  }

  /** Build the frame for a device, filling only the slots that device actually has. */
  build(device: AnchorDevice, rawState: PanelState): Frame {
    // Two adjustments, both applied once here so that every consumer downstream — `pulseDetail`,
    // the `nft:N` keys, the strip's filmstrip — reads one already-settled state and stays a
    // function of what it is handed.
    //
    // The gallery dial scrubs how many pieces are in rotation, not how many show at once — eight
    // keys show eight keys regardless. Sliced once here so every consumer agrees on the same pool,
    // the same way a filter narrows what `rows` sees. And a tap steers the rotation index itself
    // (`#steerRotation`), which is why nothing below this line knows that taps exist.
    const steered = this.#steerRotation(rawState);
    const state: PanelState = {
      ...rawState,
      rotation: steered.rotation,
      rotationProgress: steered.progress,
      portfolio:
        rawState.portfolio === undefined
          ? undefined
          : { ...rawState.portfolio, nfts: rawState.portfolio.nfts.slice(0, this.#nftLimit) },
    };
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

    // A screen device gets the same page as a grid of tiles, with one exception: `portfolio` and
    // `gallery` are about a number and a piece of art respectively, and a menu of what would have
    // been eight keys reads badly at 368x448 — the gap `docs/devices-esp32.md` names outright. A big
    // portrait panel is not a smaller Stream Deck; it is a display with room to be one, so those
    // pages become `pulseDetail` instead.
    //
    // Everything else is a set of things to choose between, and it was a list of thin rows until the
    // panel it runs on turned out to have a finger on it. A row about a fourteenth of a 448px screen
    // is roughly 2.5mm of target; the grid's cells are 122x149, which is nearer 10mm — the size a
    // thumb actually is. `svg.ts` owns that arithmetic, per rule 1 in `types.ts`.
    for (const slot of device.capabilities.slots) {
      if (!slot.paintable || slot.kind !== "screen") continue;
      const pulse = this.pulseDetail(state);
      if (pulse !== null) {
        // No grid on the glass, so no tap has a cell to land on. Forgetting it here is what keeps a
        // tap on a rotating page from hit-testing against boxes that are no longer drawn.
        this.#grid = null;
        frame.set(slot.id, pulse);
        continue;
      }
      const cells = this.#keyCells(state);
      this.#selected = cells.length === 0 ? 0 : Math.min(this.#selected, cells.length - 1);
      this.#grid = { slot, page: this.#pageName, keys: cells.map(({ key }) => key) };
      frame.set(slot.id, {
        kind: "grid",
        cells: cells.map(({ cell }) => cell),
        selected: cells.length === 0 ? undefined : this.#selected,
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
      const hints = page.dials
        .filter((dial) => dial.label !== "")
        .map((dial) => ({ icon: dial.icon || undefined, label: dial.label }));
      // The gallery is the one page about the art rather than a number, so its strip shows the art:
      // thumbnails of what is actually held, not a sparkline of what it is worth. Every other portfolio
      // page keeps the net-worth wash, and the desktop strip gets neither — a page shows one story
      // behind its readings, not two competing for it.
      const artwork =
        this.#pageName === "gallery"
          ? (state.portfolio?.nfts ?? [])
              .map((piece) => cachedThumbnail(piece.imageUrl))
              .filter((art): art is string => art !== null)
              .slice(0, 8)
          : undefined;
      frame.set(STRIP_SLOT, {
        kind: "bar",
        segments,
        // Only where it means something: the desktop strip has no portfolio behind it.
        background: artwork === undefined ? state.portfolio?.history : undefined,
        artwork: artwork !== undefined && artwork.length > 0 ? artwork : undefined,
        hints: hints.length > 0 ? hints : undefined,
      });
    }

    return frame;
  }

  /**
   * Run what the chosen cell of a screen's grid says to do.
   *
   * Config only — `key.action`, never the action a *source* supplied for whatever the cell happens
   * to be showing. A Stream Deck key press does fall through to that dynamic action, which is how a
   * gallery key opens the piece on it; but a dynamic action is a string built out of marketplace
   * data, which AGENTS.md treats as hostile, and a screen is the surface that can be made to run one
   * by a touch nobody deliberately made. So everything reachable from this glass is a verb a person
   * typed into `panel.json`, and `actions.ts` has no verb that signs, spends or approves anything —
   * invariant 1 holds structurally here rather than by care.
   *
   * Resolved through the grid's own key list rather than `page.keys[index]`, because a filter makes
   * those two different lists.
   */
  #chooseCell(index: number, context: actions.ActionContext): void {
    const key = this.#grid?.keys[index] ?? this.page.keys[index];
    if (key !== undefined && key.action !== "") actions.dispatch(key.action, context);
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
          // On a screen device the chosen cell is the action, and the panel knows which cell that is.
          this.#chooseCell(this.#selected, context);
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
        if (dial.control === "gallery") {
          // Scrubs the rotation pool, not a volume or a brightness, so the step is a count of pieces
          // rather than a percentage.
          const step = dial.step === 0 ? 1 : dial.step;
          this.#nftLimit = Math.min(
            MAX_GALLERY_NFTS,
            Math.max(MIN_GALLERY_NFTS, this.#nftLimit + (input.delta > 0 ? step : -step)),
          );
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
      case "tap": {
        // A tap on a rotating ambient page skips to the next item and holds it there — the one
        // thing a screen with no buttons can offer someone who wants to see the next piece now
        // rather than in five seconds. `#steerRotation` does the work on the next `build`, because
        // that is where the clock this has to be measured against arrives.
        //
        // Only on a screen's own surface. The Stream Deck's touch strip emits taps too
        // (`adapters/streamdeck.ts`), and letting one advance the rotation would jump the eight
        // gallery *keys* beside it — a device where brushing the strip reshuffles the whole face is
        // a worse device, and that behaviour has never been looked at on a review page.
        if (!input.slot.startsWith("screen:")) return false;
        if (ROTATING_PAGES.has(this.#pageName)) {
          this.#tapAdvances++;
          return true;
        }
        // A page of keys answers the obvious gesture instead: open the thing you touched.
        //
        // This used to refuse, and the refusal was right at the time. The panel cannot know where a
        // row was drawn — `types.ts` rule 1 keeps pixel geometry inside the renderer — so the only
        // thing it could have acted on was `#selected`, which would make a sleeve brushing the glass
        // launch whatever happened to be highlighted. That comment named the missing piece: "row
        // hit-testing needs the renderer to report back the boxes it drew". `svg.gridCellAt` is
        // that, and it is the same function `renderGrid` lays the cells out with rather than a
        // second opinion about where they went — a hit test that disagrees with the picture is
        // worse than none, because it is wrong about the one thing the person can see.
        //
        // The brush is still answered, twice over: the gutter between tiles is dead, so a touch
        // between two targets resolves to neither, and what a cell can reach is only what
        // `#chooseCell` allows. Selection moves to the cell first, so the repaint this asks for
        // shows which box was hit — feedback a device with no key travel has no other way to give.
        const grid = this.#grid;
        if (grid === null || grid.slot.id !== input.slot || grid.page !== this.#pageName) return false;
        const hit = gridCellAt(grid.slot, grid.keys.length, this.#selected, input.x, input.y);
        if (hit === null) return false;
        this.#selected = hit;
        this.#chooseCell(hit, context);
        return true;
      }
      default:
        return false;
    }
  }
}
