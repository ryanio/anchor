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
export type InputKind = "press" | "release" | "rotate" | "tap" | "swipe";

export interface DeviceCapabilities {
  readonly slots: readonly SlotSpec[];
  readonly inputs: readonly InputKind[];
}

export type DeviceInput =
  | { readonly kind: "press"; readonly slot: string }
  | { readonly kind: "release"; readonly slot: string }
  | { readonly kind: "rotate"; readonly slot: string; readonly delta: number }
  | { readonly kind: "tap"; readonly slot: string; readonly x: number; readonly y: number }
  | { readonly kind: "swipe"; readonly slot: string; readonly from: number; readonly to: number };

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
}

/**
 * A medium-neutral description of what to show. The Stream Deck rasterises these to RGB; a future
 * ESP32 adapter can send the same surface over the wire and draw it with its own primitives.
 */
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
    }
  | { readonly kind: "bar"; readonly segments: readonly BarSegment[] };

/** One paint: the surfaces to show, keyed by slot id. Slots left out keep what they had. */
export type Frame = ReadonlyMap<string, Surface>;

export interface AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  paint(frame: Frame): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  onInput(handler: (input: DeviceInput) => void): void;
  close(): Promise<void>;
}
