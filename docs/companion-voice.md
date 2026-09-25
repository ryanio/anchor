# Talking to the companion (proposal)

Status: a design to decide on, not built. The companion on the ESP32 already reacts to readings and
speaks lines built from them (see [the ESP32 notes](devices-esp32.md#the-companion)). This proposal
covers the next step: hold the character, ask it something out loud, and hear an answer.

## What it should feel like

Hold the character and talk: "how's my portfolio?", "what's trending on Solana?", "is STONK up
today?". It listens with wide eyes, thinks with its eyes turned up, and answers in a short spoken
sentence while the reply also appears as its speech line. Answers use the same readings the unit
shows, with their age, and never suggest or perform a transaction.

## What the board has

The probe found an ES8311 audio codec at I2C `0x18` beside the touch controller, IMU, power IC and
real-time clock. Waveshare's own source for this board lists a microphone and a speaker on that
codec and gives the pins, which
[the ESP32 notes](devices-esp32.md#the-microphone-and-speaker) tabulate.
`devices/firmware/esp32/audio/audio.ino` checked them on our unit on 2026-09-25: a 1 kHz tone
played and recorded at once rose over 90 dB above silence at the microphone in every cycle, so sound
crossed from speaker to microphone, and three seconds of speech played back sounded good to the
person holding it. The microphone clips on the unit's own speaker at the test's levels, so the
device listens only while it is not talking.

## Why a relay, and not a key on the device

`docs/security.md` treats a microcontroller as extractable on physical possession, and these units
are handed to strangers. The OpenSea key on them today is read-only and costs nothing to leak. A
speech-to-text, Claude, and text-to-speech key spends money, so it cannot go on a unit. Instead:

```
unit ──HTTPS──▶ relay ──▶ speech-to-text ──▶ Claude (read-only tools) ──▶ text-to-speech
     ◀── reply audio + text + mood ──────────────────────────────────────────────┘
```

- The **relay** holds the provider keys. Each unit holds a **device token** that can only ask
  questions: it cannot move value, change configuration, or reach any other endpoint.
- Tokens are per unit, revocable one at a time, and **rate limited and budget capped per token**
  (for example, 30 questions an hour and a daily spend ceiling), so an extracted token is worth a
  bounded amount of someone else's curiosity.
- The relay keeps no audio. Logs record token, timestamp, duration and outcome, not what was said.
- Claude gets **read-only tools only**: the same public OpenSea reads the device makes, plus the
  unit's configured public addresses. Token names and descriptions are marketplace content and are
  treated as data (AGENTS.md), and nothing in the tool set can act, so a hostile name can at worst
  produce an odd sentence.

This is a second machine in the picture. AGENTS.md wants the handhelds independent of a desktop,
and a relay is a public service, not a desktop. Running it is still a new deployed service with a
running cost, which AGENTS.md lists under "ask a human first".

## On the device

| Piece | Plan |
|---|---|
| Gesture | Hold the character to talk (holding empty glass stays Wi-Fi setup). Release to send. |
| Capture | ES8311 over I2S, 16 kHz mono 16-bit, at most 8 seconds (256 KB) in PSRAM. |
| Upload | One HTTPS POST from the existing feed worker's pattern: bounded, cancellable, generation checked. |
| Reply | Relay returns text, a mood tag, and 16 kHz PCM (or MP3 if a decoder fits) for playback. |
| Faces | Listening (eyes wide), thinking (eyes up, three dots), speaking (mouth opens with the audio level). |
| Failure | Every state says why in the speech line: no Wi-Fi, relay unreachable, over the limit, didn't catch that. |

Memory is the known risk. The LVGL pool is already the tight resource in the 32-network Wi-Fi case
(112,048 bytes peak, 18,496 free), and TLS needs internal RAM. Audio buffers go in PSRAM, I2S DMA
buffers stay small, and talking is refused while Wi-Fi setup is open.

## Build order

1. **Hardware check.** Done on 2026-09-25 with `audio/audio.ino`: the loopback passed three of
   three, and the voice playback sounded good.
2. **Text first.** Relay endpoint that takes the unit's current readings and a typed or preset
   question and returns one sentence. This proves tokens, limits, tools and the reply path with no
   audio at all.
3. **Speech in.** Push-to-talk capture and upload, with the reply shown as text.
4. **Speech out.** Playback and the speaking face.
5. **Fleet.** Provision a token per unit at flash time, the same way the read-only key is supplied
   today, and a revoke list on the relay.

## Decisions for the owner

- Run a relay at all, and where (a small serverless function is enough for six units).
- Which speech-to-text and text-to-speech providers, and the per-unit daily budget.
- Whether answers may mention the configured wallets out loud at a venue, or only on the glass.
- Whether a unit without a working relay should hide the talk gesture or explain itself when held.
