/**
 * Elgato Stream Deck adapter.
 *
 * Everything device-specific lives here: HID, buffer formats, and Elgato's control model. The panel
 * above it sees slots and surfaces.
 *
 * Capabilities are read from the device rather than hard-coded per model. `@elgato-stream-deck/node`
 * v7 reports a `CONTROLS` array — buttons with their own pixel sizes, an LCD segment, encoders —
 * so a Stream Deck Mini or XL works through this same file without a table of model constants.
 *
 * **Measured on a Stream Deck + (fw 2.0.3.5):** 8 buttons at 120x120, one 800x100 LCD segment with
 * draw regions, 4 encoders with no LED ring. `fillKeyBuffer` and `fillLcdRegion` take raw pixels,
 * and a 120x120 key is exactly 43,200 bytes of RGB — a short buffer paints garbage, which is why
 * `raster.ts` refuses to return one.
 */

import { listStreamDecks, openStreamDeck, type StreamDeck } from "@elgato-stream-deck/node";
import { dialSlot, keySlot, STRIP_SLOT } from "../panel.ts";
import { rasterize } from "../raster.ts";
import { toSvg } from "../svg.ts";
import type { Tokens } from "../tokens.ts";
import type { AnchorDevice, DeviceCapabilities, DeviceInput, Frame, SlotSpec } from "../types.ts";

export class NoDeviceError extends Error {}

function buildCapabilities(deck: StreamDeck): DeviceCapabilities {
  const slots: SlotSpec[] = [];
  const inputs = new Set<DeviceInput["kind"]>();

  for (const control of deck.CONTROLS) {
    if (control.type === "button") {
      // Not every button is a screen. The Pedal and Neo report buttons with `feedbackType: "none"`,
      // and those definitions carry no `pixelSize` at all — narrowing on the feedback type is what
      // keeps this adapter honest about which of them can be painted.
      const drawable = control.feedbackType === "lcd";
      slots.push({
        id: keySlot(control.index),
        kind: "key",
        paintable: drawable,
        width: drawable ? control.pixelSize.width : 0,
        height: drawable ? control.pixelSize.height : 0,
      });
      inputs.add("press");
      inputs.add("release");
    } else if (control.type === "encoder") {
      slots.push({
        id: dialSlot(control.index),
        kind: "encoder",
        // The Plus has no per-encoder display; models with LED rings still are not a raster target.
        paintable: false,
        width: 0,
        height: 0,
      });
      inputs.add("rotate");
      inputs.add("press");
      inputs.add("release");
    } else if (control.type === "lcd-segment") {
      slots.push({
        id: STRIP_SLOT,
        kind: "strip",
        paintable: true,
        width: control.pixelSize.width,
        height: control.pixelSize.height,
      });
      inputs.add("tap");
      inputs.add("swipe");
    }
  }

  return { slots, inputs: [...inputs] };
}

export class StreamDeckDevice implements AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  readonly #deck: StreamDeck;
  #tokens: Tokens;
  /** Last SVG painted per slot, so an unchanged tile costs neither a rasterise nor a USB write. */
  readonly #painted = new Map<string, string>();

  constructor(deck: StreamDeck, tokens: Tokens, id: string) {
    this.#deck = deck;
    this.#tokens = tokens;
    this.id = id;
    this.capabilities = buildCapabilities(deck);
  }

  set tokens(next: Tokens) {
    this.#tokens = next;
    // A theme change invalidates every face; forget what was painted so the next frame redraws all.
    this.#painted.clear();
  }

  async paint(frame: Frame): Promise<void> {
    for (const slot of this.capabilities.slots) {
      if (!slot.paintable) continue;
      const surface = frame.get(slot.id);
      if (surface === undefined) continue;

      const svg = toSvg(surface, this.#tokens, slot);
      if (this.#painted.get(slot.id) === svg) continue;

      const buffer = await rasterize(svg, { width: slot.width, height: slot.height });
      if (slot.kind === "strip") {
        await this.#deck.fillLcdRegion(0, 0, 0, buffer, {
          format: "rgb",
          width: slot.width,
          height: slot.height,
        });
      } else {
        const index = Number.parseInt(slot.id.slice(slot.id.indexOf(":") + 1), 10);
        await this.#deck.fillKeyBuffer(index, buffer, { format: "rgb" });
      }
      this.#painted.set(slot.id, svg);
    }
  }

  #brightness = 70;

  async setBrightness(percent: number): Promise<void> {
    this.#brightness = Math.min(100, Math.max(0, Math.round(percent)));
    await this.#deck.setBrightness(this.#brightness);
  }

  /**
   * Blank the panel when the session locks, and restore it when it unlocks.
   *
   * Both are done: the keys are cleared *and* the backlight is taken to zero. Brightness alone
   * leaves the image on the LCDs, faintly readable in a dark room and fully readable to a phone
   * camera; clearing alone leaves a lit blank panel that looks broken. The painted-face cache is
   * dropped so the first frame after unlocking redraws everything.
   */
  async setBlanked(blanked: boolean): Promise<void> {
    if (blanked) {
      await this.#deck.clearPanel();
      this.#painted.clear();
      await this.#deck.setBrightness(0);
      return;
    }
    await this.#deck.setBrightness(this.#brightness);
  }

  onInput(handler: (input: DeviceInput) => void): void {
    this.#deck.on("down", (control) => {
      handler({
        kind: "press",
        slot: control.type === "encoder" ? dialSlot(control.index) : keySlot(control.index),
      });
    });
    this.#deck.on("up", (control) => {
      handler({
        kind: "release",
        slot: control.type === "encoder" ? dialSlot(control.index) : keySlot(control.index),
      });
    });
    this.#deck.on("rotate", (control, amount) => {
      handler({ kind: "rotate", slot: dialSlot(control.index), delta: amount });
    });
    this.#deck.on("lcdShortPress", (_control, position) => {
      handler({ kind: "tap", slot: STRIP_SLOT, x: position.x, y: position.y });
    });
    this.#deck.on("lcdSwipe", (_control, from, to) => {
      handler({ kind: "swipe", slot: STRIP_SLOT, from: from.x, to: to.x });
    });
    this.#deck.on("error", () => {
      /* surfaced by the CLI's exit handling; a transient HID error must not throw here */
    });
  }

  async close(): Promise<void> {
    try {
      await this.#deck.clearPanel();
    } catch {
      // Closing a device that has already gone away is not an error worth reporting.
    }
    await this.#deck.close();
  }
}

/** Open the first attached Stream Deck, or the one at `path`. */
export async function open(tokens: Tokens, path?: string): Promise<StreamDeckDevice> {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new NoDeviceError(
      "no Stream Deck found. Check it is plugged in, and that you can read /dev/hidraw* — on Omarchy " +
        "logind grants that to the logged-in user automatically.",
    );
  }
  const chosen = path === undefined ? devices[0] : devices.find((d) => d.path === path);
  if (chosen === undefined) throw new NoDeviceError(`no Stream Deck at ${path}`);
  const deck = await openStreamDeck(chosen.path);
  return new StreamDeckDevice(deck, tokens, chosen.serialNumber ?? chosen.path);
}
