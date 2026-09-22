#pragma once

#include "pulse_feed_view.h"

// A local browser over feed snapshots. It owns its LVGL screen and copies every
// string it retains; neither radio work nor parsing belongs in this layer.
namespace pulse_explore {
using Action = void (*)();
void begin(Action openWifi);
void open();
void close();
bool active();
void update(const pulse_feed_view::Trending &trending, const pulse_feed_view::Portfolio &portfolio,
            uint32_t now);
}  // namespace pulse_explore
