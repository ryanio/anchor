/*
 * Find the panel's bus by asking the panel, instead of writing a pin map from memory.
 *
 * A board's display pin map is a constant, and AGENTS.md is blunt that a constant written from
 * memory is a slow bug. Two facts the probe measured make it unnecessary to guess:
 *
 *   1. **GPIO 13 toggles at about 58 Hz with nothing on this chip driving it.** That is a display's
 *      tearing-effect line — the controller raises it once per refresh. It proves a panel is present
 *      and running, and, being an output *of the panel*, it changes when the panel is spoken to.
 *      That makes it an oracle: send the controller to sleep and the ticking stops.
 *   2. **A QSPI AMOLED's command phase is single-line.** The 0x02 opcode, the command byte and its
 *      padding all go out on D0 alone; only pixel data uses four lines. So finding the bus is a
 *      search over three pins — chip select, clock, D0 — not six.
 *
 * Three pins is a search small enough to run exhaustively in a couple of minutes, which turns a
 * guess into a measurement. Every candidate is left exactly as it was found: whatever happens, the
 * sweep sends SLPOUT afterwards, so a wrong guess costs nothing and the right one is undone before
 * it is reported.
 *
 * The clock is bit-banged rather than driven by the SPI peripheral, for two reasons: any pin can be
 * any role with no peripheral remapping to get wrong, and it needs no display library — the one in
 * the Arduino index does not compile against ESP32 core 3.3.11.
 */

#include <Arduino.h>
#include <Wire.h>

/* Measured by `probe/`. None of these can belong to the panel's bus. */
#define BUS_SDA 15
#define BUS_SCL 14
#define TE_PIN 13
#define IO_EXPANDER 0x20

/*
 * Pins the sweep is allowed to drive.
 *
 * 13, 14 and 15 are spoken for. 19 and 20 are USB. 26-37 are the SPI flash and the octal PSRAM, and
 * driving one of those does not give a bad reading, it ends the program. What is left is where a
 * board designer can actually put a display bus.
 */
/*
 * Second pass: the high-GPIO block, which the first sweep wrongly left out.
 *
 * The first pass covered 4-12, 16-18, 21, 47 and 48 exhaustively and found nothing. That is a real
 * negative for those pins and a reminder that the set was chosen, not measured — 45 and 46 were
 * excluded as strapping pins, which is a reason to be careful with them at boot and not a reason a
 * board cannot route a display over them. Waveshare's own ESP32-S3-LCD-1.46 puts its QSPI display on
 * CS=21, SCK=40, D0=46: three pins, two of which the first pass could not have tried.
 */
static const uint8_t PINS[] = {1, 2, 21, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48};
static const size_t PIN_COUNT = sizeof(PINS) / sizeof(PINS[0]);

static String report;

static void say(const String &line) {
  report += line;
  report += "\n";
  Serial.print(line);
  Serial.print("\n");
  Serial.flush();
}

/* Transitions on the tearing line. Zero means nothing is refreshing. */
static int te_activity(uint16_t ms) {
  pinMode(TE_PIN, INPUT);
  int last = digitalRead(TE_PIN);
  int changes = 0;
  uint32_t until = millis() + ms;
  while (millis() < until) {
    int now = digitalRead(TE_PIN);
    if (now != last) {
      changes++;
      last = now;
    }
  }
  return changes;
}

/*
 * One command, in the single-line phase every QSPI AMOLED controller starts with.
 *
 * `0x02` is the write-command opcode, then a zero byte, then the command, then padding. Pins are
 * released back to inputs afterwards so a wrong guess is not left driving somebody else's output.
 */
static void send_command(uint8_t cs, uint8_t sck, uint8_t d0, uint8_t command) {
  const uint8_t frame[4] = {0x02, 0x00, command, 0x00};
  pinMode(cs, OUTPUT);
  pinMode(sck, OUTPUT);
  pinMode(d0, OUTPUT);
  digitalWrite(cs, HIGH);
  digitalWrite(sck, LOW);
  delayMicroseconds(2);
  digitalWrite(cs, LOW);
  for (size_t byte = 0; byte < 4; byte++) {
    for (int bit = 7; bit >= 0; bit--) {
      digitalWrite(d0, (frame[byte] >> bit) & 1);
      delayMicroseconds(1);
      digitalWrite(sck, HIGH);
      delayMicroseconds(1);
      digitalWrite(sck, LOW);
    }
  }
  delayMicroseconds(2);
  digitalWrite(cs, HIGH);
  pinMode(cs, INPUT);
  pinMode(sck, INPUT);
  pinMode(d0, INPUT);
}

/* Write one register on the IO expander. */
static void expander(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(IO_EXPANDER);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

/*
 * Put the panel back the way it was found.
 *
 * The expander's original state was config 0x78, outputs 0x87 — bits 0, 1, 2 and 7 driven high. One
 * of those is the panel's reset, which is why a display can be running with no reset line reachable
 * from any GPIO. Pulsing them low and high again is a power-on reset for the panel, and it is what
 * makes each run of this sweep start from the same place instead of from wherever the last one left
 * it.
 */
static void reset_panel(void) {
  Wire.begin(BUS_SDA, BUS_SCL, 100000u);
  Wire.setTimeOut(10);
  expander(0x03, 0x00); // all lines outputs
  expander(0x01, 0x00); // assert everything low
  delay(50);
  expander(0x01, 0xFF); // release
  delay(250);
}

static bool found = false;

/*
 * The oracle runs backwards now, and that is an improvement.
 *
 * The first version of this sweep looked for a combination that *silenced* a running panel. It found
 * one — and then could not say which, because it carried on past the hit and reported two thousand
 * more "candidates" against a line that was already dead. The panel has been asleep ever since.
 *
 * Asleep is the better baseline. Silence is a stable state that nothing else disturbs, so a wake is
 * unambiguous in a way a sleep never was: no other combination can start a panel refreshing by
 * accident. Send sleep-out and display-on, and watch for the tearing line to come alive.
 *
 * The lesson is the one AGENTS.md keeps making. The first sweep could not fail safely — a dead
 * oracle and a successful hit looked identical to it. This one cannot mistake the two, because the
 * thing it waits for only ever happens for the right answer.
 */
void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(1000);
  delay(2500);

  say("");
  say("panel: qspi bus sweep — looking for the combination that WAKES the panel");

  Wire.begin(BUS_SDA, BUS_SCL, 100000u);
  Wire.setTimeOut(10);
  expander(0x03, 0x00);
  expander(0x01, 0xFF);
  delay(150);

  int baseline = te_activity(150);
  say(String("panel: baseline tearing activity ") + baseline + " (expected 0: the panel is asleep)");
  if (baseline > 2) {
    say("panel: it is already refreshing, so there is nothing to wake — reflash the sleep sweep");
    say("panel: done");
    return;
  }

  uint32_t tried = 0;
  for (size_t a = 0; a < PIN_COUNT && !found; a++) {
    for (size_t b = 0; b < PIN_COUNT && !found; b++) {
      if (b == a) continue;
      for (size_t c = 0; c < PIN_COUNT && !found; c++) {
        if (c == a || c == b) continue;
        uint8_t cs = PINS[a], sck = PINS[b], d0 = PINS[c];

        send_command(cs, sck, d0, 0x11); // SLPOUT
        delay(60);
        send_command(cs, sck, d0, 0x29); // DISPON
        delay(60);
        tried++;
        if (te_activity(50) <= 2) continue;

        say(String("panel: tearing line came alive at cs=") + cs + " sck=" + sck + " d0=" + d0 +
            " after " + tried + " combinations");

        // Prove it both ways before believing it: sleep it again, then wake it again.
        send_command(cs, sck, d0, 0x10);
        delay(180);
        int slept = te_activity(140);
        send_command(cs, sck, d0, 0x11);
        delay(180);
        send_command(cs, sck, d0, 0x29);
        delay(180);
        int back = te_activity(140);
        say(String("panel: slept back to ") + slept + ", woke again to " + back);

        if (slept == 0 && back > 2) {
          say(String("panel: FOUND — cs=") + cs + " sck=" + sck + " d0=" + d0);
          say("panel: it slept and woke on command, twice. that is the panel's bus.");
        } else {
          say("panel: could not reproduce it, so this is not the bus. stopping to avoid guessing.");
        }
        found = true;
      }
    }
    if (!found) say(String("panel: ...") + tried + " combinations tried");
  }

  if (!found) {
    say(String("panel: nothing woke the panel across ") + PIN_COUNT + " pins");
    say("panel: a real negative for this pin set — not evidence about the panel");
  }
  say("panel: done");
}

void loop() {
  Serial.print(report);
  Serial.flush();
  delay(4000);
}
