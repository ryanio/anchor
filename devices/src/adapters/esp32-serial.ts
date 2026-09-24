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
    // No `by-id` directory means udev has not populated one — not an error, just no devices. On
    // macOS there is no such directory at all, which is a different question with its own answer.
    return macPorts();
  }
  const found = entries
    .filter((name) => /espressif|usb_jtag|m5stack/i.test(name))
    .map((name) => join(BY_ID, name))
    .sort();
  return found.length > 0 ? found : macPorts();
}

/**
 * The same question on macOS, where `/dev/serial/by-id` does not exist.
 *
 * udev builds those stable names out of the USB descriptor; Darwin does not, and offers
 * `/dev/cu.usbmodem<serial>` instead. `cu` rather than `tty` deliberately: opening a `tty.` device
 * on Darwin blocks waiting for carrier detect, which a USB CDC endpoint never asserts, so the open
 * never returns and the daemon looks hung rather than failing.
 *
 * **This loses the guarantee the by-id path was carrying, which is worth being explicit about.**
 * Both boards in this project enumerate through the same Espressif JTAG/serial descriptor, so on
 * Linux the only thing stopping the daemon from driving the wrong one is pinning the exact by-id
 * path — the lesson behind 6,601 crash-looped restarts. Darwin's node names embed the USB serial
 * number so they are stable per board, but they are not self-describing: nothing in
 * `cu.usbmodem588A0847A1` says which of the two devices it is.
 *
 * So on macOS `--esp32 <path>` wants giving explicitly, exactly as the systemd units do on Linux,
 * and this fallback is for finding out what is attached rather than for a daemon to guess with.
 * `cli.ts` already probes candidates and reads the device id out of HELLO, which is the honest
 * identification and works identically on both platforms.
 */
function macPorts(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    return readdirSync("/dev")
      .filter((name) => /^cu\.usbmodem/i.test(name))
      .map((name) => join("/dev", name))
      .sort();
  } catch {
    return [];
  }
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
const MAX_PRESYNC_BYTES = 8192;

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

  /*
   * One message at a time, all the way out.
   *
   * This is the fix for a `fault-3` (`ANCHOR_FAULT_LENGTH`) that has now been misdiagnosed twice,
   * and the history is worth keeping because the second diagnosis made the first one much worse.
   *
   * `send` is async. Nothing here serialised it. `Esp32PulseDevice` runs a keepalive on a 2s
   * `setInterval` and paints from its own path, so the moment a paint takes longer than a keepalive
   * interval the two interleave: the ping's bytes land in the middle of the frame's, the decoder
   * reads a PING header out of the middle of a TILE payload, and correctly concludes it is being
   * lied to. That is the fault, and it is a race, not a throughput problem — which is why it showed
   * up intermittently and looked like a flaky cable.
   *
   * It was read as the Cardputer's dropped-write problem instead, and the Cardputer's fix — 64 byte
   * writes with an 8ms pause between them — was carried across. On the Cardputer, whose messages
   * are NDJSON lines of tens to hundreds of bytes, that costs nothing. Here it is 8 KB/s against a
   * 368x448 panel: a frame that this document measured at 213ms end to end now takes tens of
   * seconds, which guarantees the keepalive fires mid-frame every single time. A pacing change
   * meant to prevent the fault made it certain.
   *
   * So: a promise chain, so two callers cannot have bytes on the wire at once, and backpressure
   * instead of a sleep. The firmware sizes its receive buffer at 64KB precisely to absorb back to
   * back 8KB tiles (see `app.ino`'s `setRxBufferSize`, and the comment above it about why it needs
   * `Serial.end()` first), so the drain signal is the honest limit rather than a guessed delay.
   */
  const CHUNK_BYTES = 8192;
  let tail: Promise<void> = Promise.resolve();

  const writeAll = async (chunk: Buffer): Promise<void> => {
    for (let i = 0; i < chunk.length; i += CHUNK_BYTES) {
      const piece = chunk.subarray(i, i + CHUNK_BYTES);
      const flushed = output.write(piece);
      if (!flushed) {
        // The kernel's buffer is full; wait for it rather than piling on and hoping.
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => {
            output.off("error", onError);
            resolve();
          };
          const onError = (error: Error): void => {
            output.off("drain", onDrain);
            reject(error);
          };
          output.once("drain", onDrain);
          output.once("error", onError);
        });
      }
    }
  };

  const send = (chunk: Buffer): Promise<void> => {
    // Queue on the tail whether or not the previous send succeeded: a failed write must not leave
    // the chain broken for every message after it, and the caller already hears its own rejection.
    const next = tail.then(
      () => writeAll(chunk),
      () => writeAll(chunk),
    );
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    description: path,
    send,
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
