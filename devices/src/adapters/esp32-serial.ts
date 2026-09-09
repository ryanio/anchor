/**
 * The pulse protocol over a USB cable.
 *
 * `esp32.ts` opens a TCP socket because `docs/devices-esp32.md` designed for a display on a shelf.
 * This file is the same protocol over a `/dev/ttyACM*` character device, and it exists for two
 * reasons — one practical, one about the invariant.
 *
 * **Practical.** A pulse display on Wi-Fi needs an SSID, a password, a provisioning flow, a
 * generated pairing key and a QR code scanned off its own screen before it can show a single pixel.
 * A cable needs none of that. Everything upstream of the transport — the surface model, the
 * rasteriser, the theme, the dirty-rect diff, the wire format — is identical, so the cable is the
 * short path to the first frame on real glass and the radio is a later change to one function.
 *
 * **The invariant.** AGENTS.md invariant 6 is why the network design has the device listening and
 * the host dialling out: Anchor must bind nothing. A serial link does not weaken that, it removes
 * the question. There is no socket, no port, no address and no route — the bytes never enter a
 * network stack at all, so there is nothing for a machine on the LAN to reach, and no pairing key
 * to protect a link that has no eavesdropper. That is strictly stronger than the loopback exemption
 * `checkTransport` already grants, which is why this path is allowed in the clear and a LAN one is
 * not. The trust boundary becomes a cable, exactly as it is for the Stream Deck.
 *
 * What is *not* claimed: this file has not been run against hardware. Nothing on this branch has —
 * see the README under `devices/firmware/esp32/`, which records what was measured and what was not.
 */

import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Link } from "./esp32.ts";
import { HEADER_BYTES, MAGIC, MessageType } from "./esp32-wire.ts";

export class SerialError extends Error {}

const BY_ID = "/dev/serial/by-id";

/**
 * Ports that could be an Anchor pulse display.
 *
 * ESP32-S3, -C3, -C6 and -H2 expose USB natively and enumerate through Espressif's own
 * JTAG/serial descriptor (`303a:1001`, "USB JTAG/serial debug unit"), so they appear here with
 * `Espressif` in the name rather than as a CP210x or CH340 bridge. Matching the descriptor rather
 * than a model name is the same discipline as reading capabilities out of HELLO: the host is not
 * given a table of boards to be wrong about.
 */
export function listPorts(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(BY_ID);
  } catch {
    // No `by-id` directory means udev has not populated one — not an error, just no devices.
    return [];
  }
  return entries
    .filter((name) => /espressif|usb_jtag|m5stack/i.test(name))
    .map((name) => join(BY_ID, name))
    .sort();
}

/**
 * The largest HELLO that can exist: ten fixed bytes plus an id the encoder caps at 255, of which
 * the firmware sends at most 64. Used to reject a false sync rather than to size a buffer.
 */
const MAX_HELLO_PAYLOAD = 10 + 255;

/**
 * How much unrecognised noise to tolerate before the oldest of it is dropped.
 *
 * The boot log below is a few hundred bytes. This is generous enough to hold several of them and
 * small enough that a port babbling forever cannot grow the process.
 */
export const MAX_PRESYNC_BYTES = 8192;

/**
 * Find where the device's first HELLO starts, or -1.
 *
 * **This is why the serial link is not just a pipe.** On a native-USB ESP32 the ROM bootloader, the
 * second-stage bootloader and — unless it is turned off — the application's own log all write to
 * the same CDC endpoint the protocol uses. So the first bytes read after opening the port are
 * almost never ours, and handing them to `decodeMessages` produces "stream is out of frame" on a
 * device that is working perfectly.
 *
 * Resynchronising is confined to here, before the first message, and does not loosen the parser: a
 * peer that goes out of frame *after* the handshake is still a peer to hang up on, which is what
 * `Esp32PulseDevice.#ingest` does. A one-time sync on a link with a documented noise source is a
 * different thing from a decoder that will hunt for a header whenever it gets confused.
 *
 * The match is deliberately more than the magic byte: 0xA5 is not ASCII, but a plausible-looking
 * length field as well makes a false positive in a boot log vanishingly unlikely, and a false sync
 * would strand the device until it was unplugged.
 */
export function findHello(buffer: Buffer): number {
  for (let at = 0; at + HEADER_BYTES <= buffer.length; at++) {
    if (buffer.readUInt8(at) !== MAGIC) continue;
    if (buffer.readUInt8(at + 1) !== MessageType.Hello) continue;
    const length = buffer.readUInt32LE(at + 4);
    if (length < 10 || length > MAX_HELLO_PAYLOAD) continue;
    return at;
  }
  return -1;
}

/**
 * Put a character device into raw mode and wrap it as a `Link`.
 *
 * No dependency: the port is a character device, so `fs` streams read and write it, and the one
 * thing `fs` cannot do — set the line discipline — is delegated to `stty` from coreutils. Same
 * trade `raster.ts` makes with ImageMagick, and the reason this workspace still has one dependency.
 *
 * The baud rate is a formality on CDC ACM, which ignores it; `raw` and `-echo` are the parts that
 * matter, and `-echo` matters a great deal — a port left in cooked mode echoes the framebuffer back
 * at the host, which reads as a device sending pixels it is not allowed to send.
 */
export function openSerialLink(path: string): Link {
  try {
    execFileSync("stty", ["-F", path, "raw", "-echo", "115200"], { stdio: "ignore", timeout: 5000 });
  } catch (error) {
    throw new SerialError(
      `could not put ${path} into raw mode: ${error instanceof Error ? error.message : String(error)}. ` +
        "On Arch the serial device is owned by the `uucp` group; add yourself to it and log back in.",
    );
  }

  const input = createReadStream(path);
  const output = createWriteStream(path);

  let data: ((chunk: Buffer) => void) | null = null;
  let closed: ((reason: string) => void) | null = null;
  let synced = false;
  let pending = Buffer.alloc(0);

  input.on("data", (chunk: string | Buffer) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "binary") : chunk;
    if (synced) {
      data?.(bytes);
      return;
    }
    pending = Buffer.concat([pending, bytes]);
    const at = findHello(pending);
    if (at === -1) {
      // Keep the tail: a HELLO may be split across this chunk and the next, and the header is
      // eight bytes, so nothing shorter than that can be discarded safely.
      if (pending.length > MAX_PRESYNC_BYTES) pending = pending.subarray(pending.length - HEADER_BYTES);
      return;
    }
    synced = true;
    const rest = pending.subarray(at);
    pending = Buffer.alloc(0);
    data?.(rest);
  });

  input.on("error", (error: Error) => closed?.(error.message));
  output.on("error", (error: Error) => closed?.(error.message));
  input.on("close", () => closed?.("serial port closed"));

  return {
    description: path,
    send: (chunk) =>
      new Promise<void>((resolve, reject) => {
        output.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    onData: (handler) => {
      data = handler;
    },
    onClose: (handler) => {
      closed = handler;
    },
    close: () => {
      input.destroy();
      output.destroy();
    },
  };
}
