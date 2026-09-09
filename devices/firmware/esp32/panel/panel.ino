/*
 * Wake the panel, and prove it woke.
 *
 * The board is a Waveshare ESP32-S3-Touch-AMOLED-1.8, V2 hardware: a CO5300 controller behind a
 * 368x448 AMOLED, with a CST820 touch controller on the same I2C bus as an AXP2101, an ES8311, a
 * PCF85063 and a QMI8658. The V1 revision of the same product is an SH8601 with an FT3168, which is
 * why the touch controller's identity register was worth reading — it names the hardware revision,
 * and the revision names the display driver.
 *
 * Two things the pin map settles that a sweep could not:
 *
 *   - **The bus is CS=12, SCK=11, D0-D3 = 4, 5, 6, 7.** That combination was inside the first sweep's
 *     search space and the sweep still failed to wake the panel, which was the clue that the problem
 *     was never the pins.
 *   - **There is no reset pin.** The vendor's own example passes `GFX_NOT_DEFINED` for it. So the
 *     earlier guess — that a swept pin had left the panel held in reset — was wrong. What actually
 *     happened is simpler: a sweep sent SLPIN on the real bus and put the controller to sleep, and
 *     the wake attempt afterwards allowed 60ms where a CO5300 needs 120ms after sleep-out before it
 *     will accept another command. The panel was never broken. It was asleep, and being woken too
 *     impatiently to notice.
 *
 * This sketch does the full initialisation rather than a bare sleep-out, because that is the thing
 * that is certain to work from any state, and it reports whether the tearing-effect line on GPIO 13
 * came back — a measurement rather than a request to go and look at the desk.
 */

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

/* From the vendor's `pin_config.h` for arduino-v2 (V2 hardware), not from memory. */
#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define LCD_WIDTH 368
#define LCD_HEIGHT 448
#define TE_PIN 13

Arduino_DataBus *bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2,
                                             LCD_SDIO3);

/*
 * The 16 is a column offset, and it is the vendor's, not a guess. A CO5300 addresses a wider frame
 * than this panel exposes, so the visible window starts sixteen columns in; getting it wrong shifts
 * every pixel sideways and wraps the right-hand edge.
 */
Arduino_CO5300 *gfx = new Arduino_CO5300(bus, GFX_NOT_DEFINED /* RST */, 0 /* rotation */, LCD_WIDTH,
                                         LCD_HEIGHT, 16, 0, 0, 0);

static String report;

static void say(const String &line) {
  report += line;
  report += "\n";
  Serial.print(line);
  Serial.print("\n");
  Serial.flush();
}

/* Transitions on the tearing line over a window. Zero means nothing is refreshing. */
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

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(1000);
  delay(2500);

  say("");
  say("panel: waveshare esp32-s3-touch-amoled-1.8 (v2), CO5300 368x448");
  say(String("panel: tearing activity before init: ") + te_activity(150));

  if (!gfx->begin()) {
    say("panel: gfx->begin() failed");
  } else {
    say("panel: gfx->begin() ok");
  }

  gfx->setBrightness(180);

  /*
   * Turn the tearing line back on, because the oracle was switched off rather than the panel.
   *
   * The original 58 Hz signal came from whatever firmware shipped on the board, which had enabled
   * it. Arduino_GFX's init does not, so after a fresh `begin()` the line sits still whether or not
   * the panel is refreshing — and reading that stillness as "still dark" would be the same mistake
   * as reading an empty I2C scan on the wrong pins as "no display". `0x35` with parameter 0 is
   * tearing-effect on, V-blank only.
   */
  bus->beginWrite();
  bus->writeC8D8(0x35, 0x00);
  bus->endWrite();
  delay(50);
  say(String("panel: tearing enabled, activity now ") + te_activity(300));

  /*
   * Three flat fills, a second apart. Flat colour is the right first frame: it needs no font and no
   * layout, so anything wrong with it is wrong with the bus or the offsets rather than with drawing.
   */
  gfx->fillScreen(RGB565_RED);
  say(String("panel: red, tearing activity ") + te_activity(300));
  delay(700);
  gfx->fillScreen(RGB565_GREEN);
  say(String("panel: green, tearing activity ") + te_activity(300));
  delay(700);
  gfx->fillScreen(RGB565_BLUE);
  say(String("panel: blue, tearing activity ") + te_activity(300));
  delay(700);

  // Something with structure, so the geometry and the column offset can be judged and not assumed.
  gfx->fillScreen(RGB565_BLACK);
  gfx->drawRect(0, 0, LCD_WIDTH, LCD_HEIGHT, RGB565_WHITE);
  gfx->drawRect(1, 1, LCD_WIDTH - 2, LCD_HEIGHT - 2, RGB565_WHITE);
  gfx->fillRect(0, 0, 20, 20, RGB565_RED);                              // top left
  gfx->fillRect(LCD_WIDTH - 20, 0, 20, 20, RGB565_GREEN);               // top right
  gfx->fillRect(0, LCD_HEIGHT - 20, 20, 20, RGB565_BLUE);               // bottom left
  gfx->fillRect(LCD_WIDTH - 20, LCD_HEIGHT - 20, 20, 20, RGB565_YELLOW); // bottom right
  gfx->setCursor(24, 40);
  gfx->setTextColor(RGB565_WHITE);
  gfx->setTextSize(2);
  gfx->println("anchor");

  int after = te_activity(300);
  say(String("panel: border and corners drawn, tearing activity ") + after);
  say(after > 2 ? "panel: AWAKE — the controller is refreshing again"
                : "panel: still quiet — the panel is not refreshing");
  say("panel: done");
}

void loop() {
  Serial.print(report);
  Serial.flush();
  delay(4000);
}
