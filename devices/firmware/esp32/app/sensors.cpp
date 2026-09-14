#include "sensors.h"

#include <Wire.h>

namespace sensors {

namespace {

constexpr uint8_t TOUCH_ADDR = 0x15;
constexpr uint8_t TOUCH_REG_GESTURE = 0x01; /* then fingers, xh, xl, yh, yl */

/*
 * How often to ask the touch controller. 20ms is fast enough that a deliberate tap is never missed
 * — a finger is on the glass for well over a tenth of a second — and slow enough that the protocol
 * loop is not spending its time on the I2C bus. A frame arriving is worth more than a gesture
 * arriving 20ms earlier.
 */
constexpr uint32_t POLL_MS = 20;

/*
 * A finger that lands and lifts within this many pixels of where it started was pointing at
 * something, not dragging. 368 pixels across a 1.8in panel is roughly 200 per inch, so 24 is about
 * an eighth of an inch: comfortably inside the wobble of a real fingertip and far short of any
 * movement somebody meant.
 */
constexpr int16_t TAP_SLOP_PX = 24;

/* And this far sideways is a drag somebody meant. Two thirds of the gap is left as neither. */
constexpr int16_t SWIPE_MIN_PX = 80;

/*
 * A lift is only believed after this long without a finger, because these controllers report a
 * momentary zero finger count mid-contact often enough to matter, and a tap that becomes two taps
 * is worse than one reported 40ms late.
 */
constexpr uint32_t LIFT_SETTLE_MS = 40;

uint32_t lastPoll = 0;
bool seen = false;

bool down = false;
int16_t downX = 0;
int16_t downY = 0;
int16_t lastX = 0;
int16_t lastY = 0;
uint32_t liftedAt = 0;
bool lifting = false;

/*
 * One register at a time, with a stop rather than a repeated start between the address and the
 * read.
 *
 * `sensors/` tried the six byte burst first, because that is the obvious way to read a coordinate
 * pair, and this part would not serve it. Reading singly is four extra transactions on a 400kHz bus
 * — tens of microseconds — which is a price worth paying for an access pattern this chip has
 * actually demonstrated, against one it refused.
 */
int readReg(uint8_t reg)
{
	Wire.beginTransmission(TOUCH_ADDR);
	Wire.write(reg);
	if (Wire.endTransmission(true) != 0) return -1;
	if (Wire.requestFrom((int)TOUCH_ADDR, 1) != 1) return -1;
	return Wire.read();
}

}  // namespace

/*
 * Take the touch controller out of reset, which nothing here had ever done.
 *
 * This is the answer to why the CST820 answered every read and never saw a finger: its reset line
 * is not a GPIO. It hangs off the TCA9554 IO expander at 0x20, which `probe/` found on this bus and
 * which this firmware had otherwise no reason to talk to, so the part had been sitting in whatever
 * state power-on left it in — interface alive, panel scanning never started. A frozen register dump
 * holding one stale coordinate with the finger count pinned at zero is exactly what that looks like,
 * and it is what the dump showed.
 *
 * The sequence is waveshareteam's own, from `release_touch_reset()` in
 * `examples/esp-idf/.../board_variant/board_variant.c` for this board: make the four controlled
 * lines outputs, drive everything but the SD chip select low so touch reset is asserted, wait 20ms,
 * then drive them all high to release it, and give the controller 150ms to come up before expecting
 * anything of it. Bit 0 is the LCD reset and bit 1 a power enable, which is why they are driven
 * together rather than poked individually: this is the board's documented bring-up, not a bit of it.
 *
 * Their delays are kept as they are. They are a vendor's numbers for a part whose datasheet is not
 * in this tree, and shortening someone else's reset timing to save 170ms once at boot is the kind of
 * saving that buys an intermittent fault.
 */
void releaseTouchReset()
{
	constexpr uint8_t EXPANDER_ADDR = 0x20;
	constexpr uint8_t REG_OUTPUT = 0x01;
	constexpr uint8_t REG_CONFIG = 0x03;
	constexpr uint8_t LCD_RST = 1u << 0;
	constexpr uint8_t DSI_PWR_EN = 1u << 1;
	constexpr uint8_t TOUCH_RST = 1u << 2;
	constexpr uint8_t SD_CS = 1u << 7;
	constexpr uint8_t OUTPUTS = LCD_RST | DSI_PWR_EN | TOUCH_RST | SD_CS;

	const auto write = [](uint8_t reg, uint8_t value) {
		Wire.beginTransmission(EXPANDER_ADDR);
		Wire.write(reg);
		Wire.write(value);
		return Wire.endTransmission() == 0;
	};

	/* A zero bit is an output on a TCA9554, so the mask is inverted. */
	if (!write(REG_CONFIG, (uint8_t)~OUTPUTS)) {
		return; /* No expander: a board without one has nothing here to release. */
	}
	/*
	 * Only bit 2 moves, which is where this departs from the vendor's sequence and has to.
	 *
	 * Theirs drives every controlled line low at once — touch reset, the LCD's reset and a power
	 * enable — which is correct where they do it, in board bring-up before anything has touched the
	 * display. This runs from `sensors::begin()`, after `panel->begin()` has configured the CO5300,
	 * so driving LCD_RST low here resets the display controller immediately after it was set up and
	 * leaves a dark panel behind a firmware that believes it is painting. It did exactly that on the
	 * unit on this desk, which had been showing a frame a minute earlier.
	 *
	 * The other three lines are therefore held high throughout. The delays stay as the vendor wrote
	 * them: they are for a part whose datasheet is not in this tree, and shortening someone else's
	 * reset timing to save 170ms once per boot is how an intermittent fault gets bought.
	 */
	write(REG_OUTPUT, (uint8_t)(OUTPUTS & ~TOUCH_RST));
	delay(20);
	write(REG_OUTPUT, OUTPUTS);
	delay(150);
}

void begin()
{
	/*
	 * Match `sensors/sensors.ino` exactly, because that sketch demonstrably reads this part and this
	 * file demonstrably did not.
	 *
	 * The bus was already up when this ran — `scan_i2c()` in the banner calls `Wire.begin` at 100kHz
	 * — so this began as a reset and a timeout on top of somebody else's bus configuration, and the
	 * touch reads returned nothing while the same reads in the diagnostic returned coordinates. The
	 * three things that differed are all here now: the speed, a timeout with room in it, and the
	 * interrupt line held at its idle level rather than left floating. Which of the three mattered is
	 * not established, and saying so is more honest than picking one.
	 */
	Wire.begin(15 /* SDA */, 14 /* SCL */, 400000u);
	/*
	 * Bounded, so a slave that stops clocking cannot take the protocol loop down with it. The default
	 * blocks, and a blocking bus on this device does not look like a broken sensor: it looks like a
	 * display that froze.
	 */
	Wire.setTimeOut(20);
	/*
	 * TP_INT, per the vendor's pin_config.h. Nothing reads it yet — the driver polls — but the
	 * diagnostic that works holds it this way, and a controller's interrupt output left floating is
	 * not a thing to leave differing between a sketch that reads this part and a firmware that does
	 * not.
	 */
	pinMode(21, INPUT_PULLUP);
	releaseTouchReset();
	lastPoll = millis();
}

bool touchSeen()
{
	return seen;
}

Event poll()
{
	Event event;
	const uint32_t now = millis();
	if (now - lastPoll < POLL_MS) return event;
	lastPoll = now;

	const int fingers = readReg(TOUCH_REG_GESTURE + 1);
	if (fingers < 0) return event; /* No answer. Not an error worth reporting every 20ms. */

	if (fingers > 0) {
		const int xh = readReg(TOUCH_REG_GESTURE + 2);
		const int xl = readReg(TOUCH_REG_GESTURE + 3);
		const int yh = readReg(TOUCH_REG_GESTURE + 4);
		const int yl = readReg(TOUCH_REG_GESTURE + 5);
		if (xh < 0 || xl < 0 || yh < 0 || yl < 0) return event;
		/* Twelve bits: the low nibble of the high byte carries bits 11..8. */
		const int16_t x = (int16_t)(((xh & 0x0F) << 8) | xl);
		const int16_t y = (int16_t)(((yh & 0x0F) << 8) | yl);
		seen = true;
		lifting = false;
		lastX = x;
		lastY = y;
		if (!down) {
			down = true;
			downX = x;
			downY = y;
		}
		return event;
	}

	if (!down) return event;

	/* Zero fingers. Wait out a possible dropout before calling it a lift. */
	if (!lifting) {
		lifting = true;
		liftedAt = now;
		return event;
	}
	if (now - liftedAt < LIFT_SETTLE_MS) return event;

	down = false;
	lifting = false;
	const int16_t dx = (int16_t)(lastX - downX);
	const int16_t dy = (int16_t)(lastY - downY);
	const int16_t adx = (int16_t)(dx < 0 ? -dx : dx);
	const int16_t ady = (int16_t)(dy < 0 ? -dy : dy);

	if (adx < TAP_SLOP_PX && ady < TAP_SLOP_PX) {
		event.kind = Kind::Tap;
		event.a = downX;
		event.b = downY;
		return event;
	}
	if (adx >= SWIPE_MIN_PX && adx > ady) {
		event.kind = Kind::Swipe;
		event.a = downX;
		event.b = lastX;
		return event;
	}
	/* Travelled, but not far enough or not sideways enough to have meant anything. */
	return event;
}

}  // namespace sensors
