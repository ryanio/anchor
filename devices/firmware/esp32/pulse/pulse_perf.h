#ifndef ANCHOR_PULSE_PERF_H
#define ANCHOR_PULSE_PERF_H

#include <Arduino.h>
#include <lvgl.h>

/*
 * Where a frame's time goes, for "it feels laggy when I touch it".
 *
 * Touch is read by an LVGL timer on the same loop that draws, so anything that makes a refresh slow
 * also delays the next touch read, and a finger feels it before a screenshot shows anything. These
 * count, per window: frames drawn, the time from a refresh starting to its last flush returning, the
 * part of the flushes spent waiting for the tearing line and the part spent pushing pixels, the
 * longest gap between two touch reads, and the longest single pass of `loop()`.
 *
 * The health line prints the same figures for its minute. `PULSE_PERF_LOG=1` also prints them every
 * two seconds, for an investigation with a finger on the glass.
 *
 * A header rather than a block in `pulse.ino` because the Arduino builder writes prototypes for the
 * sketch's functions above the first one it finds, before any type the sketch declares, and a
 * function taking a `Perf &` then fails to compile.
 */
#ifndef PULSE_PERF_LOG
#define PULSE_PERF_LOG 0
#endif

namespace pulse_perf {

struct Perf {
	uint32_t frames = 0;
	uint32_t frame_us_total = 0;
	uint32_t frame_us_max = 0;
	uint32_t te_wait_us = 0;
	uint32_t blit_us = 0;
	uint32_t input_gap_ms_max = 0;
	uint32_t loop_us_max = 0;
};

namespace detail {

inline Perf window;
inline Perf minute;
inline uint32_t frame_started_us = 0;
inline uint32_t last_input_ms = 0;
inline uint32_t window_started_ms = 0;

inline void both(void (*apply)(Perf &, uint32_t, uint32_t), uint32_t a, uint32_t b)
{
	apply(window, a, b);
	apply(minute, a, b);
}

inline void maxInto(uint32_t &slot, uint32_t value)
{
	if (value > slot) slot = value;
}

/* A refresh-timer tick that finds nothing invalidated sends `REFR_START` and never `RENDER_READY`,
 * so only ticks that drew something are counted. */
inline void onRefresh(lv_event_t *event)
{
	if (lv_event_get_code(event) == LV_EVENT_REFR_START) {
		frame_started_us = micros();
		return;
	}
	if (frame_started_us == 0) return;
	const uint32_t us = micros() - frame_started_us;
	frame_started_us = 0;
	both(
	    [](Perf &p, uint32_t us, uint32_t) {
		    p.frames++;
		    p.frame_us_total += us;
		    maxInto(p.frame_us_max, us);
	    },
	    us, 0);
}

inline void print(const char *label, const Perf &p, uint32_t window_ms)
{
	if (window_ms == 0) window_ms = 1;
	const uint32_t avg_us = p.frames ? p.frame_us_total / p.frames : 0;
	Serial.printf("%s fps=%lu frame_ms_avg=%lu frame_ms_max=%lu te_wait_ms=%lu blit_ms=%lu busy=%lu%% "
	              "input_gap_ms_max=%lu loop_ms_max=%lu\n",
	              label, (unsigned long)(p.frames * 1000u / window_ms), (unsigned long)(avg_us / 1000u),
	              (unsigned long)(p.frame_us_max / 1000u), (unsigned long)(p.te_wait_us / 1000u),
	              (unsigned long)(p.blit_us / 1000u), (unsigned long)(p.frame_us_total / 10u / window_ms),
	              (unsigned long)p.input_gap_ms_max, (unsigned long)(p.loop_us_max / 1000u));
}

}  // namespace detail

inline void attach(lv_display_t *display)
{
	lv_display_add_event_cb(display, detail::onRefresh, LV_EVENT_REFR_START, nullptr);
	lv_display_add_event_cb(display, detail::onRefresh, LV_EVENT_RENDER_READY, nullptr);
}

inline void noteFlush(uint32_t te_wait_us, uint32_t blit_us)
{
	detail::both(
	    [](Perf &p, uint32_t wait, uint32_t blit) {
		    p.te_wait_us += wait;
		    p.blit_us += blit;
	    },
	    te_wait_us, blit_us);
}

inline void noteInputRead(uint32_t now_ms)
{
	if (detail::last_input_ms != 0) {
		detail::both([](Perf &p, uint32_t gap, uint32_t) { detail::maxInto(p.input_gap_ms_max, gap); },
		             now_ms - detail::last_input_ms, 0);
	}
	detail::last_input_ms = now_ms;
}

inline void noteLoop(uint32_t us)
{
	detail::both([](Perf &p, uint32_t us, uint32_t) { detail::maxInto(p.loop_us_max, us); }, us, 0);
}

/* The minute's figures on their own line, straight after the health line. */
inline void printMinute(uint32_t window_ms)
{
	detail::print("anchor-pulse-lvgl: frames", detail::minute, window_ms);
	detail::minute = Perf{};
}

inline void tick(uint32_t now_ms)
{
#if PULSE_PERF_LOG
	constexpr uint32_t WINDOW_MS = 2000;
	if (now_ms - detail::window_started_ms < WINDOW_MS) return;
	detail::print("anchor-pulse-lvgl: perf", detail::window, now_ms - detail::window_started_ms);
	detail::window = Perf{};
	detail::window_started_ms = now_ms;
#else
	(void)now_ms;
#endif
}

}  // namespace pulse_perf

#endif /* ANCHOR_PULSE_PERF_H */
