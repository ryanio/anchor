/**
 * A device with no hardware behind it.
 *
 * Two jobs. It lets the panel be rendered and reviewed on a machine with nothing plugged in — CI,
 * or a laptop away from the desk — which matters because AGENTS.md forbids shipping a visual change
 * you have only reasoned about, and hardware cannot be screenshotted. And it is the second
 * implementation of `AnchorDevice`, which is what keeps the contract honest: an interface with one
 * implementation is just that implementation's shape written twice.
 *
 * Geometries are declared rather than probed. These are the published panel layouts; the Stream
 * Deck + entry is the one measured against real hardware here (8 keys at 120x120, an 800x100 strip,
 * 4 encoders with no display).
 */

import { dialSlot, keySlot, STRIP_SLOT } from "../panel.ts";
import type { AnchorDevice, DeviceCapabilities, DeviceInput, Frame, SlotSpec } from "../types.ts";

export interface Geometry {
  readonly keys: number;
  readonly keyWidth: number;
  readonly keyHeight: number;
  readonly columns: number;
  readonly encoders: number;
  readonly strip: { readonly width: number; readonly height: number } | null;
}

export const GEOMETRIES: Readonly<Record<string, Geometry>> = {
  plus: {
    keys: 8,
    keyWidth: 120,
    keyHeight: 120,
    columns: 4,
    encoders: 4,
    strip: { width: 800, height: 100 },
  },
  original: { keys: 15, keyWidth: 72, keyHeight: 72, columns: 5, encoders: 0, strip: null },
  mini: { keys: 6, keyWidth: 80, keyHeight: 80, columns: 3, encoders: 0, strip: null },
  xl: { keys: 32, keyWidth: 96, keyHeight: 96, columns: 8, encoders: 0, strip: null },
};

export function capabilitiesFor(geometry: Geometry): DeviceCapabilities {
  const slots: SlotSpec[] = [];
  for (let index = 0; index < geometry.keys; index++) {
    slots.push({
      id: keySlot(index),
      kind: "key",
      paintable: true,
      width: geometry.keyWidth,
      height: geometry.keyHeight,
    });
  }
  for (let index = 0; index < geometry.encoders; index++) {
    slots.push({ id: dialSlot(index), kind: "encoder", paintable: false, width: 0, height: 0 });
  }
  if (geometry.strip !== null) {
    slots.push({
      id: STRIP_SLOT,
      kind: "strip",
      paintable: true,
      width: geometry.strip.width,
      height: geometry.strip.height,
    });
  }
  return { slots, inputs: ["press", "release", "rotate", "tap", "swipe"] };
}

/** Records what it was asked to paint instead of painting it. */
export class VirtualDevice implements AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  readonly frames: Frame[] = [];
  brightness = 0;

  constructor(geometry: Geometry, id = "virtual") {
    this.id = id;
    this.capabilities = capabilitiesFor(geometry);
  }

  async paint(frame: Frame): Promise<void> {
    this.frames.push(frame);
  }

  blanked = false;

  async setBrightness(percent: number): Promise<void> {
    this.brightness = percent;
  }

  async setBlanked(blanked: boolean): Promise<void> {
    this.blanked = blanked;
  }

  onInput(_handler: (input: DeviceInput) => void): void {
    // Nothing generates input without hardware; kept so the contract is satisfied in full.
  }

  async close(): Promise<void> {}
}
