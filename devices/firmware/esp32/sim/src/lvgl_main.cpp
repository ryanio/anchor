/*
 * The driver for the LVGL firmware: `pulse/`'s own `setup()` and `loop()`, on a desktop, with a
 * scripted finger and a camera.
 *
 * `main.cpp` does this for the blitter. This is the same harness pointed at the other firmware, and
 * the reason it is worth having at all is narrower and sharper than "a simulator is nice": **LVGL
 * work without one costs a flash-and-squint per change.** A layout is a hundred small decisions —
 * is that gap right, does that number clear that label, is the footer too loud — and each of them
 * costs a two-minute `arduino-cli compile`, a flash, a walk to the desk and a squint, on a board
 * somebody is using. Here it costs one command and a PNG you can open.
 *
 *   sim/lvgl.sh --shot /tmp/pulse --quit-after 4000
 *   sim/lvgl.sh --taps "184,120 300,300" --shot /tmp/pulse
 *
 * What is real: `pulse.ino` in full, `pulse_ui.cpp` in full, and LVGL 9.2.2 itself compiled against
 * the same `pulse/lv_conf.h` the board build uses — the same fonts, the same colour depth, the same
 * renderer. The flush callback is the firmware's own; it lands in `Arduino_CO5300`, which here is a
 * 368x448 RGB565 framebuffer that can write itself out as a PPM. What is simulated is the ring
 * around it: a counted clock, a panel with no glass, and a finger that lands where an argument says.
 *
 * Every frame is also described in words as it is written — every label LVGL is holding, its text,
 * its box, and whether it has run outside its parent — because the cheapest way to find a layout
 * bug in a headless run is to read what the screen says, and because a diff of that description is
 * a regression test somebody can actually write.
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "Arduino.h"
#include "Arduino_GFX_Library.h"
#include "Preferences.h"
#include "WiFi.h"
#include "esp_heap_caps.h"
#include "sim_touch.h"

#include "lvgl.h"

#include "pulse_ui.h"
#include "pulse_wifi.h"

/* `feed_sim.cpp`'s scenario selector. Declared rather than included because `feed.h` wants
 * Arduino types this file does not otherwise need. */
namespace feed {
void simScenario(const char *name);
}  // namespace feed

/* `pulse.ino` is compiled as itself — see `pulse_ino.cpp` — and these are what it owes any host. */
void setup();
void loop();
extern Arduino_CO5300 *simPanel();

namespace {

struct Step {
  int16_t x = 0;
  int16_t y = 0;
  bool touch = false;
  /* 0 is `pulse_touch_sim.cpp`'s default tap. Anything else is a hold, which is how a gesture
   * defined by duration — `pulse_wifi`'s 1.4 s way back into setup — gets driven at all. */
  uint32_t hold_ms = 0;
};

std::vector<Step> script;
std::string shot_prefix;
uint32_t gap_ms = 1200;
/*
 * How long before the first scripted step. Two refresh periods would be enough to get a frame on
 * the panel, but the footer counts in whole seconds and a screenshot taken at t=100ms photographs
 * the boot state rather than the resting one — which is the picture somebody wants to look at.
 */
uint32_t lead_ms = 1500;
uint32_t quit_after_ms = 0;
bool quiet = false;
int shot_index = 0;

/*
 * What the screen says, read out of LVGL's own object tree.
 *
 * Not out of the framebuffer, and not out of a text log the way `gfx_sim.cpp` keeps one for
 * `Arduino_GFX`'s `print()` — LVGL does not draw through that path at all, it renders glyphs into
 * pixels. So the tree is the honest source: `lv_label_get_text` is the string the widget is holding,
 * and `lv_obj_get_x/y/width/height` is the box it resolved to after styles and alignment. A layout
 * bug is almost always one of those two disagreeing with what was intended.
 *
 * The check it performs is the one that matters on a fixed-size panel: a box that pokes outside its
 * parent. LVGL will clip it silently and the render will simply be missing a digit.
 */
void describeTree(lv_obj_t *obj, int depth, lv_obj_t *root) {
  const int32_t x = lv_obj_get_x(obj);
  const int32_t y = lv_obj_get_y(obj);
  const int32_t w = lv_obj_get_width(obj);
  const int32_t h = lv_obj_get_height(obj);

  std::string indent((size_t)depth * 2 + 4, ' ');
  const bool is_label = lv_obj_check_type(obj, &lv_label_class);
  const char *text = is_label ? lv_label_get_text(obj) : nullptr;

  std::string warn;
  if (obj != root) {
    lv_obj_t *parent = lv_obj_get_parent(obj);
    if (parent != nullptr) {
      if (x < 0 || y < 0) warn += "  << STARTS OUTSIDE ITS PARENT";
      if (x + w > lv_obj_get_width(parent)) warn += "  << PAST ITS PARENT'S RIGHT EDGE";
      if (y + h > lv_obj_get_height(parent)) warn += "  << PAST ITS PARENT'S BOTTOM EDGE";
    }
  }

  if (is_label) {
    printf("%s%-6s (%3d,%3d) %3dx%-3d  \"%s\"%s\n", indent.c_str(), "label", (int)x, (int)y, (int)w,
           (int)h, text == nullptr ? "" : text, warn.c_str());
  } else {
    printf("%s%-6s (%3d,%3d) %3dx%-3d%s\n", indent.c_str(), obj == root ? "screen" : "obj", (int)x,
           (int)y, (int)w, (int)h, warn.c_str());
  }

  const uint32_t children = lv_obj_get_child_count(obj);
  for (uint32_t i = 0; i < children; i++) {
    describeTree(lv_obj_get_child(obj, i), depth + 1, root);
  }
}

void describe() {
  Arduino_CO5300 *panel = simPanel();
  printf("  panel %dx%d  brightness %u/255%s\n", (int)panel->simWidth(), (int)panel->simHeight(),
         (unsigned)panel->simBrightness(),
         panel->simBrightness() == 0 ? "  (dark: nothing is visible on the glass)" : "");
  lv_obj_t *screen = lv_screen_active();
  if (screen != nullptr) describeTree(screen, 0, screen);
}

void capture() {
  Arduino_CO5300 *panel = simPanel();
  printf("frame %02d  t=%ums\n", shot_index, (unsigned)millis());
  describe();
  if (shot_prefix.empty()) {
    shot_index++;
    return;
  }
  char path[512];
  snprintf(path, sizeof(path), "%s-%02d.ppm", shot_prefix.c_str(), shot_index++);
  if (!panel->simWritePpm(path)) {
    printf("sim: could not write %s\n", path);
    return;
  }
  printf("  wrote %s\n", path);
}

void parseTaps(const char *spec) {
  std::string text(spec);
  size_t at = 0;
  while (at < text.size()) {
    while (at < text.size() && (text[at] == ' ' || text[at] == ',')) at++;
    if (at >= text.size()) break;
    const size_t end = text.find(' ', at);
    const std::string one = text.substr(at, end == std::string::npos ? std::string::npos : end - at);
    int x = 0;
    int y = 0;
    if (sscanf(one.c_str(), "%d,%d", &x, &y) == 2) {
      Step step;
      step.touch = true;
      step.x = (int16_t)x;
      step.y = (int16_t)y;
      script.push_back(step);
    }
    if (end == std::string::npos) break;
    at = end + 1;
  }
}

/*
 * `--networks "A:-40,B:-70:open"`, the same spelling `main.cpp` uses for the blitter's harness.
 *
 * Copied in shape rather than factored out: the two drivers are two `main()`s that happen to agree
 * about one flag, and a shared parser would be a header between them for eleven lines. The spelling
 * matters more than the code — a scenario written for one harness should read the same in the other,
 * because the thing being compared is the two firmwares' behaviour.
 *
 * `strongest first is not assumed`: the order here is the order the radio reports, deliberately
 * unsorted, so that a picker claiming to sort has something to prove.
 */
void parseNetworks(const char *spec) {
  std::vector<SimNetwork> nets;
  std::string text(spec);
  size_t at = 0;
  while (at <= text.size()) {
    const size_t comma = text.find(',', at);
    const std::string entry =
        text.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
    if (!entry.empty()) {
      SimNetwork net;
      const size_t first = entry.find(':');
      net.ssid = entry.substr(0, first);
      if (first != std::string::npos) {
        const size_t second = entry.find(':', first + 1);
        net.rssi = (int32_t)strtol(entry.substr(first + 1, second - first - 1).c_str(), nullptr, 10);
        if (second != std::string::npos) net.open = entry.substr(second + 1) == "open";
      }
      nets.push_back(net);
    }
    if (comma == std::string::npos) break;
    at = comma + 1;
  }
  WiFi.simSetNetworks(nets);
}

void usage() {
  printf(
      "anchor pulse LVGL simulator\n"
      "  --taps \"X,Y X,Y\"   scripted touches, one every --gap ms, each held 160ms\n"
      "  --feed <state>     live|one|no-credentials|joining|fetching|disabled|failed|stale\n"
      "  --tap X,Y           one more touch on the end of the script\n"
      "  --hold X,Y[,MS]     a touch held (default 1600ms), for duration gestures\n"
      "  --wait              a script slot that touches nothing (a frame of whatever happens next)\n"
      "  --gap MS            time between scripted steps (default 1200)\n"
      "  --lead MS           time before the first step (default 1500)\n"
      "  --shot PREFIX       write PREFIX-NN.ppm before every step and once at the end\n"
      "  --quit-after MS     stop this long after setup() returned\n"
      "  --wifi              wire pulse_wifi in, as pulse.ino will (begin/tick/hold gesture)\n"
      "  --networks \"A:-40,B:-70:open\"  what a scan finds; strongest first is not assumed\n"
      "  --saved SSID:PASS   a unit that already has a network in NVS\n"
      "  --nvs PATH          where that store lives (default sim-nvs-pulse-lvgl.txt)\n"
      "  --scan-ms MS        how long a scan takes (default 1200)\n"
      "  --connect-ms MS     how long a join takes to resolve (default 2000)\n"
      "  --join-fail         every join fails, whatever was typed\n"
      "  --open-wifi         open Wi-Fi setup immediately, as the hold gesture would\n"
      "  --no-psram          refuse the SPIRAM allocation, to exercise the smaller draw buffer\n"
      "  --quiet             do not print the boot banner\n");
}

}  // namespace

int main(int argc, char **argv) {
  std::string saved_ssid;
  std::string saved_pass;
  bool have_saved = false;
  bool wifi_wired = false;
  bool open_wifi = false;

  for (int i = 1; i < argc; i++) {
    const bool more = i + 1 < argc;
    const char *arg = argv[i];
    if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
      usage();
      return 0;
    } else if (strcmp(arg, "--taps") == 0 && more) {
      parseTaps(argv[++i]);
    } else if (strcmp(arg, "--tap") == 0 && more) {
      parseTaps(argv[++i]);
    } else if (strcmp(arg, "--hold") == 0 && more) {
      int x = 0;
      int y = 0;
      unsigned ms = 1600;
      if (sscanf(argv[++i], "%d,%d,%u", &x, &y, &ms) >= 2) {
        Step step;
        step.touch = true;
        step.x = (int16_t)x;
        step.y = (int16_t)y;
        step.hold_ms = ms;
        script.push_back(step);
      }
    } else if (strcmp(arg, "--wait") == 0) {
      script.push_back(Step{});
    } else if (strcmp(arg, "--gap") == 0 && more) {
      gap_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
    } else if (strcmp(arg, "--lead") == 0 && more) {
      lead_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
    } else if (strcmp(arg, "--shot") == 0 && more) {
      shot_prefix = argv[++i];
    } else if (strcmp(arg, "--quit-after") == 0 && more) {
      quit_after_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
    } else if (strcmp(arg, "--feed") == 0 && more) {
      feed::simScenario(argv[++i]);
    } else if (strcmp(arg, "--wifi") == 0) {
      wifi_wired = true;
    } else if (strcmp(arg, "--open-wifi") == 0) {
      wifi_wired = true;
      open_wifi = true;
    } else if (strcmp(arg, "--networks") == 0 && more) {
      parseNetworks(argv[++i]);
    } else if (strcmp(arg, "--saved") == 0 && more) {
      const std::string spec = argv[++i];
      const size_t colon = spec.find(':');
      saved_ssid = spec.substr(0, colon);
      saved_pass = colon == std::string::npos ? "" : spec.substr(colon + 1);
      have_saved = true;
    } else if (strcmp(arg, "--nvs") == 0 && more) {
      Preferences::simSetPath(argv[++i]);
    } else if (strcmp(arg, "--scan-ms") == 0 && more) {
      WiFi.simSetScanMs((uint32_t)strtoul(argv[++i], nullptr, 10));
    } else if (strcmp(arg, "--connect-ms") == 0 && more) {
      WiFi.simSetConnectMs((uint32_t)strtoul(argv[++i], nullptr, 10));
    } else if (strcmp(arg, "--join-fail") == 0) {
      WiFi.simSetJoinAlwaysFails(true);
    } else if (strcmp(arg, "--no-psram") == 0) {
      simSetPsram(0);
    } else if (strcmp(arg, "--quiet") == 0) {
      quiet = true;
    } else {
      printf("sim: unknown argument %s\n", arg);
      usage();
      return 2;
    }
  }

  /*
   * No host on the cable, ever, and that is the scenario rather than an omission: this firmware
   * exists because these units have to work with nothing plugged into them. `Serial` is still
   * connected so the banner is captured — on the board `Serial.printf` into a disconnected HWCDC is
   * discarded, and a harness that silently threw the boot log away would hide the one place
   * `lv_mem_monitor` reports what `LV_MEM_SIZE` should actually be.
   */
  if (have_saved) {
    // Written before `setup()` runs, so this is a unit provisioned on some earlier boot rather than
    // one handed a credential mid-flight.
    Preferences prefs;
    prefs.begin("anchor-wifi", false);
    prefs.putString("ssid", String(saved_ssid.c_str()));
    prefs.putString("pass", String(saved_pass.c_str()));
    prefs.end();
  }

  Serial.simConnect(true);
  setup();

  /*
   * The Wi-Fi module, wired here rather than in `pulse.ino`.
   *
   * `pulse_wifi` was written while another agent owned `pulse.ino`, so these are the exact lines
   * that go into the sketch, executed from the harness instead: `begin()` after the resting screen
   * exists, `attachOpenGesture()` on the object that screen offers as its touch surface, and
   * `tick()` once per pass. Nothing about the module's behaviour depends on which file calls them —
   * what is being driven below is `pulse_wifi.cpp` in full, against the real LVGL, the real
   * `lv_conf.h` and the firmware's own display and indev.
   *
   * It is opt-in (`--wifi`) so that every existing scenario in `README.md` renders exactly the frame
   * it rendered yesterday.
   */
  if (wifi_wired) {
    pulse_wifi::begin();
    pulse_wifi::attachOpenGesture(pulse_ui::surface());
    if (open_wifi) pulse_wifi::open();
  }

  if (!quiet) {
    printf("--- boot banner ---\n%s-------------------\n", Serial.simText().c_str());
  }

  const uint32_t started = millis();
  if (quit_after_ms == 0) quit_after_ms = lead_ms + (uint32_t)(script.size() + 1) * gap_ms + 2000;

  size_t next_step = 0;
  uint32_t next_at = started + lead_ms;
  bool captured_tail = false;

  for (;;) {
    if (millis() >= next_at && next_step <= script.size()) {
      // A frame *before* the input, which is `main.cpp`'s order and the useful one: the picture
      // somebody was looking at when they decided to touch that spot.
      capture();
      if (next_step < script.size()) {
        const Step &step = script[next_step];
        if (step.touch) {
          printf("  touch (%d,%d)%s", (int)step.x, (int)step.y, step.hold_ms == 0 ? "\n" : "");
          if (step.hold_ms != 0) printf(" held %ums\n", (unsigned)step.hold_ms);
          pulse_touch::simQueuePress(step.x, step.y, step.hold_ms);
        } else {
          printf("  wait\n");
        }
      }
      next_step++;
      next_at = millis() + gap_ms;
    }

    loop();
    if (wifi_wired) pulse_wifi::tick();
    /*
     * One millisecond per pass on top of whatever `loop()` slept.
     *
     * `pulse.ino`'s loop ends in `delay(...)`, which already advances this clock, so unlike the
     * blitter harness this is not the only thing moving time forward — it is what stops a pass that
     * happens to sleep zero from spinning. Time here is counted rather than measured, which is what
     * makes a run reproducible: the same arguments produce the same frames, byte for byte.
     */
    simAdvanceClock(1);

    if (millis() - started > quit_after_ms) {
      if (!captured_tail) {
        captured_tail = true;
        capture();
      }
      break;
    }
  }

  printf("sim: %u ms simulated, %d frames\n", (unsigned)(millis() - started), shot_index);
  if (wifi_wired) {
    /*
     * What the radio was asked to join, and what the unit ended up remembering.
     *
     * These two lines together are the check that the credential written to NVS is the credential
     * that actually associated — the second of the seven bugs is invisible in a screenshot and
     * obvious here, because a failed join that still wrote something shows as an attempt with no
     * matching success and a store that is not empty.
     */
    for (const auto &attempt : WiFi.simAttempts()) {
      printf("sim: WiFi.begin(\"%s\", \"%s\") at t=%ums\n", attempt.ssid.c_str(),
             attempt.pass.c_str(), (unsigned)attempt.at);
    }
    Preferences prefs;
    prefs.begin("anchor-wifi", true);
    const String ssid = prefs.getString("ssid", "");
    const String pass = prefs.getString("pass", "");
    prefs.end();
    printf("sim: NVS holds ssid=\"%s\" pass=\"%s\"\n", ssid.c_str(), pass.c_str());
    printf("sim: pulse_wifi::status() = \"%s\"\n", pulse_wifi::status());
  }
  {
    lv_mem_monitor_t monitor;
    lv_mem_monitor(&monitor);
    printf("sim: lv_mem %u total, %u free, %u%% used, %u%% frag\n", (unsigned)monitor.total_size,
           (unsigned)monitor.free_size, (unsigned)monitor.used_pct, (unsigned)monitor.frag_pct);
  }
  return 0;
}
