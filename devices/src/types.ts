/**
 * The device contract every Anchor device implements.
 *
 * The Stream Deck is the first of these, but it is deliberately not the shape of the interface. An
 * ESP32 pulse display has one screen and no input; a Cardputer has a screen and a keyboard; the
 * Stream Deck has eight keys, four encoders and a touch strip. What they share is that Anchor paints
 * *surfaces* into named *slots* and receives *inputs* back, so the panel logic never learns which
 * device it is driving.
 *
 * Two rules keep this honest as the family grows:
 *
 * 1. **Nothing here knows a pixel size at a call site.** A slot declares its own dimensions and the
 *    renderer asks. A panel that hard-codes 120x120 is a panel that cannot move to the next device.
 * 2. **No device signs anything.** Devices render state and emit intent. Whether an intent is
 *    allowed is decided by the executor, off the device, per invariant 1 in AGENTS.md. This file
 *    intentionally has no vocabulary for a signature, a key, or an approval.
 */

/** What a slot can show. Sizes are in device pixels and come from the device itself. */
export type SlotKind = "key" | "strip" | "screen" | "encoder";

/**
 * A named region of a device.
 *
 * `paintable` is not redundant with `kind`. The Stream Deck + has four encoders that report turns
 * and presses but have no display of their own, while other Elgato models put an LCD ring around
 * theirs. Both are encoders; only one can be drawn on. Painting is gated on this flag so a panel
 * never rasterises a frame that has nowhere to go.
 */
export interface SlotSpec {
  readonly id: string;
  readonly kind: SlotKind;
  readonly paintable: boolean;
  readonly width: number;
  readonly height: number;
}

/** What a device can report. A device omits what it does not have. */
export type InputKind = "press" | "release" | "rotate" | "tap" | "swipe" | "text";

export interface DeviceCapabilities {
  readonly slots: readonly SlotSpec[];
  readonly inputs: readonly InputKind[];
}

export type DeviceInput =
  | { readonly kind: "press"; readonly slot: string }
  | { readonly kind: "release"; readonly slot: string }
  | { readonly kind: "rotate"; readonly slot: string; readonly delta: number }
  | { readonly kind: "tap"; readonly slot: string; readonly x: number; readonly y: number }
  | { readonly kind: "swipe"; readonly slot: string; readonly from: number; readonly to: number }
  /**
   * Committed text, from a device with a keyboard.
   *
   * Committed rather than per-keystroke: a stream of keystrokes invites dispatching on each one,
   * and the only legitimate use of text here is narrowing what is already on screen. It is a
   * filter, never a command, never an address or an amount, and nothing evaluates it.
   */
  | { readonly kind: "text"; readonly slot: string; readonly value: string };

/**
 * Visual weight, named after the design system's three surfaces rather than after colours.
 * `theme/README.md` principle 5: depth instead of dividers.
 */
export type Emphasis = "ground" | "raised" | "active";

/** Semantic colour roles. Never a literal colour — see `tokens.ts`. */
export type TokenName =
  | "ground"
  | "raised"
  | "sunken"
  | "ink"
  | "inkDim"
  | "inkStrong"
  | "accent"
  | "positive"
  | "negative"
  | "warning"
  | "line";

export interface BarSegment {
  /** A Nerd Font glyph, given as a code point so config files stay ASCII. */
  readonly icon?: string;
  readonly text: string;
  readonly tone?: TokenName;
  /**
   * Characters to reserve, so a changing reading does not move its neighbours.
   *
   * A status strip is read at a glance, and the eye finds a value by where it sits. Packing
   * segments by their current width means `cpu 5%` ticking to `cpu 14%` shifts everything to its
   * right by one character — every second, forever. Reserving the width a reading can grow to keeps
   * each one in place; the text itself is not padded, only the space after it.
   */
  readonly minChars?: number;
}

/**
 * A medium-neutral description of what to show. The Stream Deck rasterises these to RGB; a future
 * ESP32 adapter can send the same surface over the wire and draw it with its own primitives.
 */
/** One row of a list surface. */
export interface ListRow {
  readonly label: string;
  readonly value?: string;
  readonly icon?: string;
  readonly tone?: TokenName;
}

/** One labelled line of a detail surface. */
export interface DetailLine {
  readonly label: string;
  readonly value: string;
  readonly tone?: TokenName;
}

export type Surface =
  | {
      readonly kind: "tile";
      readonly icon?: string;
      readonly label?: string;
      /**
       * A reading, shown large with the label demoted to a caption beneath it.
       *
       * This is what turns a key from a button into a display. It matters more than it looks:
       * the deck often sits on a machine nobody is in front of, so a key that only says what it
       * *does* wastes the surface — the useful thing is what it currently *is*.
       */
      readonly value?: string;
      readonly emphasis: Emphasis;
      readonly tone?: TokenName;
      /** 0..1 draws a fill bar under the label; omit for a plain tile. */
      readonly meter?: number;
      readonly badge?: string;
      /**
       * A series drawn as a sparkline beneath the reading.
       *
       * A number says where you are; a sparkline says how you got there, in the same space. Values
       * are raw — the renderer scales to the series' own range, because a portfolio that moved 2%
       * should look like a 2% move against itself, not a flat line against zero.
       */
      readonly spark?: readonly number[];
      /** Proportions drawn as a donut. Values are relative; the renderer normalises them. */
      readonly slices?: readonly { readonly value: number; readonly tone?: TokenName }[];
    }
  | { readonly kind: "bar"; readonly segments: readonly BarSegment[] }
  /**
   * Rows on a screen.
   *
   * The same page that becomes a grid of keys on a Stream Deck becomes this on a device that has
   * one screen instead of eight buttons. That is the claim of this layer made concrete: the panel
   * composes it, so no adapter has to fetch its own data in order to draw a list.
   *
   * `selected` belongs to the panel rather than the device, because only the panel knows how many
   * rows there are once a filter has been applied.
   */
  | {
      readonly kind: "list";
      readonly rows: readonly ListRow[];
      readonly selected?: number;
      /** Shown when there are no rows. An empty list must say why it is empty. */
      readonly empty?: string;
    }
  /**
   * One thing, in full. Separate from `list` because the layouts differ, and a vocabulary with one
   * name for two layouts stops being enforceable.
   */
  | {
      readonly kind: "detail";
      readonly title: string;
      readonly lines: readonly DetailLine[];
      /**
       * Never truncated. Where a card has to say that approval happens somewhere else, this is the
       * line that says it, and a truncated one would be worse than none at all.
       */
      readonly footer?: string;
      readonly badge?: string;
    };

/** One paint: the surfaces to show, keyed by slot id. Slots left out keep what they had. */
export type Frame = ReadonlyMap<string, Surface>;

export interface AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  paint(frame: Frame): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  /**
   * Blank or restore the display.
   *
   * Optional, because a device only ever driven while someone is present does not need it. A desk
   * display does: it sits in a room the user has walked out of, and a panel still showing a
   * portfolio after the session locks is a security property rather than a nicety.
   */
  setBlanked?(blanked: boolean): Promise<void>;
  onInput(handler: (input: DeviceInput) => void): void;
  close(): Promise<void>;
}
