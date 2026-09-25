/**
 * The one path from the panel to the glass.
 *
 * Everything in the daemon that wants a fresh frame asks this for one: the tick, a service poll, a
 * fetch landing, a Hyprland event, a key press, a reconnect. Repaints are coalesced, so one frame is
 * in flight at a time and any number of requests made during it become one more frame after it.
 *
 * It also holds the lock state. A locked session gets no frames at all, because on the ESP32 a
 * COMMIT restores the configured backlight and on the Cardputer a frame is drawn at backlight 0, so
 * one stray repaint puts a portfolio back on a desk the owner has walked away from. Keeping the
 * check here rather than at each caller is the point: there are six callers and more will come.
 */

import type { AnchorDevice, Frame } from "./types.ts";

export class Painter {
  readonly #device: () => AnchorDevice;
  readonly #compose: () => Promise<Frame>;
  readonly #onError: (error: unknown) => void;
  #painting = false;
  #queued = false;
  #blanked = false;
  #inFlight: Promise<void> = Promise.resolve();

  /**
   * `device` is a getter because a reconnect replaces the device. `compose` builds the frame and may
   * do I/O. `onError` hears about a frame that failed to compose or paint; the painter carries on.
   */
  constructor(device: () => AnchorDevice, compose: () => Promise<Frame>, onError: (error: unknown) => void) {
    this.#device = device;
    this.#compose = compose;
    this.#onError = onError;
  }

  /**
   * Lock or unlock. Only a change does anything; unlocking paints one fresh frame.
   *
   * Locking waits for a frame already on its way. Its COMMIT would otherwise land after the BLANK
   * and light the panel straight back up.
   */
  async setBlanked(locked: boolean): Promise<void> {
    if (locked === this.#blanked) return;
    this.#blanked = locked;
    if (locked) await this.#inFlight;
    await this.#device().setBlanked?.(locked);
    if (!locked) await this.repaint();
  }

  async repaint(): Promise<void> {
    if (this.#blanked) return;
    if (this.#painting) {
      this.#queued = true;
      return;
    }
    this.#painting = true;
    this.#inFlight = this.#paintOnce();
    try {
      await this.#inFlight;
    } finally {
      this.#painting = false;
      if (this.#queued) {
        this.#queued = false;
        void this.repaint();
      }
    }
  }

  async #paintOnce(): Promise<void> {
    try {
      const frame = await this.#compose();
      await this.#device().paint(frame);
    } catch (error) {
      this.#onError(error);
    }
  }
}
