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
import type { ServiceStatus } from "./state/anchor.ts";
import type { DesktopSnapshot } from "./state/desktop.ts";
import type { Tokens } from "./tokens.ts";
import type { AnchorDevice, BarSegment, DeviceInput, Frame, Surface } from "./types.ts";

export interface PanelState {
  readonly desktop: DesktopSnapshot;
  readonly service: ServiceStatus;
  /** The palette being painted. Defaults to the desktop's theme; pinned by `--theme`. */
  readonly themeName?: string;
}

/** Slot ids the adapters agree on. Kept here so panel and adapter cannot drift apart. */
export const keySlot = (index: number): string => `key:${index}`;
export const dialSlot = (index: number): string => `dial:${index}`;
export const STRIP_SLOT = "strip:0";

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
  memory: ({ desktop }) => (desktop.memory === "" ? "—" : desktop.memory),
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
};

export class Panel {
  readonly #config: PanelConfig;
  #pageName: string;
  #tokens: Tokens;
  #pressed = new Set<string>();

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
      frame.set(id, {
        kind: "tile",
        icon: key.icon || undefined,
        label: key.label || undefined,
        emphasis: this.#pressed.has(id) ? "raised" : active ? "active" : "ground",
        tone: key.tone,
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

    if (slots.has(STRIP_SLOT)) {
      const segments: BarSegment[] = page.segments.map((segment) => ({
        icon: segment.icon || undefined,
        text: (SEGMENT_SOURCES[segment.source] ?? (() => `?${segment.source}`))(state, this.#pageName),
        tone: segment.tone,
      }));
      frame.set(STRIP_SLOT, { kind: "bar", segments });
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
        const key = page.keys.find((k) => keySlot(k.index) === input.slot);
        if (key && key.action !== "") actions.dispatch(key.action, context);
        const dial = page.dials.find((d) => dialSlot(d.index) === input.slot);
        if (dial && dial.press !== "") actions.dispatch(dial.press, context);
        return true;
      }
      case "release":
        this.#pressed.delete(input.slot);
        return true;
      case "rotate": {
        const dial = page.dials.find((d) => dialSlot(d.index) === input.slot);
        if (!dial) return false;
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
      case "tap":
        return false;
      default:
        return false;
    }
  }
}
