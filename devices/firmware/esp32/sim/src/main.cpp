/*
 * The driver: this firmware's own `setup()` and `loop()`, on a desktop, with a scripted finger.
 *
 * What is real here is everything above the four shim headers — `app.ino` in full, `wifi_setup.cpp`
 * in full, and `src/anchor_pulse.c`, the same C the board runs. What is simulated is the ring
 * around it: a clock that is counted rather than measured, a cable the scenario decides is plugged
 * in or not, a radio that answers on a schedule, and a finger that lands where an argument says.
 *
 * The interface is the Cardputer simulator's, because it is already the one an agent in this repo
 * knows: `--shot` writes a frame before every scripted input, `--quit-after` ends the run, and the
 * whole session fits in one command line so a UI change can be looked at without a board, a cable,
 * or a person standing in front of a desk.
 *
 *   program --taps "184,120 300,300" --shot /tmp/pulse --quit-after 12000
 *
 * Every frame is also described in words as it is written — the text the panel is holding, where,
 * and whether any of it ran off an edge — because the cheapest way to find a layout bug in a
 * headless run is to read what the panel says rather than to open eight PPMs.
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

/* `app.ino` is compiled as itself — see `app_ino.cpp` — and these are the two it owes any host. */
void setup();
void loop();
/* The panel object lives in `app.ino`; the harness needs it to photograph what was drawn. */
extern Arduino_CO5300 *simPanel();

namespace {

struct Step {
  enum class Kind { Tap, Swipe, Wait } kind = Kind::Wait;
  int16_t a = 0;
  int16_t b = 0;
};

std::vector<Step> script;
std::string shot_prefix;
std::string feed_path;
std::string out_path;
uint32_t gap_ms = 400;
/*
 * How long before the first scripted step.
 *
 * It defaults to a scan's worth of time rather than one gap, because a tap delivered before the
 * screen exists is not a tap the firmware has any reason to answer, and a scenario whose first
 * touch lands in `GRACE_MS` looks exactly like a state machine that ignored it. That mistake is
 * cheap to make and expensive to read, so the default avoids it and `--lead` is there for anyone
 * who wants to aim at the grace period deliberately.
 */
uint32_t lead_ms = 7000;
uint32_t quit_after_ms = 0;
bool host_linked = false;
bool quiet = false;
int shot_index = 0;

void describe(FILE *to) {
  Arduino_CO5300 *panel = simPanel();
  fprintf(to, "  panel %dx%d  brightness %u/255%s\n", (int)panel->simWidth(),
          (int)panel->simHeight(), (unsigned)panel->simBrightness(),
          panel->simBrightness() == 0 ? "  (dark: nothing is visible on the glass)" : "");
  for (const GfxTextDraw &draw : panel->simText()) {
    const int right = draw.x + (int)draw.text.size() * 6 * draw.size;
    fprintf(to, "    text  (%3d,%3d) size %u  right edge %4d  \"%s\"%s%s\n", (int)draw.x, (int)draw.y,
            (unsigned)draw.size, right, draw.text.c_str(),
            right > panel->simWidth() ? "  << PAST THE RIGHT EDGE" : "",
            draw.wrapped ? "  << WRAPPED ONTO THE NEXT LINE" : "");
  }
}

void capture() {
  Arduino_CO5300 *panel = simPanel();
  printf("frame %02d  t=%ums\n", shot_index, (unsigned)millis());
  describe(stdout);
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

void parseNetworks(const char *spec) {
  std::vector<SimNetwork> nets;
  std::string text(spec);
  size_t at = 0;
  while (at <= text.size()) {
    const size_t comma = text.find(',', at);
    const std::string entry = text.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
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
      step.kind = Step::Kind::Tap;
      step.a = (int16_t)x;
      step.b = (int16_t)y;
      script.push_back(step);
    }
    if (end == std::string::npos) break;
    at = end + 1;
  }
}

void usage() {
  printf(
      "anchor pulse simulator\n"
      "  --taps \"X,Y X,Y\"   scripted taps, one every --gap ms\n"
      "  --tap X,Y           one more tap on the end of the script\n"
      "  --wait              a script slot that taps nothing (a frame of whatever happens next)\n"
      "  --swipe FROM,TO     a scripted swipe in panel x\n"
      "  --gap MS            time between scripted steps (default 400)\n"
      "  --lead MS           time before the first step (default 7000: a grace period and a scan)\n"
      "  --shot PREFIX       write PREFIX-NN.ppm before every step and once at the end\n"
      "  --quit-after MS     stop this long after setup() returned\n"
      "  --networks \"A:-40,B:-70:open\"  what a scan finds, strongest first is not assumed\n"
      "  --saved SSID:PASS   a unit that already has a network in NVS\n"
      "  --nvs PATH          where that store lives (default sim-nvs-pulse.txt)\n"
      "  --scan-ms MS        how long a scan takes (default 1200)\n"
      "  --connect-ms MS     how long a join takes to resolve (default 2000)\n"
      "  --join-fail         every join fails, whatever was typed\n"
      "  --host              a host is on the cable\n"
      "  --feed FILE         protocol bytes to hand the decoder (implies --host)\n"
      "  --out FILE          everything the device wrote back\n"
      "  --no-psram          refuse the SPIRAM allocation, to exercise the fallback panel\n"
      "  --quiet             do not print the boot banner\n");
}

}  // namespace

int main(int argc, char **argv) {
  std::string saved_ssid;
  std::string saved_pass;
  bool have_saved = false;

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
    } else if (strcmp(arg, "--swipe") == 0 && more) {
      int from = 0;
      int to = 0;
      if (sscanf(argv[++i], "%d,%d", &from, &to) == 2) {
        Step step;
        step.kind = Step::Kind::Swipe;
        step.a = (int16_t)from;
        step.b = (int16_t)to;
        script.push_back(step);
      }
    } else if (strcmp(arg, "--wait") == 0) {
      script.push_back(Step{});
    } else if (strcmp(arg, "--lead") == 0 && more) {
      lead_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
    } else if (strcmp(arg, "--gap") == 0 && more) {
      gap_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
    } else if (strcmp(arg, "--shot") == 0 && more) {
      shot_prefix = argv[++i];
    } else if (strcmp(arg, "--quit-after") == 0 && more) {
      quit_after_ms = (uint32_t)strtoul(argv[++i], nullptr, 10);
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
    } else if (strcmp(arg, "--host") == 0) {
      host_linked = true;
    } else if (strcmp(arg, "--feed") == 0 && more) {
      feed_path = argv[++i];
      host_linked = true;
    } else if (strcmp(arg, "--out") == 0 && more) {
      out_path = argv[++i];
    } else if (strcmp(arg, "--no-psram") == 0) {
      simSetPsram(false);
    } else if (strcmp(arg, "--quiet") == 0) {
      quiet = true;
    } else {
      printf("sim: unknown argument %s\n", arg);
      usage();
      return 2;
    }
  }

  if (have_saved) {
    // Written before `setup()` runs, so this is a unit that was provisioned on some earlier boot
    // rather than one that is handed a credential mid-flight.
    Preferences prefs;
    prefs.begin("anchor-wifi", false);
    prefs.putString("ssid", String(saved_ssid.c_str()));
    prefs.putString("pass", String(saved_pass.c_str()));
    prefs.end();
  }

  if (!feed_path.empty()) {
    FILE *in = fopen(feed_path.c_str(), "rb");
    if (in == nullptr) {
      printf("sim: cannot read %s\n", feed_path.c_str());
      return 2;
    }
    std::string bytes;
    char chunk[4096];
    size_t got = 0;
    while ((got = fread(chunk, 1, sizeof(chunk), in)) > 0) bytes.append(chunk, got);
    fclose(in);
    // Fed after `setup()` so the handshake happens in the order a real host produces it: the device
    // says HELLO into a connected port first, and READY arrives afterwards.
    Serial.simConnect(true);
    setup();
    Serial.simFeed((const uint8_t *)bytes.data(), bytes.size());
    printf("sim: fed %u bytes of protocol\n", (unsigned)bytes.size());
  } else {
    Serial.simConnect(host_linked);
    setup();
  }

  if (!quiet) {
    printf("--- boot banner ---\n%s-------------------\n", Serial.simText().c_str());
  }

  const uint32_t started = millis();
  const uint32_t script_ms = lead_ms + (uint32_t)(script.size() + 1) * gap_ms;
  if (quit_after_ms == 0) quit_after_ms = script_ms + 6000;

  size_t next_step = 0;
  uint32_t next_at = started + lead_ms;
  bool captured_tail = false;

  for (;;) {
    if (millis() >= next_at && next_step <= script.size()) {
      // A frame *before* the input, which is the Cardputer simulator's order and the useful one:
      // the picture somebody was looking at when they decided to touch that spot.
      capture();
      if (next_step < script.size()) {
        const Step &step = script[next_step];
        if (step.kind == Step::Kind::Tap) {
          printf("  tap   (%d,%d)\n", (int)step.a, (int)step.b);
          sensors::simQueueTap(step.a, step.b);
        } else if (step.kind == Step::Kind::Swipe) {
          printf("  swipe %d -> %d\n", (int)step.a, (int)step.b);
          sensors::simQueueSwipe(step.a, step.b);
        } else {
          printf("  wait\n");
        }
      }
      next_step++;
      next_at = millis() + gap_ms;
    }

    loop();
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
  const auto &attempts = WiFi.simAttempts();
  for (const auto &attempt : attempts) {
    printf("sim: WiFi.begin(\"%s\", \"%s\") at t=%ums\n", attempt.ssid.c_str(), attempt.pass.c_str(),
           (unsigned)attempt.at);
  }
  {
    Preferences prefs;
    prefs.begin("anchor-wifi", true);
    const String ssid = prefs.getString("ssid", "");
    const String pass = prefs.getString("pass", "");
    prefs.end();
    printf("sim: NVS holds ssid=\"%s\" pass=\"%s\"\n", ssid.c_str(), pass.c_str());
  }
  if (!out_path.empty()) {
    FILE *out = fopen(out_path.c_str(), "wb");
    if (out != nullptr) {
      fwrite(Serial.simFromDevice().data(), 1, Serial.simFromDevice().size(), out);
      fclose(out);
      printf("sim: wrote %u bytes from the device to %s\n",
             (unsigned)Serial.simFromDevice().size(), out_path.c_str());
    }
  }
  return 0;
}
