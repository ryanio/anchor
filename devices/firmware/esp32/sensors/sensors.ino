/*
 * Read the two chips this board has and the panel firmware ignores.
 *
 * `probe/` established that they are there — a CST820-class touch controller at 0x15 (chip id 0xB7,
 * vendor 0x41) and a QMI8658 IMU at 0x6B (WHO_AM_I 0x05) — by asking each address for its identity
 * register. That is a different question from "what does it say when somebody touches it", and this
 * sketch exists to answer the second one before a line of it goes into `app/`.
 *
 * The reason for a separate sketch rather than a debug flag in the panel firmware is the cable:
 * `Serial` there *is* the protocol, and a printf arriving mid-frame is a fault the host reports as
 * a broken device. So the instrument gets its own sketch, exactly as `probe/` did, and the panel
 * firmware only ever receives code that has already been checked against silicon here.
 *
 * Register maps below are written from the CST816/CST820 and QMI8658 families and are *the thing
 * being tested*, not an assumption this sketch rests on. If a number here is wrong, the output says
 * so plainly — a chip id that does not match, coordinates that do not move, an accelerometer that
 * reads zero on every axis — rather than looking like a subtly wrong feature later.
 *
 *   arduino-cli compile --fqbn "$FQBN" sensors
 *   arduino-cli upload  --fqbn "$FQBN" -p /dev/ttyACM1 sensors
 *   arduino-cli monitor -p /dev/ttyACM1 -c baudrate=115200
 *
 * Touch the screen. Tilt the board. Both lines should move, and one should stay still while you do
 * the other.
 */

#include <Arduino.h>
#include <Wire.h>

#define BUS_SDA 15
#define BUS_SCL 14

#define TOUCH_ADDR 0x15
#define TOUCH_REG_GESTURE 0x01 /* then finger count, xh, xl, yh, yl */
#define TOUCH_REG_CHIP_ID 0xA7
#define TOUCH_REG_VENDOR_ID 0xA8

#define IMU_ADDR 0x6B
#define IMU_REG_WHO_AM_I 0x00
#define IMU_REG_REVISION 0x01
#define IMU_REG_CTRL1 0x02 /* serial interface: bit 6 sets address auto increment */
#define IMU_REG_CTRL2 0x03 /* accelerometer: full scale and output data rate */
#define IMU_REG_CTRL7 0x08 /* bit 0 enables the accelerometer, bit 1 the gyroscope */
#define IMU_REG_AX_L 0x35  /* then AX_H, AY_L, AY_H, AZ_L, AZ_H */

#define IMU_WHO_AM_I_EXPECTED 0x05

static int read_reg(uint8_t address, uint8_t reg) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)address, 1) != 1) return -1;
  return Wire.read();
}

static bool read_regs(uint8_t address, uint8_t reg, uint8_t *out, size_t count) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)address, (int)count) != (int)count) return false;
  for (size_t i = 0; i < count; i++) out[i] = Wire.read();
  return true;
}

/*
 * The same read with a stop between the address write and the data read, rather than a repeated
 * start. Some touch controllers in this family will not serve a repeated start on their data
 * registers even though they answer one on their identity registers, which is a difference that
 * looks like "the chip is asleep" until both are tried side by side.
 */
static int read_reg_stop(uint8_t address, uint8_t reg) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(true) != 0) return -1;
  if (Wire.requestFrom((int)address, 1) != 1) return -1;
  return Wire.read();
}

static int write_reg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission();
}

static void identify(void) {
  const int touch_chip = read_reg(TOUCH_ADDR, TOUCH_REG_CHIP_ID);
  const int touch_vendor = read_reg(TOUCH_ADDR, TOUCH_REG_VENDOR_ID);
  Serial.printf("sensors: touch 0x%02X chip 0x%02X vendor 0x%02X %s\n", TOUCH_ADDR, touch_chip,
                touch_vendor, touch_chip == 0xB7 ? "(CST820, as probe/ found)" : "(UNEXPECTED)");

  const int who = read_reg(IMU_ADDR, IMU_REG_WHO_AM_I);
  const int rev = read_reg(IMU_ADDR, IMU_REG_REVISION);
  Serial.printf("sensors: imu   0x%02X who 0x%02X rev 0x%02X %s\n", IMU_ADDR, who, rev,
                who == IMU_WHO_AM_I_EXPECTED ? "(QMI8658, as probe/ found)" : "(UNEXPECTED)");
}

/*
 * Wake the accelerometer.
 *
 * The IMU boots with both sensors disabled, so a read of the output registers before this returns
 * zeroes — which is indistinguishable from a chip that is not there, and is the most likely way for
 * this to look broken when it is merely asleep. CTRL1 bit 6 turns on address auto increment, which
 * is what makes the six byte burst read below legal. CTRL2 sets the accelerometer to its ±2g range,
 * because tilt is a question about gravity and nothing here is measuring an impact. CTRL7 bit 0
 * enables the accelerometer and leaves the gyroscope off: a gyro reports rotation *rate*, and the
 * thing being asked is which way is down, which only gravity answers.
 */
static void wake_imu(void) {
  write_reg(IMU_ADDR, IMU_REG_CTRL1, 0x40);
  write_reg(IMU_ADDR, IMU_REG_CTRL2, 0x04);
  write_reg(IMU_ADDR, IMU_REG_CTRL7, 0x01);
  delay(50);
  Serial.printf("sensors: imu ctrl1 0x%02X ctrl2 0x%02X ctrl7 0x%02X (read back)\n",
                read_reg(IMU_ADDR, IMU_REG_CTRL1), read_reg(IMU_ADDR, IMU_REG_CTRL2),
                read_reg(IMU_ADDR, IMU_REG_CTRL7));
}

/*
 * Free a bus a slave is still holding.
 *
 * An I2C slave that was interrupted mid-byte — by a reset, or by a master that walked away after a
 * NAK — can be left driving SDA low waiting for clocks that are never coming. Nothing on the bus
 * can do anything until it is let go, and a *soft* reset does not fix it: the ESP32 restarts, the
 * touch controller does not, and it is still holding the line when the new firmware calls
 * `Wire.begin`. That is what made this sketch look like it hung, and it is why the first flash
 * worked and every one after it did not.
 *
 * The way out is the one in the I2C specification: clock the bus by hand until the slave releases
 * SDA — at most nine pulses, which is the byte it is stuck in the middle of plus its ACK — then
 * issue a STOP so it is back at a known state.
 */
static void i2c_bus_recover(void) {
  pinMode(BUS_SDA, INPUT_PULLUP);
  pinMode(BUS_SCL, OUTPUT_OPEN_DRAIN);
  digitalWrite(BUS_SCL, HIGH);
  delayMicroseconds(10);
  const bool stuck = digitalRead(BUS_SDA) == LOW;
  int pulses = 0;
  while (digitalRead(BUS_SDA) == LOW && pulses < 9) {
    digitalWrite(BUS_SCL, LOW);
    delayMicroseconds(10);
    digitalWrite(BUS_SCL, HIGH);
    delayMicroseconds(10);
    pulses++;
  }
  /* STOP: SDA released from low to high while SCL is high. */
  pinMode(BUS_SDA, OUTPUT_OPEN_DRAIN);
  digitalWrite(BUS_SDA, LOW);
  delayMicroseconds(10);
  digitalWrite(BUS_SCL, HIGH);
  delayMicroseconds(10);
  digitalWrite(BUS_SDA, HIGH);
  delayMicroseconds(10);
  pinMode(BUS_SDA, INPUT_PULLUP);
  pinMode(BUS_SCL, INPUT_PULLUP);
  Serial.printf("sensors: bus %s%s\n", stuck ? "was held low, clocked out in " : "was free",
                stuck ? (String(pulses) + " pulses").c_str() : "");
}

void setup() {
  Serial.begin(115200);
  const uint32_t waited = millis();
  while (!Serial && millis() - waited < 3000) delay(10);
  i2c_bus_recover();
  Wire.begin(BUS_SDA, BUS_SCL, 400000u);
  /*
   * Without this a failed transaction blocks rather than returning, and the first capture off this
   * sketch showed exactly that: identity reads, one accelerometer line, then silence for the rest
   * of the window. That was not a chip with nothing to say, it was a wedged bus — and it is worth
   * the same warning `probe/` carries, because "stopped printing" and "nothing to print" look
   * identical from the far end of a cable.
   */
  Wire.setTimeOut(50);
  Serial.println();
  Serial.println("sensors: touch and imu bringup, esp32-s3-touch-amoled-1.8");
  identify();
  wake_imu();
  Serial.println("sensors: touch the screen, tilt the board");
}

void loop() {
  /*
   * Touch first. Six bytes from 0x01: gesture, finger count, then X and Y as a high byte whose low
   * nibble carries bits 11..8 and a full low byte. The gesture byte is read and printed but nothing
   * is built on it — CST816 family parts vary in whether gestures are reported at all without extra
   * configuration, while the coordinates are always there, so `app/` will recognise taps and swipes
   * from the coordinates itself rather than trusting this byte.
   */
  /*
   * A heartbeat, so a quiet log can be told apart from a stopped one. This is the instrument
   * checking itself: the first two captures off this sketch were read as "the touch chip says
   * nothing", and both were actually "the sketch stopped running".
   */
  static uint32_t last_tick = 0;
  static uint32_t ticks = 0;
  if (millis() - last_tick > 1000u) {
    last_tick = millis();
    Serial.printf("tick %u\n", (unsigned)++ticks);
  }

  uint8_t t[6];
  const bool burst = read_regs(TOUCH_ADDR, TOUCH_REG_GESTURE, t, sizeof(t));
  /* Which access pattern this part will actually serve data on, reported once rather than every pass. */
  static bool said_how = false;
  if (!said_how) {
    said_how = true;
    const int stop_then_read = read_reg_stop(TOUCH_ADDR, TOUCH_REG_GESTURE);
    const int repeated_start = read_reg(TOUCH_ADDR, TOUCH_REG_GESTURE);
    Serial.printf("touch: burst %s, repeated start %s, stop then read %s\n", burst ? "ok" : "FAILED",
                  repeated_start < 0 ? "FAILED" : "ok", stop_then_read < 0 ? "FAILED" : "ok");
  }
  if (!burst) {
    /*
     * The burst read failed where the single byte identity reads succeeded, so the chip is present
     * and answering — it just will not serve six bytes from one address pointer. Fall back to one
     * register at a time, which is the access pattern already proven against this part, and say
     * which path produced the numbers so the two are never confused in the log.
     */
    for (size_t i = 0; i < sizeof(t); i++) {
      const int one = read_reg(TOUCH_ADDR, (uint8_t)(TOUCH_REG_GESTURE + i));
      t[i] = one < 0 ? 0 : (uint8_t)one;
    }
  }
  {
    const uint8_t gesture = t[0];
    const uint8_t fingers = t[1];
    const uint16_t x = (uint16_t)(((t[2] & 0x0F) << 8) | t[3]);
    const uint16_t y = (uint16_t)(((t[4] & 0x0F) << 8) | t[5]);
    static uint8_t last_fingers = 0xFF;
    static uint16_t last_x = 0xFFFF;
    static uint16_t last_y = 0xFFFF;
    if (fingers != last_fingers || x != last_x || y != last_y) {
      last_fingers = fingers;
      last_x = x;
      last_y = y;
      Serial.printf("touch: fingers %u  x %4u  y %4u  gesture 0x%02X  (%s)\n", fingers, x, y,
                    gesture, burst ? "burst" : "one at a time");
    }
  }

  /*
   * Then the accelerometer, printed on a slow beat rather than every pass: it always has a reading,
   * so an unthrottled print would bury the touch lines it has to be read next to.
   */
  static uint32_t last_imu = 0;
  if (millis() - last_imu > 500u) {
    last_imu = millis();
    uint8_t a[6];
    if (read_regs(IMU_ADDR, IMU_REG_AX_L, a, sizeof(a))) {
      const int16_t ax = (int16_t)((a[1] << 8) | a[0]);
      const int16_t ay = (int16_t)((a[3] << 8) | a[2]);
      const int16_t az = (int16_t)((a[5] << 8) | a[4]);
      /* At ±2g a 16 bit signed reading is 16384 counts per g, so flat on a desk is near 0, 0, ±1. */
      Serial.printf("accel: x %6d  y %6d  z %6d   (%.2fg %.2fg %.2fg)\n", ax, ay, az, ax / 16384.0f,
                    ay / 16384.0f, az / 16384.0f);
    } else {
      Serial.println("accel: read failed");
    }
  }

  delay(10);
}
