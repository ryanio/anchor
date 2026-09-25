/**
 * ESP32 portfolio-pulse adapter — an Anchor device that is on the network rather than on a bus.
 *
 * The Stream Deck is USB-HID: it is present or it is not, and being plugged in *is* the
 * authorisation. An ESP32 display has neither property. It is a small computer on a LAN with a
 * screen glued to it, so this adapter has to answer three questions the HID adapter never asks —
 * who connects to whom, who proves what to whom, and what the display shows when it stops hearing
 * from us. `docs/devices-esp32.md` is the argument; this file is the consequence.
 *
 * **This file opens no socket and binds no port.** It paints down whatever `Link` it is handed:
 * `esp32-serial.ts` supplies a USB CDC port, and tests and `--dry-run` supply a `MemoryLink`.
 * `checkTransport` holds the rule a network link would have to meet: off loopback, a pairing key is
 * required before a portfolio goes on the wire.
 *
 * **The device never asks for anything.** It has no vocabulary for a signature, a key or an
 * approval — see `esp32-wire.ts`, where the parser refuses every message type but the three a
 * display is allowed to send. What it can emit is a slot id and two numbers, which the panel turns
 * into a page change. `docs/security.md` is explicit that a microcontroller must be assumed
 * extractable on physical possession; this adapter is written as though the thing on the other end
 * is already someone else's.
 */

import { rasterize } from "../raster.ts";
import { toSvg } from "../svg.ts";
import type { Tokens } from "../tokens.ts";
import type { AnchorDevice, DeviceCapabilities, DeviceInput, Frame, SlotSpec } from "../types.ts";
import {
  cropRgb565,
  decodeMessages,
  dirtyTiles,
  encodeBlank,
  encodeBrightness,
  encodeCommit,
  encodePing,
  encodeReady,
  encodeRle16,
  encodeTile,
  type Hello,
  HOST_BOUND_TYPES,
  MessageType,
  PROTOCOL_VERSION,
  type Rect,
  rgb888ToRgb565,
  splitRect,
  TileEncoding,
  WireError,
} from "./esp32-wire.ts";

export class NoDeviceError extends Error {}
export class PairingError extends Error {}

/**
 * The one slot an ESP32 pulse display has.
 *
 * The id lives in `panel.ts`, next to `keySlot`, `dialSlot` and `STRIP_SLOT`, and is imported here
 * rather than declared. That was not always true: this adapter defined it, and `Panel.build()` had
 * no branch for `kind: "screen"` at all, so a device whose only slot was a screen received an empty
 * frame. Both are fixed — the panel composes a screen slot as a `list`, and the constant moved
 * rather than being copied, because a slot id defined in two places gets spelled two ways.
 *
 * Re-exported so this adapter's own tests and callers keep their import.
 */
import { SCREEN_SLOT } from "../panel.ts";

export { SCREEN_SLOT };

export function capabilitiesFor(hello: Hello): DeviceCapabilities {
  const slot: SlotSpec = {
    id: SCREEN_SLOT,
    kind: "screen",
    paintable: true,
    width: hello.width,
    height: hello.height,
  };
  return { slots: [slot], inputs: hello.inputs };
}

/**
 * A byte pipe to a device.
 *
 * The transport is an interface rather than a socket so the whole adapter runs with no hardware and
 * no network — the same reason `virtual.ts` exists. An interface with one implementation is that
 * implementation's shape written twice, and the one that would go untested here is the one that
 * carries a quarter of a megabyte of someone's portfolio.
 */
export interface Link {
  /** For log lines and errors. Never a secret. */
  readonly description: string;
  send(chunk: Buffer): Promise<void>;
  /** Replaces the previous handler. The handshake hands the stream over to the device this way. */
  onData(handler: (chunk: Buffer) => void): void;
  /** Replaces the previous handler. */
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** A link with no socket behind it: what tests and `--dry-run` talk to. */
export class MemoryLink implements Link {
  readonly description = "memory";
  /** Everything the host has written, in order. */
  readonly sent: Buffer[] = [];
  closed = false;
  #data: ((chunk: Buffer) => void) | null = null;
  #close: ((reason: string) => void) | null = null;

  async send(chunk: Buffer): Promise<void> {
    if (this.closed) throw new WireError("write to a closed link");
    this.sent.push(Buffer.from(chunk));
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.#data = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#close = handler;
  }

  close(): void {
    this.closed = true;
    this.#close?.("closed");
  }

  /** Stand in for the device: push bytes up the link as though they had arrived. */
  receive(chunk: Buffer): void {
    this.#data?.(chunk);
  }

  /** Everything the host sent, concatenated — convenient for a decoder in a test. */
  written(): Buffer {
    return Buffer.concat(this.sent);
  }
}

export interface PulseOptions {
  /** 0-100. Sent in READY so the panel is never brighter than the desk wants on first paint. */
  readonly brightness?: number;
  /** How often the host promises to speak when nothing changes. */
  readonly keepaliveMs?: number;
  /** After this much silence the device must stop presenting the frame as current. */
  readonly staleAfterMs?: number;
  /** Dirty-rect grid. Smaller finds tighter rectangles and costs more comparisons. */
  readonly tileSize?: number;
}

const DEFAULTS = { brightness: 70, keepaliveMs: 2000, staleAfterMs: 6000, tileSize: 32 } as const;

/**
 * An ESP32 pulse display, driven over a `Link`.
 *
 * Paint is: render the surface to SVG exactly as every other Anchor device does, rasterise it once,
 * reduce it to the panel's RGB565, then send only the rectangles that changed. The first three
 * steps are shared with the Stream Deck deliberately — the whole argument for sending pixels rather
 * than a drawing model is that the desk's second screen must be the same design system as the
 * first, wearing the same Omarchy theme and the same fontconfig monospace, with nothing to keep in
 * sync but a byte count.
 */
export class Esp32PulseDevice implements AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  readonly #link: Link;
  readonly #hello: Hello;
  readonly #options: Required<PulseOptions>;
  #tokens: Tokens;
  /** The last full panel, in the device's own pixel format. `null` means "it has nothing". */
  #frame: Buffer | null = null;
  #seq = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #inputHandler: ((input: DeviceInput) => void) | null = null;
  #pongHandler: ((seq: number) => void) | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(link: Link, hello: Hello, tokens: Tokens, options: PulseOptions = {}) {
    this.#link = link;
    this.#hello = hello;
    this.#tokens = tokens;
    this.#options = { ...DEFAULTS, ...options };
    this.id = `esp32:${hello.deviceId}`;
    this.capabilities = capabilitiesFor(hello);

    link.onData((chunk) => this.#ingest(chunk));
    link.onClose(() => {
      this.#closed = true;
      if (this.#keepalive !== null) clearInterval(this.#keepalive);
      // A dropped link means the device is now showing a frame nobody is maintaining. Forgetting
      // it here is what makes the next connection repaint in full rather than diff against a panel
      // that has since gone dark.
      this.#frame = null;
    });
  }

  set tokens(next: Tokens) {
    this.#tokens = next;
    // A theme change invalidates every pixel; forget the frame so the next paint is a full one.
    this.#frame = null;
  }

  get panel(): { width: number; height: number } {
    return { width: this.#hello.width, height: this.#hello.height };
  }

  #next(): number {
    this.#seq = (this.#seq + 1) & 0xffff;
    return this.#seq;
  }

  /** Send READY and start the keepalive. Called by `attach`; separate so a test can drive it. */
  async begin(): Promise<void> {
    await this.#link.send(
      encodeReady(this.#next(), {
        version: PROTOCOL_VERSION,
        brightness: this.#options.brightness,
        keepaliveMs: this.#options.keepaliveMs,
        staleAfterMs: this.#options.staleAfterMs,
      }),
    );
    this.#keepalive = setInterval(() => {
      if (this.#closed) return;
      void this.#link.send(encodePing(this.#next())).catch(() => {
        /* the close handler is the one that reports a dead link */
      });
    }, this.#options.keepaliveMs);
    this.#keepalive.unref?.();
  }

  async paint(frame: Frame): Promise<void> {
    const slot = this.capabilities.slots[0];
    if (slot === undefined || !slot.paintable) return;
    const surface = frame.get(slot.id);
    if (surface === undefined) return;

    const rgb = await rasterize(toSvg(surface, this.#tokens, slot), {
      width: slot.width,
      height: slot.height,
    });
    const pixels = rgb888ToRgb565(rgb, this.#hello.format);
    const changed = dirtyTiles(this.#frame, pixels, slot, this.#options.tileSize);
    this.#frame = pixels;
    // Nothing moved: no header, no radio, no wake. An idle pulse display costs the network nothing,
    // which is the same promise the Stream Deck adapter makes about USB.
    if (changed.length === 0) return;

    for (const rect of changed) {
      for (const piece of splitRect(rect, this.#hello.maxTileBytes)) {
        await this.#link.send(this.#tileMessage(pixels, slot.width, piece));
      }
    }
    // One Commit after all of them, so a number never renders half-updated. It is money on that
    // screen; a torn frame is a wrong reading, not a cosmetic glitch.
    await this.#link.send(encodeCommit(this.#next()));
  }

  #tileMessage(frame: Buffer, frameWidth: number, rect: Rect): Buffer {
    const raw = cropRgb565(frame, frameWidth, rect);
    const packed = encodeRle16(raw);
    // Send whichever is smaller. Flat surfaces collapse; a photographic tile would not, and paying
    // a compression penalty on it would be the encoder lying about its own value.
    return packed.length < raw.length
      ? encodeTile(this.#next(), rect, TileEncoding.Rle16, packed)
      : encodeTile(this.#next(), rect, TileEncoding.Raw, raw);
  }

  async setBrightness(percent: number): Promise<void> {
    await this.#link.send(encodeBrightness(this.#next(), percent));
  }

  /**
   * Clear the panel and forget the frame.
   *
   * This is not a convenience. `docs/security.md` says the idle screensaver must never display
   * private wallet data while the desktop is locked, and a portfolio on a desk display is that rule
   * with the screensaver removed — the display does not know the session locked unless the host
   * says so. Wiring this to the lock signal is the caller's job; see the design doc.
   */
  async blank(): Promise<void> {
    this.#frame = null;
    await this.#link.send(encodeBlank(this.#next()));
  }

  /**
   * The shared contract's lock hook, which the Stream Deck adapter also implements.
   *
   * `blank()` is the primitive and stays public because the wire has a message for exactly it; this
   * is the name `AnchorDevice` uses, so whatever subscribes to logind's `LockedHint` can treat every
   * device the same way instead of knowing which ones have a bespoke method.
   *
   * Unblanking repaints rather than restoring: the frame was dropped when the panel went dark, so
   * the next `paint` diffs against nothing and sends the whole thing. Restoring brightness over a
   * framebuffer the device no longer has would light up a stale portfolio, which is the exact
   * reading `docs/security.md` says must not appear.
   */
  async setBlanked(blanked: boolean): Promise<void> {
    if (blanked) {
      await this.blank();
      return;
    }
    this.#frame = null;
    await this.setBrightness(this.#options.brightness);
  }

  onInput(handler: (input: DeviceInput) => void): void {
    this.#inputHandler = handler;
  }

  /**
   * Send a PING and return its sequence number.
   *
   * The keepalive already does this on a timer and throws the answer away, which is right for
   * liveness. This exists because a PONG is the only acknowledgement in the protocol that a device
   * has *finished* with everything sent before it: the stream is ordered, so a reply to a ping
   * issued after a COMMIT cannot arrive until that frame has been decoded and presented.
   *
   * That makes a ping the instrument for the one number the whole design rests on — what a frame
   * actually costs end to end. `docs/devices-esp32.md` says outright that if a full frame on real
   * hardware costs more than a few hundred milliseconds, shipping pixels was the wrong call. There
   * was no way to measure it from the host before this.
   */
  async ping(): Promise<number> {
    const seq = this.#next();
    await this.#link.send(encodePing(seq));
    return seq;
  }

  /** Called with the sequence number of each PONG. Replaces the previous handler. */
  onPong(handler: (seq: number) => void): void {
    this.#pongHandler = handler;
  }

  #ingest(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let decoded: ReturnType<typeof decodeMessages>;
    try {
      decoded = decodeMessages(this.#buffer, HOST_BOUND_TYPES);
    } catch {
      // A device talking nonsense is a device to hang up on, not one to resynchronise with. There
      // is nothing it can say that is worth recovering a stream for.
      this.#buffer = Buffer.alloc(0);
      this.#link.close();
      return;
    }
    this.#buffer = decoded.rest;
    for (const parsed of decoded.messages) {
      if (parsed.type === MessageType.Input) this.#inputHandler?.(parsed.input);
      else if (parsed.type === MessageType.Pong) this.#pongHandler?.(parsed.seq);
      else if (parsed.type === MessageType.Hello) void this.#resync();
    }
  }

  /**
   * The device threw its picture away and said so. Repaint it in full.
   *
   * A HELLO mid-session is not a greeting, it is the one way this protocol has of saying "I am no
   * longer showing what you think I am showing": the firmware only announces itself while it has no
   * session, which it reaches by blanking on silence past `staleAfterMs * 4`, by a momentary drop of
   * the USB CDC connection, or by rejecting something and starting over.
   *
   * Until now the host decoded that message and dropped it. `#frame` — the host's belief about what
   * is on the glass — survived, so the next `paint` diffed against a panel that had since gone black
   * and sent only the handful of tiles that happened to differ. The result is a dark screen carrying
   * a sliver of sync bar at the top, a sliver of footer at the bottom, and one lit square wherever a
   * reading had changed: precisely what was reported from the desk, and for a week read as a display
   * fault. Every other instrument agreed, correctly, that the hardware was fine — the panel, the
   * PSRAM, the blit and the decoder were all doing exactly as told. The lie was in the host's memory.
   *
   * Forgetting the frame is what makes the next paint whole, and READY goes with it because the
   * device left its session when it blanked: without one it would sit outside a session, announcing
   * itself every 500ms, and drop every input the glass produced.
   */
  async #resync(): Promise<void> {
    if (this.#closed) return;
    this.#frame = null;
    await this.#link
      .send(
        encodeReady(this.#next(), {
          version: PROTOCOL_VERSION,
          brightness: this.#options.brightness,
          keepaliveMs: this.#options.keepaliveMs,
          staleAfterMs: this.#options.staleAfterMs,
        }),
      )
      .catch(() => {
        /* the close handler is the one that reports a dead link */
      });
  }

  async close(): Promise<void> {
    if (this.#keepalive !== null) clearInterval(this.#keepalive);
    this.#closed = true;
    try {
      await this.#link.send(encodeBlank(this.#next()));
    } catch {
      // Closing a device that has already gone away is not an error worth reporting.
    }
    this.#link.close();
  }
}

/* ------------------------------------------------------------------------- connecting ---------- */

/**
 * Addresses that never leave the machine.
 *
 * Matching an IPv4 literal in 127/8 rather than a `127.` prefix, because `127.example.com` is a
 * hostname somebody else controls and the first version of this function called it loopback — which
 * would have waved a LAN device straight past the pairing-key requirement in `checkTransport`. The
 * test that found it is the one that asks the control to fail.
 */
export function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets?.slice(1).every((octet) => Number(octet) <= 255) === true;
}

/**
 * Refuse a transport that would put a portfolio on the wire in the clear.
 *
 * Loopback is allowed unencrypted — that is the `--dry-run`, emulator and CI path, and it never
 * leaves the machine. Anything else needs a pairing key, and the error says how to store one rather
 * than leaving a user to discover that a display is silently unprotected. This is a function, not a
 * comment, because a rule that is only written down is a rule that gets skipped once.
 */
export function checkTransport(host: string, hasKey: boolean): void {
  if (hasKey || isLoopback(host)) return;
  throw new PairingError(
    `refusing to paint ${host} without a pairing key: an Anchor surface carries wallet data and a ` +
      "LAN socket is not private. Store one with `secret-tool store --label='Anchor device key' " +
      "service anchor key device-<name>`, or point at 127.0.0.1 for a local emulator.",
  );
}

/**
 * Wait for the device to introduce itself.
 *
 * The device speaks first, and until it has, the host knows nothing about the panel — not its size,
 * not its byte order, not what it can report. That is the same discipline as the Stream Deck
 * adapter reading `CONTROLS`: capabilities are asked for, never assumed from a model name.
 *
 * A device must not speak again until READY: anything it packs into the same segment behind its
 * HELLO is parsed here and then dropped when the stream is handed to the device object. That is a
 * firmware rule rather than a host limitation, and it is stated in the design doc so the firmware
 * author does not have to discover it from a missing first touch.
 */
export function handshake(link: Link, timeoutMs = 5000): Promise<Hello> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      reject(new NoDeviceError(`${link.description}: connected but sent no hello within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    link.onClose((reason) => {
      clearTimeout(timer);
      reject(new NoDeviceError(`${link.description}: ${reason} before hello`));
    });
    link.onData((chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded: ReturnType<typeof decodeMessages>;
      try {
        decoded = decodeMessages(buffer, HOST_BOUND_TYPES);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      buffer = decoded.rest;
      for (const parsed of decoded.messages) {
        if (parsed.type !== MessageType.Hello) continue;
        clearTimeout(timer);
        if (parsed.hello.version !== PROTOCOL_VERSION) {
          reject(
            new NoDeviceError(
              `${link.description}: speaks protocol ${parsed.hello.version}, this host speaks ${PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        resolve(parsed.hello);
        return;
      }
    });
  });
}

/** Build a device on an already-open link: handshake, send READY, return it painted-ready. */
export async function attach(
  link: Link,
  tokens: Tokens,
  options: PulseOptions = {},
  timeoutMs = 5000,
): Promise<Esp32PulseDevice> {
  const hello = await handshake(link, timeoutMs);
  const device = new Esp32PulseDevice(link, hello, tokens, options);
  await device.begin();
  return device;
}
