#ifndef ANCHOR_PULSE_MEM_H
#define ANCHOR_PULSE_MEM_H

/*
 * Where LVGL's heap comes from, and what happens when the first choice is not there.
 *
 * `lv_conf.h` points `LV_MEM_POOL_ALLOC` at this function, so it is called exactly once, from
 * `lv_mem_init()`, with `LV_MEM_SIZE`. It is a header full of `static inline` rather than a `.cpp`
 * because the only file that includes it is `lvgl/src/stdlib/builtin/lv_mem_core_builtin.c` — C99,
 * inside the library, compiled by whichever build system is driving. There is nowhere to link an
 * Anchor object file into that from `arduino-cli`, and the sketch directory is already on the
 * include path (the same mechanism that makes `lv_conf.h` itself findable; the long comment at the
 * top of that file explains it).
 *
 * ## Why this is not one call to `heap_caps_malloc`
 *
 * It was, and the simulator found the bug in the first run that exercised it. `LV_MEM_POOL_ALLOC`
 * returning PSRAM directly meant that on a board where the SPIRAM allocation fails, LVGL is handed
 * a null pool and `lv_tlsf_create_with_pool()` writes its first block header through it. That is a
 * segfault on the desktop and a boot loop on the device — and, worse, a boot loop in `lv_init()`,
 * before a single line of this firmware's own diagnostics has run, so the symptom would be a board
 * that resets forever and says nothing about why.
 *
 * `sim/lvgl.sh --no-psram` is what caught it, and that switch exists precisely because this path
 * cannot be reached on real hardware without desoldering something. It is the same reason
 * `sim/include/esp_heap_caps.h` has the switch at all: the blitter's fallback to a 240x135 panel had
 * never run either.
 *
 * So: PSRAM first — LVGL's tree, styles and glyph caches are not on a hot memcpy path and there are
 * ~7.9 MB going spare — and internal SRAM if there is no PSRAM, where 128 kB still fits inside the
 * ~267 kB this part reports free with the USB stack up. A slower screen is a screen. A null pool is
 * not.
 */

#include <esp_heap_caps.h>

static inline void *anchor_lv_pool(size_t bytes)
{
	void *pool = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
	if (pool == NULL) pool = heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL);
	/*
	 * Still null is a board that cannot run LVGL at all, and there is deliberately no rescue here:
	 * LVGL has no way to be told "I could not", `lv_init()` is called before this firmware has a
	 * panel or a banner, and a half-initialised LVGL is a worse thing to debug than a crash. The
	 * honest place to notice it is the boot banner's `lv_mem_monitor()` line, which reports the pool
	 * that actually exists.
	 */
	return pool;
}

#endif /* ANCHOR_PULSE_MEM_H */
