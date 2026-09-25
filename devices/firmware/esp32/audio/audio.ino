/*
 * Does this board have a working microphone and speaker?
 *
 * `probe/` found an ES8311 audio codec at I2C 0x18 (chip id 0x83 0x11). A codec on the bus says
 * nothing about what is wired to it, and `docs/companion-voice.md` will not build talking on an
 * assumption, so this sketch is step 1 of that plan: prove the speaker and the microphone on the
 * glass, with a number rather than an impression.
 *
 * Each cycle has three phases:
 *
 *   1. **Quiet.** One second recorded with the speaker silent. This is the baseline: amplifier hiss,
 *      room noise, and whatever the microphone picks up from the board itself.
 *   2. **Tone.** One second of 1 kHz played while recording. The number that matters is how much
 *      1 kHz energy the microphone hears now compared with the quiet second, measured with a
 *      Goertzel filter so room noise at other frequencies does not count. Sound has to leave the
 *      speaker and reach the microphone through the air for this to rise, so a clear rise proves
 *      both ends at once, from the serial log alone, with nobody listening.
 *   3. **Talk.** Three seconds recorded while the screen asks for speech, then played back. This is
 *      the human check: whether the recording is intelligible, which no number here measures.
 *
 * It runs three cycles and stops, because a diagnostic that beeps forever gets unplugged before
 * anyone reads it. Reset the board to run it again.
 *
 * The pins are Waveshare's, from `examples/arduino-v2/libraries/Mylibrary/pin_config.h` at the
 * vendor commit `devices/toolchain.json` pins, and the codec driver is their `15_ES8311` example's
 * `es8311.c` (Espressif, Apache-2.0) from the same commit, compiled in place rather than copied into
 * this tree. Their pin file names the data lines twice, once from each end of the wire; the ones
 * below are from the ESP32's side, as `ESP_I2S::setPins` takes them.
 *
 * Everything is drawn on the panel as well as printed, for the reason `sensors/` gives: a
 * diagnostic flashed over a working display must not leave somebody looking at a black screen.
 *
 *   V=.cache/device/vendor/waveshare/examples/arduino-v2
 *   arduino-cli compile --fqbn "$FQBN" --library "$V/libraries/GFX_Library_for_Arduino" \
 *     --library "$V/examples/15_ES8311" devices/firmware/esp32/audio
 */

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ESP_I2S.h>
#include <Wire.h>
#include <math.h>

#include "es8311.h"

#define BUS_SDA 15
#define BUS_SCL 14

#define I2S_MCLK 16
#define I2S_BCLK 9
#define I2S_WS 45
#define I2S_DOUT 8  /* ESP32 to codec: the speaker's samples */
#define I2S_DIN 10  /* codec to ESP32: the microphone's samples */
#define SPEAKER_AMP_EN 46

#define CODEC_ADDR 0x18
#define CODEC_REG_ID1 0xFD
#define CODEC_REG_ID2 0xFE

#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define LCD_WIDTH 368
#define LCD_HEIGHT 448

static constexpr uint32_t RATE = 16000;
static constexpr uint32_t TONE_HZ = 1000;
/* About -12 dBFS: loud enough to cross a room's noise, quiet enough not to startle whoever holds it. */
static constexpr int16_t TONE_AMPLITUDE = 8000;
static constexpr int SPEAKER_VOLUME = 70; /* 0 to 100, the vendor example uses 85 */
static constexpr es8311_mic_gain_t MIC_GAIN = ES8311_MIC_GAIN_18DB; /* the vendor example's value */

static constexpr size_t CHUNK_FRAMES = 256;
static constexpr uint32_t PHASE_MS = 1000;
static constexpr uint32_t TALK_MS = 3000;
/* The first part of a recording holds the codec's and the air's delay, not the phase being measured. */
static constexpr uint32_t SETTLE_MS = 150;
static constexpr int CYCLES = 3;
/* A 1 kHz rise this far above the quiet second is not room noise. Chosen by hand, not measured yet. */
static constexpr float PASS_DB = 15.0f;

Arduino_DataBus *bus =
    new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
/* The 16 is the vendor's column offset; panel/panel.ino says what getting it wrong looks like. */
Arduino_CO5300 *gfx =
    new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0 /* rotation */, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);

I2SClass i2s;
static es8311_handle_t codec = nullptr;
static int16_t *talk = nullptr; /* interleaved stereo, TALK_MS long, in PSRAM */
static size_t talkFrames = 0;

/* One channel's running figures over a window. */
struct Meter {
	double sumSquares = 0;
	int32_t peak = 0;
	uint32_t n = 0;
	/* Goertzel state at TONE_HZ. */
	double s1 = 0;
	double s2 = 0;

	void add(int16_t sample, double coeff)
	{
		const double x = sample;
		sumSquares += x * x;
		const int32_t magnitude = sample < 0 ? -(int32_t)sample : sample;
		if (magnitude > peak) peak = magnitude;
		n++;
		const double s0 = x + coeff * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	double rms() const { return n ? sqrt(sumSquares / n) : 0; }
	/* Power at TONE_HZ, normalised by window length so windows of different lengths compare. */
	double tonePower(double coeff) const
	{
		if (!n) return 0;
		const double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
		return power / ((double)n * (double)n);
	}
};

struct Window {
	Meter left;
	Meter right;
};

static double goertzelCoeff()
{
	return 2.0 * cos(2.0 * M_PI * (double)TONE_HZ / (double)RATE);
}

static int readReg(uint8_t address, uint8_t reg)
{
	Wire.beginTransmission(address);
	Wire.write(reg);
	if (Wire.endTransmission(true) != 0) return -1;
	if (Wire.requestFrom((int)address, 1) != 1) return -1;
	return Wire.read();
}

/*
 * The left margin is 20 and nothing is drawn above y=40, because the panel's corners are rounded:
 * `docs/devices-esp32.md` has the estimate (a radius near 60) and how it was reached.
 */
static void line(const char *s, int y, uint16_t colour, uint8_t size = 2)
{
	gfx->fillRect(0, y, LCD_WIDTH, 8 * size + 2, RGB565_BLACK);
	gfx->setTextSize(size);
	gfx->setTextColor(colour, RGB565_BLACK);
	gfx->setCursor(20, y);
	gfx->print(s);
}

static void status(const char *headline, const char *detail, uint16_t colour)
{
	line(headline, 96, colour, 3);
	line(detail, 136, RGB565_WHITE, 2);
}

static void levelBar(int32_t peak)
{
	const int width = LCD_WIDTH - 40;
	const int filled = (int)((int64_t)width * peak / 32767);
	gfx->fillRect(20, 176, filled, 24, RGB565_GREEN);
	gfx->fillRect(20 + filled, 176, width - filled, 24, RGB565_DARKGREY);
}

/* Drop whatever the receive side collected before this point, so a window starts now. */
static void flushInput()
{
	static int16_t scratch[CHUNK_FRAMES * 2];
	const uint32_t until = millis() + 60;
	while (millis() < until) i2s.readBytes((char *)scratch, sizeof(scratch));
}

/*
 * Plays `phaseMs` of either silence or the tone while recording, and measures what came back after
 * the settle time. Transmit and receive share one clock, so writing a chunk and reading a chunk in
 * turn keeps them in step without a second task.
 */
static Window playAndRecord(bool tone, uint32_t phaseMs)
{
	static int16_t out[CHUNK_FRAMES * 2];
	static int16_t in[CHUNK_FRAMES * 2];
	const double coeff = goertzelCoeff();
	const uint32_t totalFrames = RATE * phaseMs / 1000;
	const uint32_t settleFrames = RATE * SETTLE_MS / 1000;
	Window window;
	uint32_t phase = 0;

	flushInput();
	for (uint32_t done = 0; done < totalFrames; done += CHUNK_FRAMES) {
		for (size_t i = 0; i < CHUNK_FRAMES; i++) {
			int16_t sample = 0;
			if (tone) {
				sample = (int16_t)(TONE_AMPLITUDE * sin(2.0 * M_PI * (double)phase / (double)RATE * TONE_HZ));
				phase = (phase + 1) % RATE;
			}
			out[2 * i] = sample;
			out[2 * i + 1] = sample;
		}
		i2s.write((const uint8_t *)out, sizeof(out));
		const size_t got = i2s.readBytes((char *)in, sizeof(in)) / (2 * sizeof(int16_t));
		if (done < settleFrames) continue;
		for (size_t i = 0; i < got; i++) {
			window.left.add(in[2 * i], coeff);
			window.right.add(in[2 * i + 1], coeff);
		}
	}
	return window;
}

static float riseDb(const Meter &quiet, const Meter &tone)
{
	const double coeff = goertzelCoeff();
	const double q = quiet.tonePower(coeff);
	const double t = tone.tonePower(coeff);
	if (t <= 0) return -99.0f;
	if (q <= 0) return 99.0f;
	return (float)(10.0 * log10(t / q));
}

static void recordTalk()
{
	static int16_t out[CHUNK_FRAMES * 2] = {0};
	const size_t frames = RATE * TALK_MS / 1000;
	int32_t peakLeft = 0;
	int32_t peakRight = 0;
	uint32_t lastBar = 0;

	flushInput();
	talkFrames = 0;
	while (talkFrames + CHUNK_FRAMES <= frames) {
		i2s.write((const uint8_t *)out, sizeof(out));
		int16_t *dest = talk + 2 * talkFrames;
		const size_t got = i2s.readBytes((char *)dest, CHUNK_FRAMES * 2 * sizeof(int16_t)) /
		                   (2 * sizeof(int16_t));
		int32_t chunkPeak = 0;
		for (size_t i = 0; i < got; i++) {
			const int32_t l = abs(dest[2 * i]);
			const int32_t r = abs(dest[2 * i + 1]);
			if (l > peakLeft) peakLeft = l;
			if (r > peakRight) peakRight = r;
			if (l > chunkPeak) chunkPeak = l;
			if (r > chunkPeak) chunkPeak = r;
		}
		talkFrames += got;
		if (millis() - lastBar > 60) {
			lastBar = millis();
			levelBar(chunkPeak);
		}
	}
	Serial.printf("anchor-audio: talk frames=%u peak_l=%d peak_r=%d\n", (unsigned)talkFrames,
	              (int)peakLeft, (int)peakRight);
}

static void playTalk()
{
	for (size_t done = 0; done < talkFrames; done += CHUNK_FRAMES) {
		const size_t frames = min(CHUNK_FRAMES, talkFrames - done);
		/* The microphone arrives on one slot; copy it to both so the speaker plays it either way. */
		static int16_t out[CHUNK_FRAMES * 2];
		static int16_t in[CHUNK_FRAMES * 2];
		for (size_t i = 0; i < frames; i++) {
			const int16_t l = talk[2 * (done + i)];
			const int16_t r = talk[2 * (done + i) + 1];
			const int16_t loud = abs(l) >= abs(r) ? l : r;
			out[2 * i] = loud;
			out[2 * i + 1] = loud;
		}
		i2s.write((const uint8_t *)out, frames * 2 * sizeof(int16_t));
		i2s.readBytes((char *)in, frames * 2 * sizeof(int16_t)); /* keep receive drained */
	}
}

static bool startCodec(char *why, size_t n)
{
	const int id1 = readReg(CODEC_ADDR, CODEC_REG_ID1);
	const int id2 = readReg(CODEC_ADDR, CODEC_REG_ID2);
	Serial.printf("anchor-audio: codec id=0x%02X 0x%02X\n", id1, id2);
	if (id1 != 0x83 || id2 != 0x11) {
		snprintf(why, n, "codec id %02X %02X", id1 & 0xFF, id2 & 0xFF);
		return false;
	}

	codec = es8311_create(0, ES8311_ADDRRES_0);
	if (!codec) {
		snprintf(why, n, "codec create failed");
		return false;
	}
	const es8311_clock_config_t clock = {
	    .mclk_inverted = false,
	    .sclk_inverted = false,
	    .mclk_from_mclk_pin = true,
	    .mclk_frequency = RATE * 256,
	    .sample_frequency = RATE,
	};
	esp_err_t err = es8311_init(codec, &clock, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16);
	if (err == ESP_OK) err = es8311_sample_frequency_config(codec, clock.mclk_frequency, RATE);
	if (err == ESP_OK) err = es8311_microphone_config(codec, false);
	if (err == ESP_OK) err = es8311_voice_volume_set(codec, SPEAKER_VOLUME, nullptr);
	if (err == ESP_OK) err = es8311_microphone_gain_set(codec, MIC_GAIN);
	if (err != ESP_OK) {
		snprintf(why, n, "codec init err %d", (int)err);
		return false;
	}
	return true;
}

static void fail(const char *why)
{
	Serial.printf("anchor-audio: result=FAIL reason=\"%s\"\n", why);
	status("AUDIO FAILED", why, RGB565_RED);
}

void setup()
{
	Serial.begin(115200);
	const uint32_t waited = millis();
	while (!Serial && millis() - waited < 2000) delay(10);

	gfx->begin();
	gfx->setBrightness(200);
	gfx->fillScreen(RGB565_BLACK);
	line("AUDIO TEST", 48, RGB565_WHITE, 3);

	Wire.begin(BUS_SDA, BUS_SCL, 400000u);
	/* Bounded: an unbounded transaction that stalls looks like a frozen display, not a quiet codec. */
	Wire.setTimeOut(20);

	pinMode(SPEAKER_AMP_EN, OUTPUT);
	digitalWrite(SPEAKER_AMP_EN, HIGH);

	/* The codec takes its master clock from MCLK, so I2S runs before the codec is configured. */
	i2s.setPins(I2S_BCLK, I2S_WS, I2S_DOUT, I2S_DIN, I2S_MCLK);
	if (!i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
		fail("I2S did not start");
		return;
	}

	char why[40];
	if (!startCodec(why, sizeof(why))) {
		fail(why);
		return;
	}

	talk = (int16_t *)ps_malloc(RATE * TALK_MS / 1000 * 2 * sizeof(int16_t));
	if (!talk) {
		fail("no PSRAM for recording");
		return;
	}

	int passes = 0;
	for (int cycle = 1; cycle <= CYCLES; cycle++) {
		char detail[48];
		snprintf(detail, sizeof(detail), "cycle %d of %d, stay quiet", cycle, CYCLES);
		status("LISTENING", detail, RGB565_CYAN);
		const Window quiet = playAndRecord(false, PHASE_MS);

		status("BEEP", "the speaker should beep", RGB565_YELLOW);
		const Window tone = playAndRecord(true, PHASE_MS);

		const float left = riseDb(quiet.left, tone.left);
		const float right = riseDb(quiet.right, tone.right);
		const float best = max(left, right);
		const bool pass = best >= PASS_DB;
		if (pass) passes++;
		Serial.printf("anchor-audio: loopback cycle=%d quiet_rms_l=%.0f quiet_rms_r=%.0f tone_rms_l=%.0f "
		              "tone_rms_r=%.0f rise_1k_db_l=%.1f rise_1k_db_r=%.1f verdict=%s\n",
		              cycle, quiet.left.rms(), quiet.right.rms(), tone.left.rms(), tone.right.rms(), left,
		              right, pass ? "PASS" : "FAIL");
		snprintf(detail, sizeof(detail), "1 kHz rose %.1f dB", best);
		line(detail, 220, pass ? RGB565_GREEN : RGB565_RED, 2);

		status("TALK NOW", "say something for 3 seconds", RGB565_GREEN);
		recordTalk();
		status("PLAYBACK", "you should hear yourself", RGB565_MAGENTA);
		playTalk();
		delay(800);
	}

	digitalWrite(SPEAKER_AMP_EN, LOW);
	const bool ok = passes == CYCLES;
	Serial.printf("anchor-audio: result=%s loopback_passes=%d of %d\n", ok ? "PASS" : "FAIL", passes, CYCLES);
	char detail[48];
	snprintf(detail, sizeof(detail), "loopback %d of %d, reset to rerun", passes, CYCLES);
	status(ok ? "AUDIO OK" : "AUDIO FAILED", detail, ok ? RGB565_GREEN : RGB565_RED);
}

void loop()
{
	delay(1000);
}
