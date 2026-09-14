/*
 * Ask the touch controller what it actually says, and show the answer on the glass.
 *
 * `probe/` established what is on the I2C bus by identity register — a CST820-class touch part at
 * 0x15 (chip 0xB7, vendor 0x41) and a QMI8658 IMU at 0x6B (WHO_AM_I 0x05). That is a different
 * question from "what do these report when a person uses them", and the first version of this
 * sketch answered it for the IMU immediately: control registers reading back as written and a clean
 * 1.05g gravity vector at the ±2g scale factor. The touch part answered its identity and then never
 * produced a coordinate, through two different access patterns and with the driver built on the
 * second one shipped into the panel firmware, where it also produced nothing.
 *
 * So this stops guessing at a register map. It dumps the low registers continuously and marks the
 * ones that *change*, because the register a finger moves is the register a finger is in, whatever
 * the datasheet for a neighbouring part number says it should be. If nothing changes under a
 * finger, that is a real finding too, and a much stronger one than a failed read.
 *
 * It also brings the panel up and draws the dump, which the first version did not. That version was
 * flashed over a working panel firmware and left the screen black while asking someone to interact
 * with it — a diagnostic that destroys the thing it is diagnosing and gives the person holding the
 * unit nothing to look at. The panel init here is copied from `panel/panel.ino`, column offset and
 * all.
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

#define IMU_ADDR 0x6B
#define IMU_REG_WHO_AM_I 0x00
#define IMU_REG_CTRL1 0x02
#define IMU_REG_CTRL2 0x03
#define IMU_REG_CTRL7 0x08
#define IMU_REG_AX_L 0x35

/* From the vendor's pin_config.h for V2 hardware, by way of panel/panel.ino. */
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
/* The 16 is the vendor's column offset; see panel/panel.ino for why getting it wrong shifts everything. */
Arduino_CO5300 *gfx =
    new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0 /* rotation */, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);

static const uint8_t DUMP_FIRST = 0x00;
static const uint8_t DUMP_COUNT = 16; /* 0x00 through 0x0F: where every part in this family keeps its data */

static uint8_t current[DUMP_COUNT];
static uint8_t baseline[DUMP_COUNT];
static bool everChanged[DUMP_COUNT];
static bool haveBaseline = false;
static uint32_t changes = 0;

static int readReg(uint8_t address, uint8_t reg, bool repeatedStart) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(!repeatedStart) != 0) return -1;
  if (Wire.requestFrom((int)address, 1) != 1) return -1;
  return Wire.read();
}

static int writeReg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission();
}

static void drawHeader(const char *line, int y, uint16_t colour) {
  gfx->setTextColor(colour, RGB565_BLACK);
  gfx->setCursor(8, y);
  gfx->print(line);
}

void setup() {
  Serial.begin(115200);
  const uint32_t waited = millis();
  while (!Serial && millis() - waited < 2000) delay(10);

  gfx->begin();
  gfx->setBrightness(180);
  gfx->fillScreen(RGB565_BLACK);
  gfx->setTextSize(2);

  Wire.begin(BUS_SDA, BUS_SCL, 400000u);
  /* Bounded, so a chip that stops clocking cannot take the sketch down with it. */
  Wire.setTimeOut(20);

  const int chip = readReg(TOUCH_ADDR, TOUCH_REG_CHIP_ID, true);
  const int vendor = readReg(TOUCH_ADDR, TOUCH_REG_VENDOR_ID, true);
  Serial.printf("sensors: touch chip 0x%02X vendor 0x%02X\n", chip, vendor);

  /*
   * Wake the touch controller, and stop it going back to sleep.
   *
   * The first dump off this sketch answered every read and never moved: sixteen registers frozen at
   * `00 00 00 40 CA 01 62 00 00 FF...` with the finger count stuck at zero, through a minute of
   * being touched. A part that is held in reset does not answer at all, and a part that is broken
   * does not answer consistently — so alive on the bus and blind to a finger is a third thing, and
   * on CST816 family controllers it is the documented one: they drop into a standby that keeps the
   * I2C interface up and stops scanning the panel. Everything above was reading a sleeping chip's
   * last frame.
   *
   * The register numbers are the vendor's, from `Arduino_CST816x.h` in waveshareteam's own example
   * tree for this exact board — not a datasheet for a neighbouring part and not a guess. An earlier
   * pass here wrote 0xA5 and 0xFE, which are what a CST816S write-up suggests and are simply not
   * these registers; that attempt changed nothing and could not have. 0xE5 is sleep mode, where the
   * vendor writes 0b11 for on, and 0xFA is interrupt mode, where 0b00100000 reports on change.
   *
   * Their driver carries a warning worth repeating: the comment beside the sleep write says the
   * sleep function can currently only be entered, not left. If this part is genuinely asleep then
   * no write here will wake it and it needs its reset line pulled — which on this board is not a
   * GPIO at all (the vendor's pin_config.h names only IIC_SDA 15, IIC_SCL 14 and TP_INT 21), so it
   * would have to come from the TCA9554 expander at 0x20. That is the next thing to try if this
   * changes nothing.
   */
  /*
   * **Nothing is written to 0xE5 here, and the reason is a mistake worth leaving on the record.**
   *
   * The paragraph above read the vendor's `TOUCH_DEVICE_SLEEP_MODE` + `TOUCH_DEVICE_ON` pair as
   * "turn the device on". It is not: the device being switched *is the sleep mode*, so ON means
   * sleep on, and 0b11 to 0xE5 is the command that puts the part to sleep. Writing it did exactly
   * that — a chip that had been answering every read with a frozen frame stopped answering at all,
   * all sixteen registers reading zero — and since the vendor's own comment says sleep can be
   * entered and not left, it took a power cycle to undo. An enum is not a sentence, and reading it
   * as one cost this board a trip to the mains.
   *
   * So this sketch now only ever *reads* the touch part, plus the interrupt line below. If it turns
   * out a wake really is needed, it will be a reset through the TCA9554 at 0x20, not a register
   * write — the vendor's pin_config.h names no touch reset GPIO, which is what points at the
   * expander in the first place.
   */
  Serial.printf("sensors: touch irq mode 0xFA reads 0x%02X (not written)\n",
                readReg(TOUCH_ADDR, 0xFA, true));

  /*
   * TP_INT is GPIO 21 on this board. Held as an input with a pull-up, which is what the line idles
   * at: a controller that is scanning pulls it low when it has something, so watching it is a way
   * to see a touch land that does not depend on reading the right register.
   */
  pinMode(21, INPUT_PULLUP);

  /*
   * Wake the IMU, as before. It is not what is being investigated — it already works — but a live
   * accelerometer on screen is the proof that the I2C bus itself is healthy while the touch rows
   * sit still, which is the distinction the whole sketch turns on.
   */
  writeReg(IMU_ADDR, IMU_REG_CTRL1, 0x40);
  writeReg(IMU_ADDR, IMU_REG_CTRL2, 0x04);
  writeReg(IMU_ADDR, IMU_REG_CTRL7, 0x01);

  drawHeader("touch register dump", 10, RGB565_WHITE);
  char line[48];
  snprintf(line, sizeof(line), "chip %02X vendor %02X", chip, vendor);
  drawHeader(line, 34, RGB565_CYAN);
  drawHeader("TOUCH THE SCREEN", 58, RGB565_YELLOW);
}

void loop() {
  /* Read the low registers one at a time with a stop: the pattern this part has actually answered. */
  bool ok = true;
  for (uint8_t i = 0; i < DUMP_COUNT; i++) {
    const int value = readReg(TOUCH_ADDR, (uint8_t)(DUMP_FIRST + i), false);
    if (value < 0) {
      ok = false;
      current[i] = 0;
    } else {
      current[i] = (uint8_t)value;
    }
  }
  if (!haveBaseline && ok) {
    memcpy(baseline, current, sizeof(baseline));
    haveBaseline = true;
  }
  for (uint8_t i = 0; i < DUMP_COUNT; i++) {
    if (haveBaseline && current[i] != baseline[i]) {
      if (!everChanged[i]) changes++;
      everChanged[i] = true;
    }
  }

  /* Four rows of four registers, index above value, anything that has ever moved drawn in green. */
  int y = 96;
  for (uint8_t row = 0; row < 4; row++) {
    int x = 8;
    for (uint8_t col = 0; col < 4; col++) {
      const uint8_t i = (uint8_t)(row * 4 + col);
      char cell[16];
      snprintf(cell, sizeof(cell), "%02X:%02X", (unsigned)(DUMP_FIRST + i), current[i]);
      gfx->setTextColor(everChanged[i] ? RGB565_GREEN : RGB565_DARKGREY, RGB565_BLACK);
      gfx->setCursor(x, y);
      gfx->print(cell);
      x += 92;
    }
    y += 26;
  }

  char status[48];
  snprintf(status, sizeof(status), ok ? "read ok, moved: %u  " : "READ FAILED      ", (unsigned)changes);
  gfx->setTextColor(ok ? RGB565_WHITE : RGB565_RED, RGB565_BLACK);
  gfx->setCursor(8, 212);
  gfx->print(status);

  /* The bus is fine if this moves, which is the control for the rows above. */
  uint8_t a[6];
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(IMU_REG_AX_L);
  if (Wire.endTransmission(false) == 0 && Wire.requestFrom((int)IMU_ADDR, 6) == 6) {
    for (uint8_t i = 0; i < 6; i++) a[i] = Wire.read();
    const int16_t ax = (int16_t)((a[1] << 8) | a[0]);
    const int16_t az = (int16_t)((a[5] << 8) | a[4]);
    char imu[40];
    snprintf(imu, sizeof(imu), "imu x%6d z%6d", ax, az);
    gfx->setTextColor(RGB565_MAGENTA, RGB565_BLACK);
    gfx->setCursor(8, 240);
    gfx->print(imu);
  }

  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 1000) {
    lastPrint = millis();
    Serial.printf("touch %s:", ok ? "ok" : "FAIL");
    for (uint8_t i = 0; i < DUMP_COUNT; i++) Serial.printf(" %02X", current[i]);
    Serial.printf("  moved=%u  int=%d\n", (unsigned)changes, digitalRead(21));
  }
  delay(40);
}
