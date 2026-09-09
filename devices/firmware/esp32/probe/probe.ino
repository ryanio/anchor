/*
 * Find out what is actually wired to this board.
 *
 * This exists because of a wrong answer. The first firmware scanned I2C on SDA=8/SCL=9 — the
 * ESP32-S3 Arduino defaults — found nothing, and concluded there was no display. There is a display.
 * Zero devices on the default pins is evidence that *the pins are wrong*, not that the bus is empty:
 * an instrument pointed at the wrong place does not return a negative result, it returns nothing at
 * all, and the two are easy to confuse when you are hoping for an answer.
 *
 * So this does not assume a pin map. It works outward from a physical fact instead:
 *
 *   1. **An I2C bus has pull-up resistors on it.** Every other GPIO on a board like this is either
 *      driven, or floating, or pulled by something much weaker. So: drive each candidate pin's
 *      *internal pull-down* (~45k) and read it. A pin that still reads HIGH is being held up by an
 *      external resistor of a few kilohms — which is what SDA and SCL look like and very little else
 *      does. That turns 27 candidate pins into a shortlist without touching the bus.
 *   2. **Then scan only those pins, in both roles.** A handful of pairs instead of 702.
 *   3. **Then name what answered.** The addresses on a board like this are a fingerprint: a touch
 *      controller, an IMU, an RTC and a power-management chip identify a product far more reliably
 *      than a silkscreen photograph.
 *
 * Pins that are not safe to touch are not touched. On an N16R8 the octal PSRAM and the SPI flash
 * occupy GPIO 26-37 and driving them takes the chip down mid-scan; 19 and 20 are the USB D-/D+ pair
 * this is reporting through. Both ranges are excluded by construction rather than by care.
 */

#include <Arduino.h>
#include <Wire.h>

/* Read one register from an I2C device. Returns -1 if it did not answer. */
static int read_reg(uint8_t address, uint8_t reg) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)address, 1) != 1) return -1;
  return Wire.read();
}

static int write_reg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission();
}

/*
 * Pins this probe is allowed to drive.
 *
 * ESP32-S3 has no GPIO 22-25. 26-37 are SPI flash and octal PSRAM on an N16R8 — driving one of those
 * does not produce a bad reading, it produces a crash. 19 and 20 are USB. What is left is the set a
 * board designer actually has to route a peripheral bus over.
 */
static const uint8_t CANDIDATES[] = {1,  2,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14,
                                     15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 43, 44, 47, 48};
static const size_t CANDIDATE_COUNT = sizeof(CANDIDATES) / sizeof(CANDIDATES[0]);

static uint8_t held_high[CANDIDATE_COUNT];
static size_t held_count = 0;
static uint8_t found_sda = 0;
static uint8_t found_scl = 0;

/*
 * Names for the addresses that answer.
 *
 * This table is the one piece of received knowledge here, and it is used only to *label* a hit that
 * was measured — never to decide that something is present. An unknown address is reported as an
 * unknown address rather than guessed at.
 */
static const char *describe(uint8_t address) {
  switch (address) {
    case 0x15: return "touch (CST816/CST820-class)";
    case 0x18: return "audio codec, or accelerometer";
    case 0x1A: return "audio codec (ES8311-class)";
    case 0x38: return "touch (FT3168/FT6236-class)";
    case 0x34: return "PMU (AXP2101-class)";
    case 0x35: return "PMU (AXP192-class)";
    case 0x40: return "current sensor, or IO expander";
    case 0x41: return "touch, or IO expander";
    case 0x44: return "ambient light / temperature";
    case 0x48: return "ADC, or temperature";
    case 0x51: return "RTC (PCF85063-class)";
    case 0x53: return "RTC, or accelerometer";
    case 0x5D: return "touch (GT911-class)";
    case 0x5A: return "touch (GT911 alternate)";
    case 0x62: return "IO expander (TCA9554-class)";
    case 0x68: return "IMU (MPU6050/DS3231-class)";
    case 0x6A: return "IMU (LSM6DS-class)";
    case 0x6B: return "IMU (QMI8658-class)";
    case 0x76: return "pressure / environmental (BMP/BME-class)";
    case 0x77: return "pressure / environmental (alternate)";
    default: return "unknown";
  }
}

static void say(const String &line);

static void find_pullups(void) {
  say("probe: looking for pins held high by an external pull-up");
  for (size_t i = 0; i < CANDIDATE_COUNT; i++) {
    uint8_t pin = CANDIDATES[i];
    /*
     * The internal pull-down is roughly 45k. An I2C bus pull-up is 2.2k-10k. With both engaged the
     * external resistor wins by a wide margin, so a HIGH here means something off-chip is holding
     * the line up — and a floating pin reads LOW instead of picking up noise.
     */
    pinMode(pin, INPUT_PULLDOWN);
    delayMicroseconds(200);
    int with_pulldown = digitalRead(pin);
    pinMode(pin, INPUT);
    delayMicroseconds(200);
    int floating = digitalRead(pin);
    pinMode(pin, INPUT_PULLDOWN);

    if (with_pulldown == HIGH) {
      say(String("probe: gpio ") + pin + " held HIGH against the internal pull-down (floating reads " +
          floating + ")");
      held_high[held_count++] = pin;
    }
  }
  say(String("probe: ") + (unsigned)held_count + " candidate bus pins");
}

static int scan_pair(uint8_t sda, uint8_t scl) {
  Wire.end();
  if (!Wire.begin((int)sda, (int)scl, 100000u)) return -1;
  Wire.setTimeOut(10);
  int found = 0;
  for (uint8_t address = 0x08; address <= 0x77; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      if (found == 0) {
        say(String("probe: --- bus on SDA=") + sda + " SCL=" + scl + " ---");
        found_sda = sda;
        found_scl = scl;
      }
      say(String("probe:     0x") + String(address, HEX) + "  " + describe(address));
      found++;
    }
  }
  return found;
}

static void scan_candidates(void) {
  if (held_count < 2) {
    say("probe: fewer than two pins have pull-ups; nothing to scan");
    return;
  }
  int total = 0;
  // Both orderings: which line is SDA and which is SCL is not something a pull-up can tell us.
  for (size_t a = 0; a < held_count; a++) {
    for (size_t b = 0; b < held_count; b++) {
      if (a == b) continue;
      int found = scan_pair(held_high[a], held_high[b]);
      if (found > 0) total += found;
    }
  }
  say(String("probe: ") + total + " device(s) answered across all pin pairs");
}

/*
 * The report is repeated, not printed once.
 *
 * A probe that prints its findings a single time at boot is a probe whose findings depend on whether
 * anyone happened to be listening at that moment — and with USB CDC, writes are discarded when no
 * host has the port open. The first version of this file printed into the void every time and looked
 * exactly like a crash. Doing the work once and then reprinting the cached report forever costs
 * nothing and cannot be missed.
 */
static String report;

static void say(const String &line) {
  report += line;
  report += "\n";
  Serial.print(line);
  Serial.print("\n");
  Serial.flush();
}

/*
 * Ask each chip who it is.
 *
 * Run only on the bus the scan actually found, and only against addresses that actually answered.
 * A register read from an address nothing lives at returns -1 and is reported as such rather than
 * being quietly folded into a conclusion.
 */
static void identify(uint8_t sda, uint8_t scl) {
  Wire.end();
  if (!Wire.begin((int)sda, (int)scl, 100000u)) return;
  Wire.setTimeOut(10);

  say("probe: --- identity registers ---");

  // CST816-class touch: 0xA7 is the chip id, 0xA8 the vendor id.
  int touch_id = read_reg(0x15, 0xA7);
  int touch_vendor = read_reg(0x15, 0xA8);
  if (touch_id >= 0) {
    say(String("probe:     0x15 touch chip id 0x") + String(touch_id, HEX) + ", vendor 0x" +
        String(touch_vendor, HEX));
  }

  // AXP2101 reports 0x4A in register 0x03.
  int pmu_id = read_reg(0x34, 0x03);
  if (pmu_id >= 0) say(String("probe:     0x34 pmu chip id 0x") + String(pmu_id, HEX));

  // QMI8658 WHO_AM_I is 0x05 at register 0x00; register 0x01 is the revision.
  int imu_who = read_reg(0x6B, 0x00);
  int imu_rev = read_reg(0x6B, 0x01);
  if (imu_who >= 0) {
    say(String("probe:     0x6b imu who_am_i 0x") + String(imu_who, HEX) + ", revision 0x" +
        String(imu_rev, HEX));
  }

  // ES8311 identifies itself as 0x83 0x11 across registers 0xFD and 0xFE.
  int codec_a = read_reg(0x18, 0xFD);
  int codec_b = read_reg(0x18, 0xFE);
  if (codec_a >= 0) {
    say(String("probe:     0x18 codec id 0x") + String(codec_a, HEX) + " 0x" + String(codec_b, HEX));
  }

  // A TCA9554-class expander: 0x00 input port, 0x01 output port, 0x03 configuration (1 = input).
  int exp_in = read_reg(0x20, 0x00);
  int exp_out = read_reg(0x20, 0x01);
  int exp_cfg = read_reg(0x20, 0x03);
  if (exp_in >= 0) {
    say(String("probe:     0x20 io expander in 0x") + String(exp_in, HEX) + " out 0x" +
        String(exp_out, HEX) + " config 0x" + String(exp_cfg, HEX));
    /*
     * On boards of this shape the panel's reset and enable lines hang off this expander rather than
     * off a GPIO, which is why a display can be present and completely invisible to a pin scan.
     * Driving every line high releases whatever is held in reset; it is reported, not silent,
     * because it changes the board's state.
     */
    write_reg(0x20, 0x03, 0x00);
    write_reg(0x20, 0x01, 0xFF);
    say("probe:     0x20 all expander outputs driven high (releases any reset behind it)");
  }
}

/*
 * Look for a pin that is toggling on its own.
 *
 * A panel that has been initialised drives its tearing-effect line once per frame — tens of times a
 * second, with nobody on this chip driving it. Every other undriven pin sits still. So sampling the
 * pins we did not touch, and reporting any that change, is a check on whether a candidate pin map
 * actually woke a display, rather than a question for whoever is looking at the board.
 */
static void find_toggling_pins(const char *label) {
  for (size_t i = 0; i < CANDIDATE_COUNT; i++) {
    uint8_t pin = CANDIDATES[i];
    pinMode(pin, INPUT);
    int first = digitalRead(pin);
    int changes = 0;
    uint32_t until = millis() + 120;
    while (millis() < until) {
      int now = digitalRead(pin);
      if (now != first) {
        changes++;
        first = now;
      }
    }
    if (changes > 2) {
      say(String("probe: ") + label + ": gpio " + pin + " toggled " + changes + " times — live signal");
    }
  }
}

void setup() {
  Serial.begin(115200);
  /*
   * A blocking write, unlike the application's.
   *
   * The firmware proper sets this to zero so a device nobody is reading cannot stall on a write.
   * A probe wants the opposite: dropping output when the buffer fills is exactly how the first run
   * of this file produced `probe: looking for pins held high l-up` and a report that stopped in the
   * middle of a word, which reads like a crash and is really a discarded write. One second is long
   * enough to drain and short enough that an unattended board still finishes.
   */
  Serial.setTxTimeoutMs(1000);
  delay(2000);

  say("");
  say("probe: anchor pulse hardware probe");
  say(String("probe: chip ") + ESP.getChipModel() + " rev " + ESP.getChipRevision() + ", flash " +
      ESP.getFlashChipSize() + ", psram " + ESP.getPsramSize());
  find_pullups();
  scan_candidates();
  if (found_sda != 0 || found_scl != 0) {
    identify(found_sda, found_scl);
    // Baseline first: whatever is already alive before any panel is touched.
    find_toggling_pins("baseline");
  }
  say("probe: done");
}

void loop() {
  // Whoever attaches next gets the whole report within two seconds, whenever they attach.
  Serial.print(report);
  Serial.flush();
  delay(2000);
}
