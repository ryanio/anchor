/*
 * The Anchor Pulse protocol, device side.
 *
 * This is the half of `devices/src/adapters/esp32-wire.ts` that runs on the microcontroller, and it
 * is deliberately the *whole* of what the firmware knows. It owns no font, no palette, no layout
 * and no design system — the host renders and this blits, which is the argument made at length in
 * `docs/devices-esp32.md`. What is left after that argument is a byte-fed state machine and a
 * memcpy, and both fit here.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **No allocation, ever.** The caller supplies the framebuffer and the tile buffer, and their
 *    sizes are what HELLO promises the host. A message larger than the promise is a fault, not a
 *    realloc. An ESP32 that fragments its heap over a weekend of frames is a device that dies on a
 *    desk with nobody watching.
 * 2. **No platform.** C99 and `string.h`. It compiles for ESP-IDF, for Arduino, and for the host —
 *    the last of those is not a courtesy, it is how the encoder in `esp32-wire.ts` is proved
 *    against a real decoder instead of against itself. See `host/conformance.c`.
 * 3. **The vocabulary cannot ask for anything.** There is no opcode here for a signature, a key, an
 *    address, an amount or an approval, and there is nowhere to put one. AGENTS.md invariant 1 is
 *    enforced by the fact that the parser has no state to reach. What the device may say back is a
 *    slot id and two numbers.
 *
 * Byte order: the framebuffer is *opaque bytes in the order the host sent them*, never an array of
 * `uint16_t`. The device tells the host its panel's byte order in HELLO, the host packs to it, and
 * the blit is a row-wise `memcpy` straight into whatever the panel driver DMAs. Nothing in this
 * file ever swaps a pixel, which is the point of the field being in HELLO at all.
 */

#ifndef ANCHOR_PULSE_H
#define ANCHOR_PULSE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Must match PROTOCOL_VERSION in esp32-wire.ts. A host speaking another major version is refused. */
#define ANCHOR_PULSE_VERSION 1

/* First byte of every message. See MAGIC in esp32-wire.ts. */
#define ANCHOR_PULSE_MAGIC 0xA5u

#define ANCHOR_PULSE_HEADER_BYTES 8u

/* Message types. The device only ever *sends* HELLO, INPUT and PONG — see HOST_BOUND_TYPES. */
#define ANCHOR_MSG_HELLO 0x01u
#define ANCHOR_MSG_READY 0x02u
#define ANCHOR_MSG_TILE 0x10u
#define ANCHOR_MSG_COMMIT 0x11u
#define ANCHOR_MSG_BRIGHTNESS 0x12u
#define ANCHOR_MSG_BLANK 0x13u
#define ANCHOR_MSG_INPUT 0x20u
#define ANCHOR_MSG_PING 0x30u
#define ANCHOR_MSG_PONG 0x31u

/* Pixel formats. Both are RGB565; they differ only in which byte goes first on the wire. */
#define ANCHOR_PIXEL_RGB565_LE 0u
#define ANCHOR_PIXEL_RGB565_BE 1u

/* Tile encodings. Raw is always legal; the host sends Rle16 only when it is actually smaller. */
#define ANCHOR_TILE_RAW 0u
#define ANCHOR_TILE_RLE16 1u

/* Input kinds, in HELLO bit order — the INPUT_BITS array in esp32-wire.ts. */
#define ANCHOR_INPUT_PRESS 0u
#define ANCHOR_INPUT_RELEASE 1u
#define ANCHOR_INPUT_ROTATE 2u
#define ANCHOR_INPUT_TAP 3u
#define ANCHOR_INPUT_SWIPE 4u

/*
 * Why the stream is abandoned rather than resynchronised.
 *
 * Every one of these means the peer said something a correct host cannot say. The host hangs up on
 * a device that talks nonsense (`#ingest` in esp32.ts closes the link), and this is the same
 * judgement pointing the other way. Resynchronising a stream you have already caught lying is how a
 * decoder ends up painting attacker-chosen bytes into a framebuffer.
 */
typedef enum {
  ANCHOR_OK = 0,
  ANCHOR_FAULT_MAGIC,        /* header did not start with 0xA5 */
  ANCHOR_FAULT_TYPE,         /* a message type the device must never receive */
  ANCHOR_FAULT_LENGTH,       /* payload larger than the buffer HELLO promised */
  ANCHOR_FAULT_SHORT,        /* payload too short for the type that claimed it */
  ANCHOR_FAULT_RECT,         /* a tile that does not fit the panel */
  ANCHOR_FAULT_RLE,          /* run-length data that over- or under-runs its rectangle */
  ANCHOR_FAULT_VERSION       /* READY from a host speaking another protocol version */
} anchor_fault_t;

typedef struct {
  uint8_t version;
  uint8_t brightness;   /* 0-100 */
  uint16_t keepalive_ms;
  uint16_t stale_after_ms;
} anchor_ready_t;

/*
 * What the firmware must do when a message lands. All optional: a bring-up build that only wants to
 * see pixels can leave everything but `present` null.
 *
 * `present` is the one that matters. TILE writes into the framebuffer; COMMIT is the instant the
 * frame becomes true and the only point at which the panel should be pushed. A number that renders
 * half-updated is a wrong reading, not a cosmetic glitch, and money is what is on this screen.
 */
typedef struct {
  void *ctx;
  void (*present)(void *ctx);                       /* COMMIT */
  void (*ready)(void *ctx, const anchor_ready_t *r); /* READY */
  void (*brightness)(void *ctx, uint8_t percent);   /* BRIGHTNESS */
  void (*blank)(void *ctx);                         /* BLANK */
  /* Called with bytes the device owes the host — a PONG. Must write them all, in order. */
  void (*write)(void *ctx, const uint8_t *bytes, size_t count);
} anchor_pulse_sink_t;

typedef struct {
  /* --- caller-owned storage. Neither is allocated or freed here. --- */
  uint8_t *framebuffer; /* width * height * 2 bytes, in the declared pixel order */
  uint8_t *tile_buffer; /* at least `tile_capacity` bytes */
  uint32_t tile_capacity;
  uint16_t width;
  uint16_t height;

  anchor_pulse_sink_t sink;

  /* --- decoder state. Do not touch. --- */
  uint8_t header[ANCHOR_PULSE_HEADER_BYTES];
  uint32_t header_got;
  uint32_t payload_len;
  uint32_t payload_got;
  uint8_t type;
  uint16_t seq;
  uint16_t out_seq;
  anchor_fault_t fault;
  /* Set once a READY has been accepted. Frames before that are decoded but never presented. */
  int ready;
} anchor_pulse_t;

/*
 * Prepare a decoder. `framebuffer` must hold width*height*2 bytes and `tile_buffer` must hold
 * `tile_capacity`, which is the same number the firmware puts in HELLO's `maxTileBytes`. The host
 * splits every rectangle on whole rows to fit it, so the promise has to be true.
 */
void anchor_pulse_init(anchor_pulse_t *ap, uint8_t *framebuffer, uint16_t width, uint16_t height,
                       uint8_t *tile_buffer, uint32_t tile_capacity, const anchor_pulse_sink_t *sink);

/*
 * Feed bytes as they arrive — any number, split anywhere, including mid-header. Returns ANCHOR_OK
 * or the fault that ended the stream. Once faulted the decoder consumes nothing further; the
 * caller's job is to drop the connection, not to retry.
 */
anchor_fault_t anchor_pulse_feed(anchor_pulse_t *ap, const uint8_t *bytes, size_t count);

/* Build the HELLO this device sends on connect. Returns bytes written, or 0 if `cap` is too small. */
size_t anchor_pulse_hello(uint8_t *out, size_t cap, uint16_t width, uint16_t height, uint8_t format,
                          uint16_t max_tile_bytes, uint8_t input_mask, const char *device_id);

/*
 * Build an INPUT. `slot` is a panel slot id such as "screen:0"; `a` and `b` are x/y for a tap,
 * from/to for a swipe, and a delta with an unused zero for a rotate.
 *
 * This is the entire outbound vocabulary of an Anchor device, and it is worth saying out loud what
 * is absent: there is no argument here for an amount, an address or an approval, because a tap on a
 * desk display is a page change and the executor is what decides anything that costs money.
 */
size_t anchor_pulse_input(uint8_t *out, size_t cap, uint16_t seq, uint8_t kind, const char *slot,
                          int16_t a, int16_t b);

/* Clear the framebuffer to a single RGB565 pixel, written in the device's own byte order. */
void anchor_pulse_fill(anchor_pulse_t *ap, uint8_t high, uint8_t low);

#ifdef __cplusplus
}
#endif

#endif /* ANCHOR_PULSE_H */
