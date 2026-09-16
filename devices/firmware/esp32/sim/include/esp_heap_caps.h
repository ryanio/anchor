#ifndef ANCHOR_SIM_ESP_HEAP_CAPS_H
#define ANCHOR_SIM_ESP_HEAP_CAPS_H

/*
 * The two allocators `setup()` chooses between.
 *
 * PSRAM is present by default, because the board has 8MB of it and 7,943,664 bytes free at boot —
 * measured, and recorded in `docs/devices-esp32.md`. `--no-psram` makes `heap_caps_malloc` refuse
 * the SPIRAM request, which is the *only* way to exercise the fallback that claims a 240x135 panel
 * in HELLO. That path has never run on hardware and cannot without desoldering something, so a
 * simulator is the only place it is checkable at all.
 */

/*
 * Plain C headers, and `extern "C"`, because this one is included from C as well as C++.
 *
 * `pulse/lv_conf.h` points LVGL's memory pool at `heap_caps_malloc` through `LV_MEM_POOL_INCLUDE`,
 * and the file that consumes it — `lvgl/src/stdlib/builtin/lv_mem_core_builtin.c` — is C99. With
 * `<cstdint>` here that build fails at the first line of the include. The linkage guard is the other
 * half: without it the declaration C sees and the definition `shim.cpp` provides would be two
 * different symbols, which links on some toolchains and not others.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define MALLOC_CAP_SPIRAM (1 << 10)
#define MALLOC_CAP_INTERNAL (1 << 11)

#ifdef __cplusplus
extern "C" {
#endif

void *heap_caps_malloc(size_t bytes, uint32_t caps);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);

/* The driver's half. */
void simSetPsram(int present);
int simPsram(void);

#ifdef __cplusplus
}
#endif

#endif /* ANCHOR_SIM_ESP_HEAP_CAPS_H */
