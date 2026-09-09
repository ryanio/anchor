/**
 * ESP32 portfolio-pulse adapter — an Anchor device that is on the network rather than on a bus.
 *
 * The Stream Deck is USB-HID: it is present or it is not, and being plugged in *is* the
 * authorisation. An ESP32 display has neither property. It is a small computer on a LAN with a
 * screen glued to it, so this adapter has to answer three questions the HID adapter never asks —
 * who connects to whom, who proves what to whom, and what the display shows when it stops hearing
 * from us. `docs/devices-esp32.md` is the argument; this file is the consequence.
 *
 * **Anchor is the client. The device listens.** AGENTS.md invariant 6 says nothing Anchor runs
 * binds beyond loopback without a reviewed reason, and a frame server on the LAN would be exactly
 * that. Inverting the usual direction keeps the invariant intact and costs nothing: the host opens
 * one TCP connection outward, paints down it, and reads input back up the same socket. The attack
 * surface moves onto the ESP32, where it is one parser that accepts pixels.
 *
 * **The device is authenticated, and it authenticates us.** A pre-shared key from the OS keyring,
 * over TLS-PSK — measured working on this Node with no dependency, and measured to fail with the
 * wrong key. Off loopback a key is required, not encouraged: `checkTransport` refuses to paint a
 * portfolio onto a plaintext LAN socket.
 *
 * **The device never asks for anything.** It has no vocabulary for a signature, a key or an
 * approval — see `esp32-wire.ts`, where the parser refuses every message type but the three a
 * display is allowed to send. What it can emit is a slot id and two numbers, which the panel turns
 * into a page change. `docs/security.md` is explicit that a microcontroller must be assumed
 * extractable on physical possession; this adapter is written as though the thing on the other end
 * is already someone else's.
 */

import { execFile } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
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
 * It belongs next to `keySlot`, `dialSlot` and `STRIP_SLOT` in `panel.ts`, where the ids live so
 * that panel and adapter cannot drift apart. It is here only because `panel.ts` does not yet
 * compose a `screen` slot at all — see the note in `docs/devices-esp32.md` under "What this needs
 * from the shared contract". Move it, do not copy it.
 */
// Re-exported so this adapter's own tests and callers keep their import, but the id itself now
// lives in `panel.ts`: two adapters needed it, and a slot id defined twice gets spelled two ways.
import { SCREEN_SLOT } from "../panel.ts";

export { SCREEN_SLOT };

/** Default port. Chosen next to the data service's 8787 so one number is easy to remember. */
export const DEFAULT_PORT = 8788;

/**
 * Panels this adapter has been designed against.
 *
 * **None of these has been measured here — there is no hardware on this branch.** The dimensions
 * are what the vendors publish, and they are recorded so the arithmetic in the design doc is
 * checkable and so a wrong one is a visible wrong number rather than an assumption. The device
 * reports its own geometry in HELLO and that is what gets painted; this table is documentation and
 * a sanity check, never a source of truth. Same rule as the Stream Deck adapter, which reads
 * `CONTROLS` off the device instead of keeping a table of model constants.
 */
export const PANELS: Readonly<Record<string, { width: number; height: number; note: string }>> = {
  "amoled-466": { width: 466, height: 466, note: "1.43in round AMOLED, QSPI (CO5300-class)" },
  "amoled-536": { width: 240, height: 536, note: "1.91in AMOLED strip, QSPI (RM67162-class)" },
  "lcd-320": { width: 170, height: 320, note: "1.9in IPS LCD, 8-bit parallel (ST7789-class)" },
  "round-240": { width: 240, height: 240, note: "1.28in round IPS LCD, SPI (GC9A01-class)" },
};

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

  onInput(handler: (input: DeviceInput) => void): void {
    this.#inputHandler = handler;
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
    }
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
 * Read a device's pairing key from the OS keyring.
 *
 * Deliberately the same shape as `service/src/keyring.ts` — `execFile`, never a shell, so the value
 * is never subject to word-splitting or shell history, and never an argv anyone can read out of
 * `/proc`. There is no environment-variable escape hatch: unlike an API key this is the only thing
 * standing between a LAN and a live portfolio.
 */
export function pairingKey(deviceName: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      "secret-tool",
      ["lookup", "service", "anchor", "key", `device-${deviceName}`],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          // secret-tool exits non-zero when the item is simply absent.
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value.length > 0 ? Buffer.from(value, "utf8") : null);
      },
    );
  });
}

export interface ConnectOptions extends PulseOptions {
  readonly host: string;
  readonly port?: number;
  /** Keyring entry to use. Defaults to the host, so `anchor-pulse.local` looks up `device-...`. */
  readonly deviceName?: string;
  /** Provided by tests and by anything that has already read the keyring itself. */
  readonly key?: Buffer | null;
  readonly timeoutMs?: number;
}

/**
 * Ciphersuites offered when a pairing key is present.
 *
 * **Measured on Node 26.8.1** over loopback: `tls` negotiates `ECDHE-PSK-CHACHA20-POLY1305` with a
 * matching key, and a mismatched key fails the handshake with an SSL alert rather than connecting.
 * The control was made to fail before it was trusted, per AGENTS.md. `PSK-AES128-GCM-SHA256` was
 * measured working too and is offered second because it is the suite most certain to exist in an
 * ESP-IDF mbedTLS build; which one an actual device negotiates has *not* been measured, because
 * there is no device.
 */
export const PSK_CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305:PSK-AES128-GCM-SHA256";

/** TLS 1.3 moves PSK onto the session-ticket path; the plain PSK suites above are 1.2. */
const PSK_TLS_VERSION = "TLSv1.2" as const;

export const PSK_IDENTITY = "anchor-pulse";

/**
 * Wrap a socket as a `Link`.
 *
 * The handlers are held in one slot each and dispatched from a single listener, so handing the
 * stream from `handshake` to the device replaces the reader rather than adding a second one. Two
 * readers on one socket is not a subtle bug: both accumulate, and the one nobody owns grows for as
 * long as the display is plugged in.
 */
function socketLink(socket: net.Socket, description: string): Link {
  let data: ((chunk: Buffer) => void) | null = null;
  let closed: ((reason: string) => void) | null = null;
  socket.on("data", (chunk: Buffer) => data?.(chunk));
  socket.on("close", () => closed?.("link closed"));
  socket.on("error", (error: Error) => closed?.(error.message));
  return {
    description,
    send: (chunk) =>
      new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    onData: (handler) => {
      data = handler;
    },
    onClose: (handler) => {
      closed = handler;
    },
    close: () => void socket.destroy(),
  };
}

function openSocket(options: ConnectOptions, key: Buffer | null): Promise<net.Socket> {
  const port = options.port ?? DEFAULT_PORT;
  const timeout = options.timeoutMs ?? 5000;
  const socket =
    key === null
      ? net.connect({ host: options.host, port })
      : tls.connect({
          host: options.host,
          port,
          ciphers: PSK_CIPHERS,
          minVersion: PSK_TLS_VERSION,
          maxVersion: PSK_TLS_VERSION,
          // A PSK handshake authenticates both ends by possession of the key; there is no
          // certificate to check and no CA that would mean anything on a desk device.
          checkServerIdentity: () => undefined,
          pskCallback: () => ({ psk: key, identity: PSK_IDENTITY }),
        });
  return new Promise((resolve, reject) => {
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new NoDeviceError(`${options.host}:${port}: timed out connecting`));
    });
    socket.on("error", (error) => reject(new NoDeviceError(`${options.host}:${port}: ${error.message}`)));
    socket.once(key === null ? "connect" : "secureConnect", () => {
      // The connect timeout must not become an idle timeout: a painted display is silent for as
      // long as nothing on the desktop moves, and that is the healthy case.
      socket.setTimeout(0);
      resolve(socket);
    });
  });
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

/**
 * Open a pulse display.
 *
 * Nothing here binds a port. The host is the client, the device is the server, and the only socket
 * this process owns is an outbound one — which is what keeps AGENTS.md invariant 6 true of a device
 * that is, unavoidably, on a network.
 */
export async function open(tokens: Tokens, options: ConnectOptions): Promise<Esp32PulseDevice> {
  const key = options.key === undefined ? await pairingKey(options.deviceName ?? options.host) : options.key;
  checkTransport(options.host, key !== null);
  const socket = await openSocket(options, key);
  const link = socketLink(socket, `${options.host}:${options.port ?? DEFAULT_PORT}`);
  return attach(link, tokens, options, options.timeoutMs ?? 5000);
}
