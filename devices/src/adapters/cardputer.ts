/**
 * M5Stack Cardputer adapter — scaffold.
 *
 * The Cardputer is the third shape in the device family and the first one that is *typed at*. It is
 * an ESP32-S3 with a 240x135 TFT, a 56-key keyboard and a battery. The argument behind this file is
 * `docs/devices-cardputer.md`; what follows is the seam.
 *
 * Three decisions are worth knowing before reading the code.
 *
 * **The transport is a USB cable, not the network.** `service/src/server.ts` binds 127.0.0.1 and
 * says so in its first line: never the LAN, never the tailnet. A Wi-Fi Cardputer would need
 * something to bind beyond loopback, which AGENTS.md invariant 6 makes a human decision rather than
 * an implementation detail. USB keeps the Cardputer exactly as trusted as the Stream Deck — a thing
 * on the end of a cable — and costs no new listener.
 *
 * **The wire carries surfaces, not pixels.** `types.ts` anticipates this: "a future ESP32 adapter
 * can send the same surface over the wire and draw it with its own primitives." A nine-tile frame is
 * a few hundred bytes of JSON against 64,800 bytes for a 240x135 RGB565 framebuffer, which matters
 * on a battery. The palette travels with it, so the firmware never holds a colour of its own either
 * — `theme/README.md` principle 8 survives the cable.
 *
 * **Nothing here can approve anything, and the reason is structural rather than careful.**
 * `DeviceInput` has no vocabulary for a signature, a key or an approval, so there is no message this
 * adapter could construct that means "yes". The service it reads through is read-only and refuses
 * non-GET before routing. The proposal queue is *rendered* here and approved somewhere this file
 * cannot reach — see "Where the boundary sits" in the design doc.
 *
 * **Unverified against hardware.** Nothing below has been run against a Cardputer; none is attached.
 * The geometry, the USB identifiers and the `stty` incantation come from vendor documentation, and
 * each is flagged where it is used. AGENTS.md is emphatic that a plausible reading is not a measured
 * one, so this file claims only what its tests actually exercise — the encoding, the decoding, the
 * key mapping and the refusals, all of which run with nothing plugged in.
 */

import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { keySlot, STRIP_SLOT } from "../panel.ts";
import type { Tokens } from "../tokens.ts";
import type {
  AnchorDevice,
  DeviceCapabilities,
  DeviceInput,
  Frame,
  SlotSpec,
  Surface,
  TokenName,
} from "../types.ts";

export class NoCardputerError extends Error {}
export class LinkError extends Error {}

/** Bumped when a message shape changes incompatibly. The firmware refuses a proto it cannot read. */
export const PROTOCOL_VERSION = 1;

/** A device could stream forever; a line longer than this is a fault, not a message. */
const MAX_LINE_BYTES = 4096;

/** A filter box, not a command line. 64 characters is more than a collection name needs. */
export const MAX_QUERY_LENGTH = 64;

// ----------------------------------------------------------------------------------------------
// Geometry
// ----------------------------------------------------------------------------------------------

export interface CardputerGeometry {
  readonly width: number;
  readonly height: number;
  /** Height of the status bar across the top; the rest is the tile grid. */
  readonly status: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Cardputer v1.1: a 1.14" ST7789 at 240x135 (**from M5Stack's documentation, not measured**).
 *
 * Three columns and three rows is not an arbitrary carve-up. It is the largest grid whose tiles
 * still carry a legible label at this size, and — more usefully — it makes the *existing* panel
 * config render on this device with no new vocabulary at all: nine keys, the number row selects
 * them, and the strip becomes the status bar. The list and detail surfaces the design doc asks for
 * are a contract change, and this scaffold deliberately does not fake them.
 */
export const CARDPUTER_V11: CardputerGeometry = {
  width: 240,
  height: 135,
  status: 24,
  columns: 3,
  rows: 3,
};

/**
 * The area flint leaves to an app.
 *
 * flint (`ryanio/cardputer`) is the firmware this adapter actually drives, and its view loop owns
 * the bottom 12 rows of the panel: a status bar naming the source, the radio and the battery. An
 * app paints the 123 rows above it and nowhere else, so the host's layout has to stop where flint's
 * begins rather than assuming the whole 240x135.
 *
 * 18 rows of status strip and three rows of 80x35 tiles tile that area exactly, which a test
 * asserts, because a slot that runs one pixel long is a slot that paints over somebody else's bar.
 */
export const CARDPUTER_FLINT: CardputerGeometry = {
  width: 240,
  height: 123,
  status: 18,
  columns: 3,
  rows: 3,
};

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function tileSize(geometry: CardputerGeometry): { width: number; height: number } {
  return {
    width: Math.floor(geometry.width / geometry.columns),
    height: Math.floor((geometry.height - geometry.status) / geometry.rows),
  };
}

/**
 * Where each slot lives on the panel.
 *
 * The device owns this, not the panel: rule 1 in `types.ts` is that nothing knows a pixel size at a
 * call site. A slot declares its dimensions through `SlotSpec`; this map is how those dimensions
 * become a position on one shared framebuffer, which is the part a Stream Deck never needs because
 * its keys are physically separate screens.
 */
export function slotRects(geometry: CardputerGeometry): ReadonlyMap<string, Rect> {
  const { width, height } = tileSize(geometry);
  const rects = new Map<string, Rect>();
  rects.set(STRIP_SLOT, { x: 0, y: 0, w: geometry.width, h: geometry.status });
  for (let index = 0; index < geometry.columns * geometry.rows; index++) {
    rects.set(keySlot(index), {
      x: (index % geometry.columns) * width,
      y: geometry.status + Math.floor(index / geometry.columns) * height,
      w: width,
      h: height,
    });
  }
  return rects;
}

/**
 * What the Cardputer has, and — as much to the point — what it does not.
 *
 * No `rotate`: there is no encoder. No `tap`: the screen is not a touchscreen. `swipe` is declared
 * even though nothing on the device swipes, because this adapter synthesises one from the Tab key,
 * and an input kind a device emits belongs in its capabilities whatever generated it. The panel
 * already pages on a swipe, so Tab costs no contract change to express.
 */
export function capabilitiesFor(geometry: CardputerGeometry): DeviceCapabilities {
  const { width, height } = tileSize(geometry);
  const slots: SlotSpec[] = [
    { id: STRIP_SLOT, kind: "strip", paintable: true, width: geometry.width, height: geometry.status },
  ];
  for (let index = 0; index < geometry.columns * geometry.rows; index++) {
    slots.push({ id: keySlot(index), kind: "key", paintable: true, width, height });
  }
  return { slots, inputs: ["press", "release", "swipe"] };
}

// ----------------------------------------------------------------------------------------------
// Wire protocol
// ----------------------------------------------------------------------------------------------

export interface PaintOp extends Rect {
  readonly id: string;
  /** The keyboard cursor is on this slot. Device-local focus, not panel state — see `moveCursor`. */
  readonly sel?: true;
  readonly s: Surface;
}

export type HostMessage =
  | { readonly t: "hello"; readonly proto: number }
  | {
      readonly t: "theme";
      readonly name: string;
      readonly dark: boolean;
      readonly tokens: Readonly<Record<TokenName, string>>;
    }
  | { readonly t: "frame"; readonly ops: readonly PaintOp[] }
  | { readonly t: "query"; readonly active: boolean; readonly text: string }
  | { readonly t: "backlight"; readonly percent: number }
  | { readonly t: "ping" }
  | { readonly t: "clear" };

export type DeviceMessage =
  | {
      readonly t: "hello";
      readonly proto: number;
      readonly fw: string;
      readonly width: number;
      readonly height: number;
    }
  /** `key` is either a single character or one of `NAMED_KEYS`; the lengths disambiguate them. */
  | { readonly t: "key"; readonly key: string; readonly down: boolean; readonly shift: boolean }
  | { readonly t: "power"; readonly percent: number; readonly charging: boolean };

/**
 * Newline-delimited JSON.
 *
 * The framing is safe because `JSON.stringify` escapes every newline it could emit, so a message can
 * never contain the byte that ends it — including one built from a marketplace collection name,
 * which AGENTS.md treats as hostile data. That is the reason NDJSON is defensible here rather than
 * merely convenient.
 */
export function serialize(message: HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The palette the firmware is given, written so it cannot drift from the token vocabulary.
 *
 * `Record<TokenName, true>` is exhaustive: adding a token to the union and forgetting it here is a
 * type error rather than a colour that silently stops arriving on the device.
 */
const PALETTE: Readonly<Record<TokenName, true>> = {
  ground: true,
  raised: true,
  sunken: true,
  ink: true,
  inkDim: true,
  inkStrong: true,
  accent: true,
  positive: true,
  negative: true,
  warning: true,
  line: true,
};

/** Every colour the device will ever draw, resolved from the live Omarchy theme. */
export function encodeTheme(tokens: Tokens): HostMessage {
  const palette = {} as Record<TokenName, string>;
  for (const name of Object.keys(PALETTE) as TokenName[]) palette[name] = tokens[name];
  return { t: "theme", name: tokens.themeName, dark: tokens.dark, tokens: palette };
}

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
  "enter",
  "esc",
  "tab",
  "backspace",
]);

/**
 * One code point, and nothing from the control, format or surrogate categories.
 *
 * A keyboard is untrusted input like any other. A device reporting an escape sequence as a "key" is
 * reporting a fault, and letting it through would put terminal control bytes into a string this
 * process later writes to its own stderr.
 */
function isPrintable(key: string): boolean {
  return [...key].length === 1 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(key);
}

/**
 * Parse one line from the device, or return null.
 *
 * Everything arriving here is untrusted: a USB device on a desk can be unplugged and replaced by
 * something else that speaks the same protocol. So this validates rather than trusts, and a message
 * it does not fully understand is dropped rather than partially believed. Note what it *cannot*
 * produce however hostile the input — `DeviceMessage` has no member that asks for an action, and the
 * mapping below turns a key only into a slot the panel config already declares.
 */
export function decodeDeviceMessage(line: string): DeviceMessage | null {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;

  if (message.t === "hello") {
    const { proto, fw, width, height } = message;
    if (typeof proto !== "number" || typeof fw !== "string") return null;
    if (typeof width !== "number" || typeof height !== "number") return null;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    return { t: "hello", proto, fw, width, height };
  }

  if (message.t === "key") {
    const { key, down, shift } = message;
    if (typeof key !== "string" || typeof down !== "boolean") return null;
    if (!NAMED_KEYS.has(key) && !isPrintable(key)) return null;
    return { t: "key", key, down, shift: shift === true };
  }

  if (message.t === "power") {
    const { percent, charging } = message;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
    return {
      t: "power",
      percent: Math.min(100, Math.max(0, Math.round(percent))),
      charging: charging === true,
    };
  }

  return null;
}

// ----------------------------------------------------------------------------------------------
// Power
// ----------------------------------------------------------------------------------------------

export interface PowerState {
  readonly percent: number;
  readonly charging: boolean;
}

/**
 * Backlight for a given charge.
 *
 * Dimming on battery is ordinary. The rule that is not ordinary is the floor: the screen never goes
 * dark while it is still showing readings, because a black panel and a panel showing an hour-old
 * floor price look identical from a desk and one of them is a lie. `theme/README.md` principle 6 is
 * the same argument from the other side — provenance belongs beside the number, which means the
 * number has to stay legible enough to have provenance.
 */
export function backlightFor(configured: number, power: PowerState | null): number {
  const wanted = Math.min(100, Math.max(0, Math.round(configured)));
  if (power === null || power.charging) return wanted;
  if (power.percent <= 10) return Math.max(15, Math.round(wanted * 0.35));
  if (power.percent <= 30) return Math.max(20, Math.round(wanted * 0.6));
  return wanted;
}

// ----------------------------------------------------------------------------------------------
// Link
// ----------------------------------------------------------------------------------------------

/** A byte pipe to the device. Injected so every test here runs with nothing plugged in. */
export interface CardputerLink {
  write(line: string): Promise<void>;
  onLine(handler: (line: string) => void): void;
  close(): Promise<void>;
}

/** A link with no hardware behind it: it records what it was told and replays what it is given. */
export class MemoryLink implements CardputerLink {
  readonly written: string[] = [];
  closed = false;
  #handler: ((line: string) => void) | null = null;

  async write(line: string): Promise<void> {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.#handler = handler;
  }

  /** Pretend the device said this. */
  receive(message: unknown): void {
    this.#handler?.(typeof message === "string" ? message : JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** The decoded host messages sent so far, which is what a test actually wants to assert on. */
  sent(): HostMessage[] {
    return this.written.map((line) => JSON.parse(line) as HostMessage);
  }
}

const BY_ID = "/dev/serial/by-id";

/**
 * Serial ports that look like a Cardputer.
 *
 * The ESP32-S3 in the Cardputer's StampS3 exposes USB natively, so it enumerates through Espressif's
 * own JTAG/serial descriptor rather than a CP210x or CH340 bridge. **Unverified:** the name
 * fragments below come from Espressif's documented USB descriptors, not from a device seen on this
 * machine, and listing ports against real hardware is the first thing to run when one exists.
 */
export function listPorts(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(BY_ID);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /espressif|m5stack|usb_jtag|cardputer/i.test(name))
    .map((name) => join(BY_ID, name))
    .sort();
}

/**
 * A link over a USB CDC serial port.
 *
 * No dependency: the port is a character device, so `fs` streams read and write it, and the one
 * thing `fs` cannot do — put the line discipline into raw mode — is delegated to `stty`, which is
 * coreutils and therefore already present. That is the same trade `raster.ts` makes with
 * ImageMagick, and it is why this adapter adds nothing to `package.json`.
 *
 * **Unverified against hardware.** Two things to check the first time a Cardputer is attached: that
 * `stty raw` alone is enough (CDC ACM ignores the baud rate, so 115200 is a formality), and whether
 * opening the port without `O_NOCTTY` — which `createReadStream` cannot pass — matters for a process
 * with no controlling terminal. If it does, that is the one honest case for a dependency here; the
 * design doc says what it would be.
 */
export function openSerial(path: string): CardputerLink {
  try {
    execFileSync("stty", ["-F", path, "raw", "-echo", "115200"], { stdio: "ignore", timeout: 5000 });
  } catch (error) {
    throw new LinkError(
      `could not put ${path} into raw mode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const input = createReadStream(path, { encoding: "utf8" });
  const output = createWriteStream(path);
  let buffer = "";
  let handler: ((line: string) => void) | null = null;

  input.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    // A device that never sends a newline must not grow this without bound.
    if (buffer.length > MAX_LINE_BYTES) buffer = buffer.slice(-MAX_LINE_BYTES);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") handler?.(line);
      index = buffer.indexOf("\n");
    }
  });
  input.on("error", () => {
    /* an unplugged device is not an exception; the firmware notices when frames stop arriving */
  });
  output.on("error", () => {
    /* the same the other way: writing to a device that has gone must not take the process down */
  });

  // A whole line in one `write()` call is not a whole line delivered: measured on this machine, a
  // message past a couple hundred bytes (the theme, any real frame) is dropped far more often than
  // it arrives, while a short one (hello, ~24 bytes) usually gets through. `output.write()`'s
  // callback fires once Node hands the bytes to the kernel, not once the CDC-ACM bulk transfer
  // actually lands, and the firmware's serial RX buffer does not keep up with a multi-hundred-byte
  // burst arriving faster than `cable::tick()` drains it — the excess is silently dropped by the
  // driver, `cable::readLine()` never sees a terminator, and the line is gone with no error on
  // either end. Chunking to a size a USB full-speed packet does not have to split, with a short
  // pause between chunks for the firmware's main loop to drain what arrived, fixed it: measured
  // against a real Cardputer, a 1.4KB frame now lands every time it did not before.
  const CHUNK_BYTES = 64;
  const CHUNK_DELAY_MS = 8;
  return {
    write: async (line) => {
      for (let i = 0; i < line.length; i += CHUNK_BYTES) {
        const chunk = line.slice(i, i + CHUNK_BYTES);
        await new Promise<void>((resolve) => output.write(chunk, () => resolve()));
        if (i + CHUNK_BYTES < line.length) await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
      }
    },
    onLine: (next) => {
      handler = next;
    },
    close: async () => {
      input.destroy();
      await new Promise<void>((resolve) => output.end(resolve));
    },
  };
}

// ----------------------------------------------------------------------------------------------
// The device
// ----------------------------------------------------------------------------------------------

/**
 * What the keyboard is currently for.
 *
 * `navigate` moves a cursor and presses keys; `filter` collects text. They are separate modes rather
 * than a modifier because of the property that matters: **while text is being typed, no keystroke
 * reaches the panel at all.** A filter box that can also fire a key action is a filter box that can
 * dispatch an action by accident, and on a device whose job is showing proposals that is exactly the
 * accident to make unreachable.
 */
export type KeyboardMode = "navigate" | "filter";

export class CardputerDevice implements AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  readonly geometry: CardputerGeometry;

  readonly #link: CardputerLink;
  readonly #rects: ReadonlyMap<string, Rect>;
  readonly #keySlots: readonly string[];
  /** Last surface handed to us per slot, so a cursor move can repaint without a new frame. */
  readonly #surfaces = new Map<string, Surface>();
  /** Signature of what is actually on the glass, so an unchanged tile costs no bytes. */
  readonly #painted = new Map<string, string>();

  #tokens: Tokens;
  #cursor = 0;
  #mode: KeyboardMode = "navigate";
  #query = "";
  #power: PowerState | null = null;
  #firmware = "";
  #brightness = 0;
  #pressed: string | null = null;

  #blanked = false;

  #input: ((input: DeviceInput) => void) | null = null;
  #queryHandler: ((text: string) => void) | null = null;
  #powerHandler: ((power: PowerState) => void) | null = null;
  /** Resolved by the device's `hello`. Empty except while something is waiting for one. */
  readonly #helloWaiters = new Set<() => void>();

  constructor(link: CardputerLink, tokens: Tokens, id = "cardputer", geometry = CARDPUTER_V11) {
    this.#link = link;
    this.#tokens = tokens;
    this.id = id;
    this.geometry = geometry;
    this.capabilities = capabilitiesFor(geometry);
    this.#rects = slotRects(geometry);
    this.#keySlots = this.capabilities.slots.filter((slot) => slot.kind === "key").map((slot) => slot.id);
    link.onLine((line) => this.#receive(line));
  }

  // -- state a host can read, beyond the contract ----------------------------------------------

  /** The reported firmware version, or "" until the device has said hello. */
  get firmware(): string {
    return this.#firmware;
  }

  get power(): PowerState | null {
    return this.#power;
  }

  get mode(): KeyboardMode {
    return this.#mode;
  }

  /** The current filter text. Never an action, never evaluated — see `onQuery`. */
  get query(): string {
    return this.#query;
  }

  get selectedSlot(): string {
    return this.#keySlots[this.#cursor] ?? "";
  }

  get tokens(): Tokens {
    return this.#tokens;
  }

  /**
   * A theme change invalidates every face, exactly as on the Stream Deck — and here it also has to
   * reach the device, because the firmware holds the palette rather than the pixels.
   */
  set tokens(next: Tokens) {
    this.#tokens = next;
    this.#painted.clear();
    void this.#send(encodeTheme(next));
  }

  /** Announce ourselves and hand over the palette. Safe to call again on reconnect. */
  async greet(): Promise<void> {
    await this.#send({ t: "hello", proto: PROTOCOL_VERSION });
    await this.#send(encodeTheme(this.#tokens));
  }

  /**
   * Called when the user commits a filter.
   *
   * This is the seam the shared contract does not have yet. `DeviceInput` cannot carry text, so a
   * typed string has nowhere to go through `onInput`; it is surfaced here instead, and the design doc
   * asks for a `text` input kind so this can stop being a side channel. What it is emphatically not
   * is a command — the string narrows what is already on screen, and nothing dispatches it.
   */
  /**
   * Wait for the device to identify itself.
   *
   * An ESP32-S3 with native USB enumerates through Espressif's own JTAG/serial descriptor whatever
   * is running on it, so a port that *looks* like a Cardputer is a guess and nothing more. A
   * handshake is the only honest identification: the firmware answers `hello` with its version and
   * the panel size it actually has. `--cardputer` with no path uses this rather than believing the
   * descriptor, which is the difference between finding a device and finding a port.
   */
  async waitForHello(timeoutMs = 2000): Promise<boolean> {
    if (this.#firmware !== "") return true;
    return await new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#helloWaiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#helloWaiters.delete(done);
        resolve(false);
      }, timeoutMs);
      // A pending identification must not be the reason a process stays alive.
      timer.unref?.();
      this.#helloWaiters.add(done);
    });
  }

  /**
   * Liveness, every five seconds.
   *
   * The adapter deliberately writes nothing when no slot has changed, which on a battery is the
   * point — but silence and a dead host look identical from the device, and the firmware treats
   * fifteen seconds of it as a lost link. A ping is the cheapest thing that tells the difference.
   */
  async ping(): Promise<void> {
    await this.#send({ t: "ping" });
  }

  onQuery(handler: (text: string) => void): void {
    this.#queryHandler = handler;
  }

  onPower(handler: (power: PowerState) => void): void {
    this.#powerHandler = handler;
  }

  // -- AnchorDevice ----------------------------------------------------------------------------

  async paint(frame: Frame): Promise<void> {
    const touched: string[] = [];
    for (const slot of this.capabilities.slots) {
      if (!slot.paintable) continue;
      const surface = frame.get(slot.id);
      if (surface === undefined) continue;
      this.#surfaces.set(slot.id, surface);
      touched.push(slot.id);
    }
    await this.#sendSlots(touched);
  }

  async setBrightness(percent: number): Promise<void> {
    this.#brightness = Math.min(100, Math.max(0, Math.round(percent)));
    await this.#send({ t: "backlight", percent: backlightFor(this.#brightness, this.#power) });
  }

  /**
   * Blank on session lock, and restore on unlock.
   *
   * A Cardputer is a desk display: it sits in a room its owner has walked out of, so a panel still
   * showing a portfolio after the screen locks is a security property rather than a nicety. The
   * backlight alone is not enough — at zero the image is still faintly readable in a dark room and
   * fully readable to a phone camera — so the frame is cleared as well, which is why unblanking has
   * to repaint every slot rather than diff against a screen that no longer holds anything.
   */
  async setBlanked(blanked: boolean): Promise<void> {
    if (blanked === this.#blanked) return;
    this.#blanked = blanked;
    if (blanked) {
      await this.#send({ t: "clear" });
      await this.#send({ t: "backlight", percent: 0 });
      this.#painted.clear();
      return;
    }
    await this.#send({ t: "backlight", percent: backlightFor(this.#brightness, this.#power) });
    await this.#sendSlots([...this.#surfaces.keys()]);
  }

  onInput(handler: (input: DeviceInput) => void): void {
    this.#input = handler;
  }

  async close(): Promise<void> {
    try {
      await this.#send({ t: "clear" });
    } catch {
      // Clearing a device that has already gone away is not an error worth reporting.
    }
    await this.#link.close();
  }

  // -- keyboard --------------------------------------------------------------------------------

  /**
   * Move the keyboard cursor.
   *
   * Deliberately emits no `DeviceInput`. A cursor is device-local focus — the Stream Deck does not
   * report a finger hovering over a key either — and the panel has no concept of one, so inventing an
   * input kind to announce it would push device state into shared logic for no gain. The cursor does
   * have to be *seen*, which is why this repaints from the cached surfaces rather than waiting for
   * the host's next frame.
   */
  moveCursor(dx: number, dy: number): void {
    const { columns } = this.geometry;
    const previous = this.selectedSlot;
    const rows = Math.ceil(this.#keySlots.length / columns);
    const column = Math.min(columns - 1, Math.max(0, (this.#cursor % columns) + dx));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(this.#cursor / columns) + dy));
    // Clamped, never wrapped: a grid cursor that teleports from the last tile to the first is how
    // someone presses the wrong thing.
    this.#cursor = Math.min(this.#keySlots.length - 1, Math.max(0, row * columns + column));
    if (this.selectedSlot !== previous) void this.#sendSlots([previous, this.selectedSlot]);
  }

  selectIndex(index: number): void {
    if (index < 0 || index >= this.#keySlots.length) return;
    const previous = this.selectedSlot;
    this.#cursor = index;
    if (this.selectedSlot !== previous) void this.#sendSlots([previous, this.selectedSlot]);
  }

  /**
   * One keystroke.
   *
   * Public rather than private because it is the part worth testing hardest: this is the whole of
   * what a keyboard can cause. Every branch either moves a cursor, presses a slot the panel config
   * already declares, pages, or edits a string. No branch reaches a wallet, and no branch turns typed
   * text into an action.
   */
  handleKey(key: string, down: boolean, shift = false): void {
    if (this.#mode === "filter") {
      this.#handleFilterKey(key, down);
      return;
    }
    if (key === "enter") {
      this.#pressSlot(this.selectedSlot, down);
      return;
    }
    if (!down) {
      // A release of anything else. If a key is still held, let it go: a lost release would leave a
      // tile stuck in its pressed emphasis for good.
      if (this.#pressed !== null) this.#pressSlot(this.#pressed, false);
      return;
    }
    const CURSOR: Readonly<Record<string, readonly [number, number]>> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    const step = CURSOR[key];
    if (step !== undefined) {
      this.moveCursor(step[0], step[1]);
      return;
    }
    if (key === "tab") {
      // The panel already pages on a swipe, so Tab becomes one. Reusing an existing input kind is
      // the difference between a new device and a new contract.
      this.#emit({ kind: "swipe", slot: STRIP_SLOT, from: 0, to: shift ? -1 : 1 });
      return;
    }
    if (key === "/") {
      this.#setMode("filter");
      return;
    }
    if (key >= "1" && key <= "9") {
      const index = Number.parseInt(key, 10) - 1;
      if (index < this.#keySlots.length) {
        this.selectIndex(index);
        this.#pressSlot(this.selectedSlot, true);
      }
    }
  }

  #handleFilterKey(key: string, down: boolean): void {
    if (!down) return;
    if (key === "esc") {
      this.#query = "";
      this.#setMode("navigate");
      this.#queryHandler?.("");
      return;
    }
    if (key === "enter") {
      this.#setMode("navigate");
      this.#queryHandler?.(this.#query);
      return;
    }
    if (key === "backspace") {
      this.#query = [...this.#query].slice(0, -1).join("");
      void this.#send({ t: "query", active: true, text: this.#query });
      return;
    }
    // Arrows and Tab do nothing mid-word, so a stray keystroke cannot page the panel out from under
    // whatever is being typed.
    if (NAMED_KEYS.has(key) || !isPrintable(key)) return;
    if ([...this.#query].length >= MAX_QUERY_LENGTH) return;
    this.#query += key;
    void this.#send({ t: "query", active: true, text: this.#query });
  }

  #setMode(mode: KeyboardMode): void {
    this.#mode = mode;
    void this.#send({ t: "query", active: mode === "filter", text: this.#query });
  }

  #pressSlot(slot: string, down: boolean): void {
    if (slot === "") return;
    if (down) {
      this.#pressed = slot;
      this.#emit({ kind: "press", slot });
    } else {
      this.#pressed = null;
      this.#emit({ kind: "release", slot });
    }
  }

  #emit(input: DeviceInput): void {
    this.#input?.(input);
  }

  // -- plumbing --------------------------------------------------------------------------------

  #receive(line: string): void {
    const message = decodeDeviceMessage(line);
    if (message === null) return;
    if (message.t === "hello") {
      this.#firmware = message.fw;
      // A device says hello when it boots, and the firmware repeats it while it has no host. Either
      // way the glass may be showing nothing at all, so every slot is dirty: diffing against a
      // screen that has been through a reset is how a rebooted device stays blank for good.
      this.#painted.clear();
      for (const waiter of [...this.#helloWaiters]) waiter();
      // A single write over this link is not a delivered write — `fs.createWriteStream`'s callback
      // fires once Node hands the bytes to the kernel, not once the CDC-ACM bulk transfer actually
      // lands, and measured on this machine a write immediately after opening the port is dropped
      // more often than not. The device repeating its hello every HELLO_MS while unlinked is a
      // retry signal already arriving for free; answering it turns a single lucky write into a
      // self-healing loop bounded by that heartbeat, and it costs nothing once truly linked because
      // the device stops sending it the moment a message of ours actually lands.
      void this.greet();
      return;
    }
    if (message.t === "key") {
      this.handleKey(message.key, message.down, message.shift);
      return;
    }
    this.#power = { percent: message.percent, charging: message.charging };
    this.#powerHandler?.(this.#power);
    void this.#send({ t: "backlight", percent: backlightFor(this.#brightness, this.#power) });
  }

  async #sendSlots(ids: readonly string[]): Promise<void> {
    const ops: PaintOp[] = [];
    for (const id of ids) {
      const surface = this.#surfaces.get(id);
      const rect = this.#rects.get(id);
      if (surface === undefined || rect === undefined) continue;
      const selected = id === this.selectedSlot;
      const signature = `${selected ? "*" : "-"}${JSON.stringify(surface)}`;
      if (this.#painted.get(id) === signature) continue;
      ops.push(selected ? { id, ...rect, sel: true, s: surface } : { id, ...rect, s: surface });
      this.#painted.set(id, signature);
    }
    // An idle panel writes nothing at all, which on a battery-powered device is the point.
    if (ops.length > 0) await this.#send({ t: "frame", ops });
  }

  async #send(message: HostMessage): Promise<void> {
    await this.#link.write(serialize(message));
  }
}

/**
 * Open the first attached Cardputer, or the one at `path`.
 *
 * Mirrors `streamdeck.open`. The greeting is sent immediately so a device that was already running
 * re-syncs its palette; nothing waits for a reply by default, because a device that never says hello
 * should still show the panel rather than a blank screen.
 *
 * `confirmMs` is for the case where the port was *guessed* rather than named. Every ESP32-S3 with
 * native USB enumerates through the same Espressif JTAG/serial descriptor whatever is running on it,
 * so picking a port by name identifies a chip family and not a device. When a path was not given,
 * the caller should insist on a `hello` before painting: writing a frame to whatever else happens to
 * be on the bus is rude at best, and reading a blank screen as a working panel is worse.
 */
export async function open(
  tokens: Tokens,
  path?: string,
  { confirmMs = 0, geometry = CARDPUTER_FLINT }: { confirmMs?: number; geometry?: CardputerGeometry } = {},
): Promise<CardputerDevice> {
  const chosen = path ?? listPorts()[0];
  if (chosen === undefined) {
    throw new NoCardputerError(
      "no Cardputer found. Check it is plugged in over USB-C and that you can read /dev/ttyACM* — on " +
        "Omarchy logind grants that to the logged-in user automatically.",
    );
  }
  const device = new CardputerDevice(openSerial(chosen), tokens, chosen, geometry);
  await device.greet();
  if (confirmMs > 0 && !(await device.waitForHello(confirmMs))) {
    await device.close();
    throw new NoCardputerError(
      `${chosen} did not answer as a Cardputer within ${confirmMs}ms. Every ESP32-S3 enumerates ` +
        "through the same Espressif serial descriptor, so this may be another board entirely — or a " +
        "Cardputer that is not running the Anchor firmware in devices/firmware/cardputer/.",
    );
  }
  return device;
}
