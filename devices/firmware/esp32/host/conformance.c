/*
 * Run the firmware decoder on the desktop.
 *
 * This exists for one reason, and it is the reason AGENTS.md gives for making a control fail before
 * trusting it: `esp32-wire.ts` ships with a `decodeRle16` written in TypeScript, and an encoder
 * proved against a decoder in the same file is an encoder proved against itself. This binary is the
 * *other* implementation — the same C that will be compiled for the ESP32 — so a test can push real
 * frames from the real host adapter through it and compare the resulting framebuffer, byte for
 * byte, with what the host believes it painted.
 *
 *   conformance <width> <height> <tile-capacity> <framebuffer-out> <device-out> [chunk]
 *
 * Bytes arrive on stdin. `chunk` feeds them in slices of that size — 1 is the interesting value,
 * because it proves the decoder survives a message split at every possible byte, which is what a
 * real 64-byte USB CDC endpoint or a TCP segment boundary does to it.
 *
 * Events go to stdout, one per line, so a test can assert that COMMIT landed once rather than
 * inferring it from pixels.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "anchor_pulse.h"

typedef struct {
  anchor_pulse_t *ap;
  const char *fb_path;
  FILE *device_out;
  int commits;
} harness_t;

static void dump_framebuffer(const harness_t *h) {
  FILE *f = fopen(h->fb_path, "wb");
  if (f == NULL) {
    fprintf(stderr, "cannot write %s\n", h->fb_path);
    exit(2);
  }
  size_t bytes = (size_t)h->ap->width * (size_t)h->ap->height * 2u;
  fwrite(h->ap->framebuffer, 1, bytes, f);
  fclose(f);
}

static void on_present(void *ctx) {
  harness_t *h = (harness_t *)ctx;
  h->commits++;
  /* Written on every COMMIT, so the file always holds a frame that was actually presented. */
  dump_framebuffer(h);
  printf("commit %d\n", h->commits);
}

static void on_ready(void *ctx, const anchor_ready_t *r) {
  (void)ctx;
  printf("ready version=%u brightness=%u keepalive=%u stale=%u\n", r->version, r->brightness,
         r->keepalive_ms, r->stale_after_ms);
}

static void on_brightness(void *ctx, uint8_t percent) {
  (void)ctx;
  printf("brightness %u\n", percent);
}

static void on_blank(void *ctx) {
  (void)ctx;
  printf("blank\n");
}

static void on_write(void *ctx, const uint8_t *bytes, size_t count) {
  harness_t *h = (harness_t *)ctx;
  fwrite(bytes, 1, count, h->device_out);
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: %s <w> <h> <tilecap> <fb-out> <device-out> [chunk]\n", argv[0]);
    return 2;
  }
  uint16_t width = (uint16_t)atoi(argv[1]);
  uint16_t height = (uint16_t)atoi(argv[2]);
  uint32_t tile_cap = (uint32_t)strtoul(argv[3], NULL, 10);
  size_t chunk = argc > 6 ? (size_t)strtoul(argv[6], NULL, 10) : 0;

  size_t fb_bytes = (size_t)width * (size_t)height * 2u;
  uint8_t *fb = (uint8_t *)calloc(fb_bytes, 1);
  uint8_t *tile = (uint8_t *)calloc(tile_cap, 1);
  if (fb == NULL || tile == NULL) {
    fprintf(stderr, "out of memory\n");
    return 2;
  }

  harness_t harness;
  memset(&harness, 0, sizeof(harness));
  harness.fb_path = argv[4];
  harness.device_out = fopen(argv[5], "wb");
  if (harness.device_out == NULL) {
    fprintf(stderr, "cannot write %s\n", argv[5]);
    return 2;
  }

  anchor_pulse_t ap;
  harness.ap = &ap;
  anchor_pulse_sink_t sink;
  memset(&sink, 0, sizeof(sink));
  sink.ctx = &harness;
  sink.present = on_present;
  sink.ready = on_ready;
  sink.brightness = on_brightness;
  sink.blank = on_blank;
  sink.write = on_write;

  anchor_pulse_init(&ap, fb, width, height, tile, tile_cap, &sink);

  /*
   * Read everything first rather than streaming, so `chunk` controls the split sizes exactly. The
   * device does not have this luxury and does not need it — `anchor_pulse_feed` is written to take
   * bytes in any arrangement, and feeding one at a time here is how that claim is checked.
   */
  size_t cap = 1 << 16, len = 0;
  uint8_t *input = (uint8_t *)malloc(cap);
  for (;;) {
    if (len == cap) {
      cap *= 2;
      input = (uint8_t *)realloc(input, cap);
      if (input == NULL) return 2;
    }
    size_t got = fread(input + len, 1, cap - len, stdin);
    len += got;
    if (got == 0) break;
  }

  anchor_fault_t fault = ANCHOR_OK;
  size_t step = chunk == 0 ? len : chunk;
  for (size_t at = 0; at < len && fault == ANCHOR_OK; at += step) {
    size_t take = (len - at) < step ? (len - at) : step;
    fault = anchor_pulse_feed(&ap, input + at, take);
  }

  printf("fault %d\n", (int)fault);
  fclose(harness.device_out);
  free(input);
  free(tile);
  free(fb);
  return fault == ANCHOR_OK ? 0 : 1;
}
