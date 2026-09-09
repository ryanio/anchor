/*
 * Anchor Pulse, device side. See anchor_pulse.h for why this file is as small as it is.
 *
 * Everything is a byte-fed state machine over caller-owned buffers, so the same object file runs on
 * an ESP32 and under `node --test` on the desktop. The second of those is what makes the first
 * trustworthy: `esp32-firmware.test.ts` drives the real host adapter, pipes its bytes through this
 * decoder, and compares the framebuffer to the frame the host believes it sent. An encoder tested
 * only against its own decoder is an encoder tested against itself.
 */

#include "anchor_pulse.h"

#include <string.h>

/* ---------------------------------------------------------------- little-endian readers ------- */

static uint16_t read_u16(const uint8_t *p) {
  return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void write_u16(uint8_t *p, uint16_t value) {
  p[0] = (uint8_t)(value & 0xFFu);
  p[1] = (uint8_t)((value >> 8) & 0xFFu);
}

static void write_u32(uint8_t *p, uint32_t value) {
  p[0] = (uint8_t)(value & 0xFFu);
  p[1] = (uint8_t)((value >> 8) & 0xFFu);
  p[2] = (uint8_t)((value >> 16) & 0xFFu);
  p[3] = (uint8_t)((value >> 24) & 0xFFu);
}

static size_t put_header(uint8_t *out, uint8_t type, uint16_t seq, uint32_t length) {
  out[0] = (uint8_t)ANCHOR_PULSE_MAGIC;
  out[1] = type;
  write_u16(out + 2, seq);
  write_u32(out + 4, length);
  return ANCHOR_PULSE_HEADER_BYTES;
}

/* --------------------------------------------------------------------------- setup ------------ */

void anchor_pulse_init(anchor_pulse_t *ap, uint8_t *framebuffer, uint16_t width, uint16_t height,
                       uint8_t *tile_buffer, uint32_t tile_capacity,
                       const anchor_pulse_sink_t *sink) {
  memset(ap, 0, sizeof(*ap));
  ap->framebuffer = framebuffer;
  ap->width = width;
  ap->height = height;
  ap->tile_buffer = tile_buffer;
  ap->tile_capacity = tile_capacity;
  if (sink != NULL) ap->sink = *sink;
  ap->fault = ANCHOR_OK;
}

void anchor_pulse_fill(anchor_pulse_t *ap, uint8_t high, uint8_t low) {
  size_t pixels = (size_t)ap->width * (size_t)ap->height;
  uint8_t *at = ap->framebuffer;
  for (size_t i = 0; i < pixels; i++) {
    *at++ = high;
    *at++ = low;
  }
}

/* ------------------------------------------------------------------------ tile blitting ------- */

/*
 * A tile is a rectangle of the panel, and its pixels arrive row-major *within the rectangle* — so
 * the destination advances by the panel's stride, not the tile's, every `rect.width` pixels. Both
 * the raw and the run-length paths go through this cursor rather than each doing the arithmetic,
 * because getting it wrong in one of two places produces a diagonal smear that only appears on
 * hardware.
 */
typedef struct {
  uint8_t *base;
  uint32_t stride_bytes; /* panel width * 2 */
  uint16_t x, y, w, h;
  uint32_t written; /* pixels written so far */
  uint32_t total;   /* w * h */
} tile_cursor_t;

static void cursor_begin(tile_cursor_t *c, const anchor_pulse_t *ap, uint16_t x, uint16_t y,
                         uint16_t w, uint16_t h) {
  c->base = ap->framebuffer;
  c->stride_bytes = (uint32_t)ap->width * 2u;
  c->x = x;
  c->y = y;
  c->w = w;
  c->h = h;
  c->written = 0;
  c->total = (uint32_t)w * (uint32_t)h;
}

/* Destination of the next pixel, and how many more fit in the row it starts. */
static uint8_t *cursor_at(const tile_cursor_t *c, uint32_t *room) {
  uint32_t row = c->written / c->w;
  uint32_t col = c->written % c->w;
  *room = (uint32_t)c->w - col;
  return c->base + ((uint32_t)(c->y + row) * c->stride_bytes) + ((uint32_t)(c->x + col) * 2u);
}

/* `count` copies of one pixel. The two bytes are written in the order they came off the wire. */
static int cursor_run(tile_cursor_t *c, uint8_t high, uint8_t low, uint32_t count) {
  if (count > c->total - c->written) return 0;
  while (count > 0) {
    uint32_t room = 0;
    uint8_t *at = cursor_at(c, &room);
    uint32_t take = count < room ? count : room;
    for (uint32_t i = 0; i < take; i++) {
      *at++ = high;
      *at++ = low;
    }
    c->written += take;
    count -= take;
  }
  return 1;
}

/* `count` pixels verbatim from `src`. */
static int cursor_copy(tile_cursor_t *c, const uint8_t *src, uint32_t count) {
  if (count > c->total - c->written) return 0;
  while (count > 0) {
    uint32_t room = 0;
    uint8_t *at = cursor_at(c, &room);
    uint32_t take = count < room ? count : room;
    memcpy(at, src, (size_t)take * 2u);
    src += (size_t)take * 2u;
    c->written += take;
    count -= take;
  }
  return 1;
}

/*
 * PackBits over 16-bit pixels — the decoder half of `encodeRle16`.
 *
 * A control byte with the high bit set is a run of `(n & 0x7f) + 1` copies of the pixel that
 * follows; clear, and it is `n + 1` pixels verbatim. Byte order never enters into it: pixels are
 * copied as pairs, so this is correct for either declared format without knowing which one it is.
 */
static anchor_fault_t decode_rle16(tile_cursor_t *c, const uint8_t *in, uint32_t len) {
  uint32_t read = 0;
  while (read < len) {
    uint8_t control = in[read++];
    if ((control & 0x80u) != 0) {
      uint32_t run = (uint32_t)(control & 0x7Fu) + 1u;
      if (read + 2u > len) return ANCHOR_FAULT_RLE;
      if (!cursor_run(c, in[read], in[read + 1], run)) return ANCHOR_FAULT_RLE;
      read += 2u;
    } else {
      uint32_t literal = (uint32_t)control + 1u;
      if (read + (literal * 2u) > len) return ANCHOR_FAULT_RLE;
      if (!cursor_copy(c, in + read, literal)) return ANCHOR_FAULT_RLE;
      read += literal * 2u;
    }
  }
  /* Short is as wrong as long: a rectangle that is only partly written is a torn reading. */
  return c->written == c->total ? ANCHOR_OK : ANCHOR_FAULT_RLE;
}

static anchor_fault_t handle_tile(anchor_pulse_t *ap, const uint8_t *payload, uint32_t len) {
  if (len < 9u) return ANCHOR_FAULT_SHORT;
  uint16_t x = read_u16(payload);
  uint16_t y = read_u16(payload + 2);
  uint16_t w = read_u16(payload + 4);
  uint16_t h = read_u16(payload + 6);
  uint8_t encoding = payload[8];

  /*
   * A rectangle is arithmetic on someone else's numbers, and it lands as a pointer into the
   * framebuffer. Widened to 32 bits before the comparison so `x + w` cannot wrap past the panel.
   */
  if (w == 0u || h == 0u) return ANCHOR_FAULT_RECT;
  if ((uint32_t)x + (uint32_t)w > (uint32_t)ap->width) return ANCHOR_FAULT_RECT;
  if ((uint32_t)y + (uint32_t)h > (uint32_t)ap->height) return ANCHOR_FAULT_RECT;

  /* Remember the band for the panel push. See `dirty_top` in the header for why rows, not rects. */
  if (!ap->has_dirty) {
    ap->dirty_top = y;
    ap->dirty_bottom = (uint16_t)(y + h - 1);
    ap->has_dirty = 1;
  } else {
    if (y < ap->dirty_top) ap->dirty_top = y;
    if ((uint16_t)(y + h - 1) > ap->dirty_bottom) ap->dirty_bottom = (uint16_t)(y + h - 1);
  }

  tile_cursor_t cursor;
  cursor_begin(&cursor, ap, x, y, w, h);

  const uint8_t *pixels = payload + 9;
  uint32_t pixel_bytes = len - 9u;

  if (encoding == ANCHOR_TILE_RAW) {
    if (pixel_bytes != cursor.total * 2u) return ANCHOR_FAULT_SHORT;
    return cursor_copy(&cursor, pixels, cursor.total) ? ANCHOR_OK : ANCHOR_FAULT_RECT;
  }
  if (encoding == ANCHOR_TILE_RLE16) return decode_rle16(&cursor, pixels, pixel_bytes);
  return ANCHOR_FAULT_SHORT;
}

/* ------------------------------------------------------------------------- dispatch ----------- */

static anchor_fault_t dispatch(anchor_pulse_t *ap) {
  const uint8_t *payload = ap->tile_buffer;
  uint32_t len = ap->payload_len;

  switch (ap->type) {
    case ANCHOR_MSG_READY: {
      if (len < 6u) return ANCHOR_FAULT_SHORT;
      if (payload[0] != ANCHOR_PULSE_VERSION) return ANCHOR_FAULT_VERSION;
      anchor_ready_t ready;
      ready.version = payload[0];
      ready.brightness = payload[1];
      ready.keepalive_ms = read_u16(payload + 2);
      ready.stale_after_ms = read_u16(payload + 4);
      ap->ready = 1;
      if (ap->sink.ready != NULL) ap->sink.ready(ap->sink.ctx, &ready);
      return ANCHOR_OK;
    }
    case ANCHOR_MSG_TILE:
      return handle_tile(ap, payload, len);
    case ANCHOR_MSG_COMMIT:
      /* The band is live for the duration of the callback and cleared after it, so a present that
       * pushes only what changed cannot accidentally reuse a stale one on the next frame. */
      if (ap->sink.present != NULL) ap->sink.present(ap->sink.ctx);
      ap->has_dirty = 0;
      return ANCHOR_OK;
    case ANCHOR_MSG_BRIGHTNESS: {
      if (len < 1u) return ANCHOR_FAULT_SHORT;
      uint8_t percent = payload[0] > 100u ? 100u : payload[0];
      if (ap->sink.brightness != NULL) ap->sink.brightness(ap->sink.ctx, percent);
      return ANCHOR_OK;
    }
    case ANCHOR_MSG_BLANK:
      if (ap->sink.blank != NULL) ap->sink.blank(ap->sink.ctx);
      return ANCHOR_OK;
    case ANCHOR_MSG_PING: {
      /* Answered with the host's own sequence number, so a host can match a reply to a probe. */
      uint8_t out[ANCHOR_PULSE_HEADER_BYTES];
      put_header(out, ANCHOR_MSG_PONG, ap->seq, 0u);
      if (ap->sink.write != NULL) ap->sink.write(ap->sink.ctx, out, sizeof(out));
      return ANCHOR_OK;
    }
    default:
      /*
       * HELLO, INPUT and PONG are the device's own vocabulary. A host sending one is either broken
       * or is not a host, and neither is a stream to keep reading.
       */
      return ANCHOR_FAULT_TYPE;
  }
}

/* ---------------------------------------------------------------------------- feed ------------ */

anchor_fault_t anchor_pulse_feed(anchor_pulse_t *ap, const uint8_t *bytes, size_t count) {
  if (ap->fault != ANCHOR_OK) return ap->fault;

  size_t at = 0;
  while (at < count) {
    if (ap->header_got < ANCHOR_PULSE_HEADER_BYTES) {
      size_t want = ANCHOR_PULSE_HEADER_BYTES - ap->header_got;
      size_t take = (count - at) < want ? (count - at) : want;
      memcpy(ap->header + ap->header_got, bytes + at, take);
      ap->header_got += (uint32_t)take;
      at += take;
      if (ap->header_got < ANCHOR_PULSE_HEADER_BYTES) break;

      if (ap->header[0] != (uint8_t)ANCHOR_PULSE_MAGIC) {
        /*
         * Before READY, slide the window and keep looking. After it, this is a fault.
         *
         * The asymmetry is the point, and it mirrors `findHello` on the host exactly. A serial line
         * carries things that are not the protocol: a boot log, the tail of esptool's stub loader,
         * whatever was in the peripheral when the cable was replugged. None of that is an attack
         * and all of it arrives before a host has said anything. **Measured:** without this the
         * device announced itself as already broken after a flash, because the first bytes it ever
         * read were somebody else's.
         *
         * Once a host has sent READY the session is established, and a byte out of place means the
         * stream is no longer what it claims to be. Then it faults, and the firmware starts over —
         * hunting for a header in a stream you have already caught lying is how a decoder ends up
         * blitting attacker-chosen bytes into a framebuffer.
         */
        if (!ap->ready) {
          memmove(ap->header, ap->header + 1, ANCHOR_PULSE_HEADER_BYTES - 1);
          ap->header_got = ANCHOR_PULSE_HEADER_BYTES - 1;
          continue;
        }
        ap->fault = ANCHOR_FAULT_MAGIC;
        return ap->fault;
      }
      ap->type = ap->header[1];
      ap->seq = read_u16(ap->header + 2);
      ap->payload_len = read_u32(ap->header + 4);
      ap->payload_got = 0;
      /*
       * The buffer is the promise HELLO made. A host that overruns it is not owed a bigger one —
       * `maxTileBytes` exists precisely so the host does the splitting and the device never
       * allocates. Fault rather than truncate: a truncated tile is a wrong picture.
       */
      if (ap->payload_len > ap->tile_capacity) {
        ap->fault = ANCHOR_FAULT_LENGTH;
        return ap->fault;
      }
      if (ap->payload_len == 0u) {
        ap->fault = dispatch(ap);
        ap->header_got = 0;
        if (ap->fault != ANCHOR_OK) return ap->fault;
      }
      continue;
    }

    size_t want = ap->payload_len - ap->payload_got;
    size_t take = (count - at) < want ? (count - at) : want;
    memcpy(ap->tile_buffer + ap->payload_got, bytes + at, take);
    ap->payload_got += (uint32_t)take;
    at += take;
    if (ap->payload_got < ap->payload_len) break;

    ap->fault = dispatch(ap);
    ap->header_got = 0;
    ap->payload_len = 0;
    ap->payload_got = 0;
    if (ap->fault != ANCHOR_OK) return ap->fault;
  }
  return ANCHOR_OK;
}

/* -------------------------------------------------------------------- outbound messages ------- */

size_t anchor_pulse_hello(uint8_t *out, size_t cap, uint16_t width, uint16_t height, uint8_t format,
                          uint16_t max_tile_bytes, uint8_t input_mask, const char *device_id) {
  size_t id_len = 0;
  if (device_id != NULL) {
    while (device_id[id_len] != '\0' && id_len < 64u) id_len++;
  }
  size_t payload = 10u + id_len;
  if (cap < ANCHOR_PULSE_HEADER_BYTES + payload) return 0;

  uint8_t *p = out + put_header(out, ANCHOR_MSG_HELLO, 0u, (uint32_t)payload);
  p[0] = ANCHOR_PULSE_VERSION;
  write_u16(p + 1, width);
  write_u16(p + 3, height);
  p[5] = format;
  write_u16(p + 6, max_tile_bytes);
  p[8] = input_mask;
  p[9] = (uint8_t)id_len;
  if (id_len > 0) memcpy(p + 10, device_id, id_len);
  return ANCHOR_PULSE_HEADER_BYTES + payload;
}

size_t anchor_pulse_input(uint8_t *out, size_t cap, uint16_t seq, uint8_t kind, const char *slot,
                          int16_t a, int16_t b) {
  size_t slot_len = 0;
  if (slot != NULL) {
    while (slot[slot_len] != '\0' && slot_len < 64u) slot_len++;
  }
  size_t payload = 6u + slot_len;
  if (cap < ANCHOR_PULSE_HEADER_BYTES + payload) return 0;

  uint8_t *p = out + put_header(out, ANCHOR_MSG_INPUT, seq, (uint32_t)payload);
  p[0] = kind;
  p[1] = (uint8_t)slot_len;
  if (slot_len > 0) memcpy(p + 2, slot, slot_len);
  write_u16(p + 2 + slot_len, (uint16_t)a);
  write_u16(p + 4 + slot_len, (uint16_t)b);
  return ANCHOR_PULSE_HEADER_BYTES + payload;
}
