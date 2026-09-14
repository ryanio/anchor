/*
 * Does a finger reach this board at all?
 *
 * `probe/` found what is on the I2C bus by identity register: a CST820 touch controller at 0x15
 * (chip 0xB7, vendor 0x41) and a QMI8658 IMU at 0x6B (WHO_AM_I 0x05). `panel/` proved the display
 * wakes. This sketch answers the remaining question, which is narrower and had resisted several
 * rounds of reading registers and hoping: when somebody puts a finger on the glass, does *anything*
 * change.
 *
 * It watches three independent things, so that a disagreement between them is itself the answer:
 *
 *   1. **TP_INT on GPIO 21**, counted in an interrupt handler. This is the measurement that cannot
 *      be confused by a wrong register map: a controller that is scanning its panel asserts this
 *      line when it has something, whatever its registers are called. If this counter moves under a
 *      finger and the registers do not, the driver is reading the wrong place. If it does not move,
 *      the controller is not detecting, and no amount of reading will help.
 *   2. **The low registers**, dumped and marked when they change, because the register a finger
 *      moves is the register a finger is in.
 *   3. **The accelerometer**, which is known to work. It is the control: a live reading beside a
 *      dead touch row proves the I2C bus is healthy and the silence belongs to the touch part.
 *
 * Everything is drawn on the panel as well as printed, because the first version of this sketch was
 * flashed over a working panel firmware, left the screen black, and asked somebody to interact with
 * a display that was showing nothing. A diagnostic that destroys the thing it is diagnosing is not
 * one.
 *
 * Two findings are already baked in here rather than left to be rediscovered:
 *
 * **The touch reset is not a GPIO.** It hangs off the TCA9554 expander at 0x20, bit 2, and no
 * firmware in this tree had ever released it — which is what a live I2C interface over a panel that
 * is never scanned looks like. The sequence below is waveshareteam's own `release_touch_reset()`
 * from the board_variant component of their ESP-IDF examples for this board.
 *
 * **Nothing here writes 0xE5.** An earlier pass read their `SLEEP_MODE` + `DEVICE_ON` enum pair as
 * "turn the device on"; the device being switched is the sleep mode, so that call means sleep on,
 * and writing it put the part to sleep, after which it answered nothing at all. Their own driver
 * notes sleep can be entered and not left. It cost a power cycle. This sketch only reads the touch
 * part.
 *
 *   arduino-cli compile --fqbn "$FQBN" sensors
 *   arduino-cli upload  --fqbn "$FQBN" -p /dev/ttyACM1 sensors
 */

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <Wire.h>

#define BUS_SDA 15
#define BUS_SCL 14

#define TOUCH_ADDR 0x15
#define TOUCH_REG_CHIP_ID 0xA7
#define TOUCH_REG_VENDOR_ID 0xA8
/* The vendor's map, from Arduino_CST816x.h in their tree for this board. */
#define TOUCH_REG_GESTURE 0x01
#define TOUCH_REG_FINGERS 0x02
#define TOUCH_REG_XH 0x03
#define TOUCH_REG_XL 0x04
#define TOUCH_REG_YH 0x05
#define TOUCH_REG_YL 0x06

/* The vendor's pin_config.h names exactly three touch related pins, and this is the third. */
#define TP_INT 21

#define EXPANDER_ADDR 0x20
#define EXPANDER_REG_OUTPUT 0x01
#define EXPANDER_REG_CONFIG 0x03
#define EXPANDER_LCD_RST (1u << 0)
#define EXPANDER_PWR_EN (1u << 1)
#define EXPANDER_TOUCH_RST (1u << 2)
#define EXPANDER_SD_CS (1u << 7)
#define EXPANDER_OUTPUTS (EXPANDER_LCD_RST | EXPANDER_PWR_EN | EXPANDER_TOUCH_RST | EXPANDER_SD_CS)

#define IMU_ADDR 0x6B
#define IMU_REG_CTRL1 0x02
#define IMU_REG_CTRL2 0x03
#define IMU_REG_CTRL7 0x08
#define IMU_REG_AX_L 0x35

#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define LCD_WIDTH 368
#define LCD_HEIGHT 448

Arduino_DataBus *bus =
    new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
/* The 16 is the vendor's column offset; panel/panel.ino says what getting it wrong looks like. */
Arduino_CO5300 *gfx =
    new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0 /* rotation */, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);

/* Written from an interrupt, read from the loop. */
static volatile uint32_t intEdges = 0;

static void IRAM_ATTR onTouchInterrupt() {
  intEdges++;
}

static int readReg(uint8_t address, uint8_t reg) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(true) != 0) return -1;
  if (Wire.requestFrom((int)address, 1) != 1) return -1;
  return Wire.read();
}

static bool writeReg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

/* waveshareteam's release_touch_reset(), delays included: theirs are for a part whose datasheet is
 * not in this tree, and shaving someone else's reset timing buys an intermittent fault. */
static bool releaseTouchReset() {
  if (!writeReg(EXPANDER_ADDR, EXPANDER_REG_CONFIG, (uint8_t)~EXPANDER_OUTPUTS)) return false;
  /*
   * Only the touch line is pulsed, and that is a deliberate departure from the vendor's sequence.
   *
   * Theirs drives every controlled line low together — touch reset, the LCD's reset and a power
   * enable — because it runs during board bring-up, before anything has initialised the display.
   * This runs *after* `gfx->begin()`, so copying it wholesale resets the display controller
   * immediately after it was configured and leaves a black panel behind. It did exactly that: the
   * screen went dark on a unit that had been painting a minute earlier.
   *
   * So the other three lines stay high throughout and only bit 2 moves. The delays are still the
   * vendor's, because they are for a part whose datasheet is not in this tree.
   */
  writeReg(EXPANDER_ADDR, EXPANDER_REG_OUTPUT, (uint8_t)(EXPANDER_OUTPUTS & ~EXPANDER_TOUCH_RST));
  delay(20);
  writeReg(EXPANDER_ADDR, EXPANDER_REG_OUTPUT, EXPANDER_OUTPUTS);
  delay(150);
  return true;
}

/*
 * The left margin is 20, not 8.
 *
 * This panel's corners are physically rounded, so the top left of the addressable framebuffer is
 * not on the glass: at x=8 the first character of a heading has its corner cut off, which is what a
 * reader reported of the T in "TOUCH TEST". The radius is not published anywhere in this tree, so
 * 20 is a margin that clears it by eye rather than a measurement, and anything that must be read is
 * kept inside it.
 */
static void line(const char *s, int y, uint16_t colour, uint8_t size = 2) {
  gfx->setTextSize(size);
  gfx->setTextColor(colour, RGB565_BLACK);
  gfx->setCursor(20, y);
  gfx->print(s);
}

void setup() {
  Serial.begin(115200);
  const uint32_t waited = millis();
  while (!Serial && millis() - waited < 2000) delay(10);

  gfx->begin();
  gfx->setBrightness(200);
  gfx->fillScreen(RGB565_BLACK);

  Wire.begin(BUS_SDA, BUS_SCL, 400000u);
  /* Bounded: an unbounded transaction that stalls looks like a frozen display, not a quiet sensor. */
  Wire.setTimeOut(20);

  const bool released = releaseTouchReset();
  const int chip = readReg(TOUCH_ADDR, TOUCH_REG_CHIP_ID);
  const int vendor = readReg(TOUCH_ADDR, TOUCH_REG_VENDOR_ID);
  Serial.printf("sensors: expander %s, touch chip 0x%02X vendor 0x%02X\n",
                released ? "released touch reset" : "NOT FOUND at 0x20", chip, vendor);

  /*
   * The interrupt line idles high and is pulled low by a controller that has something to report.
   * Counted on the falling edge in a handler rather than polled, so a contact shorter than one pass
   * of the loop still registers.
   */
  pinMode(TP_INT, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TP_INT), onTouchInterrupt, FALLING);

  /* The control. Known good, and its liveness is what makes a dead touch row meaningful. */
  writeReg(IMU_ADDR, IMU_REG_CTRL1, 0x40);
  writeReg(IMU_ADDR, IMU_REG_CTRL2, 0x04);
  writeReg(IMU_ADDR, IMU_REG_CTRL7, 0x01);

  char head[40];
  snprintf(head, sizeof(head), "chip %02X ven %02X %s", chip, vendor, released ? "rst ok" : "NO EXP");
  line("TOUCH TEST", 12, RGB565_WHITE, 3);
  line(head, 48, RGB565_CYAN, 2);
  line("put a finger on the glass", 74, RGB565_YELLOW, 1);
}

void loop() {
  static uint32_t lastDraw = 0;
  static uint32_t lastPrint = 0;
  static uint32_t regChanges = 0;
  static int lastFingers = -1;
  static int lastX = -1;
  static int lastY = -1;

  const int fingers = readReg(TOUCH_ADDR, TOUCH_REG_FINGERS);
  const int xh = readReg(TOUCH_ADDR, TOUCH_REG_XH);
  const int xl = readReg(TOUCH_ADDR, TOUCH_REG_XL);
  const int yh = readReg(TOUCH_ADDR, TOUCH_REG_YH);
  const int yl = readReg(TOUCH_ADDR, TOUCH_REG_YL);
  const bool ok = fingers >= 0 && xh >= 0 && xl >= 0 && yh >= 0 && yl >= 0;
  const int x = ok ? (((xh & 0x0F) << 8) | xl) : -1;
  const int y = ok ? (((yh & 0x0F) << 8) | yl) : -1;
  if (ok && (fingers != lastFingers || x != lastX || y != lastY)) {
    if (lastFingers >= 0) regChanges++;
    lastFingers = fingers;
    lastX = x;
    lastY = y;
  }

  const uint32_t edges = intEdges;
  const int level = digitalRead(TP_INT);

  if (millis() - lastDraw > 120) {
    lastDraw = millis();
    char buf[48];

    /* The headline number: a finger that reaches this board moves this and nothing else has to. */
    snprintf(buf, sizeof(buf), "INT edges %6u", (unsigned)edges);
    line(buf, 130, edges > 0 ? RGB565_GREEN : RGB565_DARKGREY, 3);

    snprintf(buf, sizeof(buf), "INT line now %s", level ? "high (idle)" : "LOW ");
    line(buf, 180, level ? RGB565_DARKGREY : RGB565_GREEN, 2);

    snprintf(buf, sizeof(buf), "regs %s  moved %3u", ok ? "ok  " : "FAIL", (unsigned)regChanges);
    line(buf, 220, regChanges > 0 ? RGB565_GREEN : RGB565_DARKGREY, 2);

    snprintf(buf, sizeof(buf), "fingers %d  x %4d  y %4d", fingers, x, y);
    line(buf, 252, fingers > 0 ? RGB565_GREEN : RGB565_DARKGREY, 2);

    uint8_t a[6];
    Wire.beginTransmission(IMU_ADDR);
    Wire.write(IMU_REG_AX_L);
    if (Wire.endTransmission(false) == 0 && Wire.requestFrom((int)IMU_ADDR, 6) == 6) {
      for (uint8_t i = 0; i < 6; i++) a[i] = Wire.read();
      const int16_t ax = (int16_t)((a[1] << 8) | a[0]);
      const int16_t az = (int16_t)((a[5] << 8) | a[4]);
      snprintf(buf, sizeof(buf), "imu x%6d z%6d", ax, az);
      line(buf, 300, RGB565_MAGENTA, 2);
    }
    line("green anywhere = it reached us", 340, RGB565_WHITE, 1);
  }

  if (millis() - lastPrint > 1000) {
    lastPrint = millis();
    Serial.printf("touch: int_edges=%u int_level=%d regs=%s fingers=%d x=%d y=%d moved=%u\n",
                  (unsigned)edges, level, ok ? "ok" : "FAIL", fingers, x, y, (unsigned)regChanges);
  }

  delay(15);
}
