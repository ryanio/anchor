# Device capability audit: hardware present vs. hardware used

A survey of the three Anchor devices — what each one is physically capable of, what the software
currently exercises, and the concrete, contract-compatible gap between them. Written after the
Cardputer and ESP32 both went from "unverified" to running on real hardware in the same session:
`docs/devices-esp32.md` and `docs/devices-cardputer.md` are the design records for *why* each
device works the way it does; this document is a *what's on the table and not yet played* pass
over both, plus the Stream Deck, checked directly against the current code rather than against
what those docs said when they were written.

**Revised.** Several of the findings below have since been closed, so each one now says what
shipped and — the part that matters more — whether anyone has seen it work. This document keeps
three states apart on purpose and so should you: **measured on hardware**, **reasoned but
unverified**, **not attempted**. A row that was fixed stays here with its outcome rather than being
deleted, because "this was a gap and here is how it closed" is the useful half of a survey. Claims
about the *system* are checked against code and commits; where a design doc has drifted, that is
said about the behaviour rather than about a line number in a file someone else is editing.

Every idea below is checked against `AGENTS.md` invariant 1: no device can be given a way to
approve, sign, or move value, regardless of how convenient the hardware would make it look. Where
an idea would need a human decision rather than an engineering one, it says so and stops.

## Stream Deck (Plus)

### Confirmed present

- 8 paintable key slots, 120×120, `feedbackType: "lcd"` (`adapters/streamdeck.ts:35-42`).
- 4 rotary encoders, **not paintable** — "the Plus has no per-encoder display; models with LED
  rings still are not a raster target" (`adapters/streamdeck.ts:49`). Confirmed by the SDK's own
  `CONTROLS` descriptor, not assumed.
- One `lcd-segment` strip, 800×100, reporting `tap` (x, y) and `swipe` (from, to) — read directly
  off `deck.CONTROLS`, so this is what the SDK exposes for this exact model, not a guess
  (`adapters/streamdeck.ts:57-66`).

### What Anchor uses today

Keys render tiles; the strip renders a `bar` surface. Recent work added: per-dial hint captions
in a top row of the strip (icon + label, laid out in the dial's own zone), an NFT filmstrip wash on
the gallery page, and a `gallery` dial control. Swipe pages the panel. Encoders rotate/press through
`Panel.handle`'s `rotate`/`press` cases.

One thing this device has that the other two do not is somebody looking at it every day, which is
how the second row was found rendering as four blank squares: four keys shipped with `"icon": ""`,
and the icon test above them collected icons with `if (key.icon)`, so an *absent* icon skipped the
loop that was meant to catch a *wrong* one. Fixed on the hardware, with a guard in `config.test.ts`
stating the rule the config actually runs on — a key either reports something (`source`) or does
something (`action` plus an icon) — and the guard was checked by blanking an icon again and watching
it fail. Worth naming in a capability audit because it is the failure mode this whole document is
about, inverted: not a capability present and unused, but a capability *claimed* by a config and
absent on the glass, invisible to everything except a person's eyes.

### The gap

- **Tap is no longer dead, but the deck's own strip still refuses it — deliberately.**
  `adapters/streamdeck.ts:160` emits a real `{ kind: "tap", slot: STRIP_SLOT, x, y }` off real
  hardware input, and `Panel.handle`'s `case "tap"` now does something with a tap: on a **screen**
  slot (`screen:*`, so the ESP32 panel), on one of the four rotating pages
  (`ROTATING_PAGES` — portfolio, gallery, tokens, nfts), it advances the rotation by one item and
  pins it for `TAP_HOLD_MS` (10s) before the shared wall clock reclaims the page. Two taps it still
  refuses, each with the reason in the code:
  - **On the deck's strip.** `handle` returns false for any slot that is not `screen:*`, because
    advancing the rotation from the strip would reshuffle the eight gallery *keys* sitting beside it
    — a device where brushing the strip reorders its own face — and that behaviour has never been
    put in front of a review page.
  - **On a list page, screen or not.** A tap carries pixels and `types.ts` rule 1 keeps pixel
    geometry inside the renderer, so the panel does not know where any row was drawn. The only thing
    it could act on is `#selected`, which would fire whatever happens to be highlighted from a sleeve
    brushing the glass. Row hit-testing needs the renderer to report the boxes it drew; until it
    does, a tap on a list repaints nothing.

  So the original proposal here — a tap in dial *i*'s zone firing that dial's own `press` action —
  is **still unbuilt, and now has an argument against it to answer**: the same "a sleeve should not
  press a button" objection applies, and the dial zones would need the hit-test the list case is
  waiting on. `renderBar` already computes the zone widths, so the arithmetic remains cheap; the
  question is no longer effort but whether a touch strip should dispatch actions at all. Worth a
  decision rather than an implementation.

  What is measured: the deck's strip emits taps off real hardware — that was true before this
  behaviour existed and is why the dead `case` was findable at all. What is *not* measured is the new
  behaviour, and the reason is on the other device: the tap path has tests, including one asserting
  that two untouched panels still pick the same item, and the pulse firmware now sends taps, but the
  only surface the panel accepts them on is a screen whose touch controller has never produced a
  coordinate (below). **No tap has travelled from glass to a rotation, on any device.**
- **Encoders have no readout of their own**, confirmed by hardware, not a software gap — the strip
  hint row is the correct compensation and already ships. No further work implied; noted so the next
  reader does not re-propose an LCD-ring feature this model does not have.
- **The strip's `tap`/`swipe` `x`/`y`/`from`/`to` are in device pixels of an 800×100 image**, and
  nothing currently derives "which dial zone" from an `x` — that arithmetic would live in
  `Panel.handle`, mirroring what `renderBar` already does for drawing the zones, so the two stay in
  sync by construction rather than by two independent constants.

No contract change needed for any of the above — `tap` and `swipe` are already in `DeviceInput`.

## ESP32 pulse display

### Confirmed present (measured on the bus)

Waveshare ESP32-S3-Touch-AMOLED-1.8, V2. From the I2C probe (`devices/firmware/esp32/probe/`),
every device on the bus identified by its own identity register, not by address alone. "Present on
the bus" and "answers usefully" are two different measurements, and the first two rows are where
they come apart:

| Address | Chip | Status in Anchor today |
|---|---|---|
| 0x15 | **CST820 capacitive touch** | **Read, unproven.** `app/sensors.cpp` polls it and the firmware claims `tap`/`swipe`; no coordinate has ever come back. See below. |
| 0x6B | **QMI8658 IMU** | **Proven on hardware, wired to nothing on purpose.** See below — this is a decision, not a gap. |
| 0x34 | AXP2101 power management | Not read. Would give real battery/charging state for an ambient display that is currently assumed to be USB-powered always. |
| 0x51 | PCF85063-class RTC | Not read. A wall-clock without asking the host would survive a host-down period, which is exactly the failure mode this device is designed to be honest about. |
| 0x18 | ES8311 audio codec | Not read. No plausible use for a wallet display; noted for completeness, not a gap worth closing. |
| 0x20 | TCA9554-class IO expander | Not read; likely wired to panel reset/backlight control the display driver already owns. |

### The stale claim, now fixed — and what replaced it

The firmware used to say, in a comment beside a zero input mask:

> "The input mask is zero: this board reports nothing. There is no touch panel, no keyboard and no
> IMU on it."

That was the exact inversion of what the probe had measured on this same board — a CST820 at 0x15
and a QMI8658 at 0x6B, both identified by reading their identity registers, not guessed from an
address — and it survived because an inputMask of 0 compiles and runs fine, so nothing exercised
the mismatch. The comment is now corrected, and `say_hello()` declares tap and swipe. The record of
how it was closed is worth keeping, because the *shape* of the mistake is this project's own named
failure mode: a false "not present", stated as a fact about hardware when it was really a fact about
what nobody had wired up yet.

What replaced it, and in which of the three states each part sits:

- **Measured on hardware.** A bringup sketch, `devices/firmware/esp32/sensors/sensors.ino`, in the
  shape `probe/` established, asked both chips what they say when a person actually uses them. The
  **IMU answered completely**: WHO_AM_I 0x05, revision 0x7C, control registers reading back exactly
  as written, and a clean 1.05g gravity vector at the ±2g scale factor. It also found two things
  worth finding in a sketch rather than in the protocol firmware — the touch part refuses a six-byte
  burst read from 0x01 while answering single-register reads, and an unbounded `Wire.setTimeOut`
  turns a quiet sensor into a display that appears to freeze.
- **Reasoned but unverified.** The **touch controller identifies itself** (chip 0xB7, vendor 0x41)
  **and has never produced a coordinate.** `app/sensors.cpp` now reads it one register at a time
  with a stop rather than a repeated start, on a 20ms beat, every read checked, a missing chip simply
  never producing an event; tap and swipe are recognised from coordinates rather than from the
  controller's gesture register, because parts in this family differ over whether that register is
  populated at all. It compiles and links (390,004 bytes, up 804, so it was not stripped) and HELLO
  claims the two kinds. **No finger has confirmed any of it.** Whether the silence was the burst read
  this code now avoids or something else entirely is the open question, and it needs a hand on lit
  glass to answer. Until then, treat ESP32 touch as claimed, not working — including the host-side
  tap behaviour it is the only source for.
- **Decided, not missing.** The IMU — the proven one — is deliberately behind no input bit.
  `app/sensors.h` gives the reason: this display's job is to sit still on a desk and be glanced at,
  and a page that turns because somebody set a mug down beside it is a worse device. Tilt went to the
  Cardputer, the unit already in a hand. Anyone reading "the IMU is unused" as a gap should read that
  file before proposing to close it.

### What Anchor uses today

The wire protocol (`esp32-wire.ts`) carries `press`, `release`, `rotate`, `tap`, `swipe` in
`INPUT_BITS` and decodes all five; `HELLO`'s `inputMask` is the device's own declaration of which it
actually sends, and it now names tap and swipe rather than nothing.

The screen-shaped page the design record asked for exists: `Panel.pulseDetail()` gives the four
rotating pages an ambient `detail` surface — portfolio stats over rotating art, gallery as a
full-bleed frame for one piece, and the same treatment for trending tokens and NFT collections —
instead of the list-of-rows every other page gets, with review cards in `devices/src/review.ts` so
it can be looked at rather than reasoned about. Two things ride on that rotation: a sync bar drawn
from `rotationProgress()`, which makes visible the agreement several units already had for free
(the index is a function of the wall clock, not of per-process state), and tap-to-advance, which
holds a summoned item for ten seconds as an offset over that clock so an untouched unit is unchanged
to the millisecond and a tapped one rejoins when the clock catches up. The tap half is host-side and
tested; the device half is the unproven touch controller above.

### The gap

- **Touch → tap/swipe — built, and the last measurement is missing.** This was the headline gap and
  it cost no protocol change, exactly as predicted: the firmware reads the CST820 and calls
  `anchor_pulse_input`, `say_hello` sets the two bits, and the host decodes them through a path that
  already treated device-reported input as untrusted (`HOST_BOUND_TYPES`) — a slot id plus two
  numbers cannot express anything invariant 1 would need to refuse. What remains is not engineering:
  put a finger on the lit panel and see whether a coordinate arrives. If one does, everything
  downstream of it is already written and tested. If none does, the next question is whether this
  part serves coordinates at all in this configuration, and the bringup sketch is the place to ask.
  **This is the single most valuable unperformed measurement in this document.**
- **Tilt-to-explore, from the IMU — withdrawn on this device, and shipped on the other one.** The
  design record scoped motion-becomes-`swipe` for the pulse display; the firmware now declines it on
  purpose (see above) and the same gesture went to the Cardputer instead, where the unit is already
  being held. Recorded as a closed item rather than an open one so nobody re-proposes it from the
  chip list: the IMU being present and unused is the *answer* here, not the gap.
- **Battery/charging state, from the AXP2101**, would let the ESP32 report real power state instead
  of the current implicit assumption of permanent USB power. This *is* a small contract question:
  either extend `power` (already device→host in the Cardputer's own vocabulary — see below) to the
  ESP32's HELLO/INPUT path, or accept it stays USB-tethered by design, which the design doc already
  argues for explicitly ("Assume USB-C power for the first build. A battery-powered pulse display is
  a different project"). Worth a decision, not a default: don't add battery reporting for a device
  the design intentionally scoped as wall-powered without first checking that's still the plan.
- **The Auction Hourglass and Agent Memory Shrine** are named in the design doc's opening paragraph
  as sharing this same transport and are unbuilt. Both are new `pulseDetail`-shaped pages (a
  countdown surface, an agent-status surface) rather than new protocol — the same shape of work
  `pulseDetail` just did for portfolio/gallery. Effort: moderate, mostly in deciding what an "agent
  status" reading even is; Anchor has no live connection to Hermes today, so the Shrine specifically
  needs a data source before it needs a screen.
- **The RTC (PCF85063)** would let the device keep local wall-clock time through a host-down period,
  which matters specifically because the firmware already dims and then blanks when the host goes
  quiet — saying "this is not live" without claiming to know more; a device that also knew what time
  it was could caption *how* stale rather than just going dark. Small firmware addition, no protocol
  change (the caption is drawn host-side from data the device would report over an already-existing
  channel, or the device could compute "stale since HH:MM" once it owns a clock — either way this is
  a nice-to-have, not a gap anyone asked to close).

## Cardputer

### Confirmed present

From vendor documentation (M5Stack StampS3) — the design record's "unverified, none attached"
framing is **superseded for the firmware and the USB link**: the Cardputer is flashed and running on
real hardware (the "waiting for host" USB-write reliability bug and a full-screen
redraw-on-every-frame flicker were both found and fixed against the physical unit). The statements
about individual chips below are still vendor-sheet or flint's claims, not measured the way the
ESP32's bus was:

- 56-key membrane keyboard — **in active use** (nav, filter, number-row press).
- 1400 mAh battery + StampS3 cell, charged over USB-C — **connected but not surfaced** (see below).
- **A BMI270 IMU** — present on the ADV, reached only through flint's `motion::` (which is flint's
  own rule: no view touches the IMU directly) and **now in use** for tilt-to-page. Note that the
  design record's "What the device is" section describes a Cardputer **v1.1** body and lists no IMU
  and no touch panel; the unit Anchor actually drives is an **ADV**, and `motion::available()` exists
  precisely because the original has no IMU and M5Unified's probe can miss one. So: no touch panel,
  correctly nothing proposed there — but an IMU that the earlier pass of this audit went looking for
  in the wrong spec sheet and concluded was absent. Never measured by Anchor; flint's header says
  M5Unified brings it up inside `M5Cardputer.begin`.
- microSD, IR, microphone, speaker, Grove port — not read by Anchor's app, no design-doc argument for
  why they should be. Not a gap; a wallet's ambient display has no obvious use for a microphone. The
  speaker now has a measurement against it rather than an argument: a drum-machine view was tried on
  the unit and dropped, because the ADV's speaker could not carry it.
- ST7789 240×135 TFT — in use, with flint's status bar taking the bottom 12 rows
  (`CARDPUTER_FLINT`, a 123-row working area, tested to tile exactly).
- **WiFi and BLE on the StampS3** — the radio was scoped out by the original design, which chose a
  cable because a WiFi Cardputer *polling the data service* would need something listening beyond
  `127.0.0.1` and that is invariant 6. It is now **used, narrowly and in a way that does not touch
  that argument**: standalone mode talks to OpenSea directly and never to the host's service, so
  nothing on this machine binds any wider. See below — the trade it does make is a different one.

### What Anchor uses today

Keys, the filter/text protocol, `swipe`-via-Tab paging, and the derived backlight ladder
(`backlightFor`, floors at 20%/15% under low charge) are all implemented and tested with the device
now confirmed working. `Surface` has both `list` and `detail` (`types.ts`), landed as shared work
with the ESP32 rather than as the per-device additions the design record listed as proposed.

Three capabilities have been picked up since, and **not one of them has been confirmed working on
the physical unit**. Every one builds for both targets and runs in flint's simulator, which is the
shape being right rather than the feel:

- **Tilt-to-page** (`tiltPage()` in `app/src/anchor.cpp`). Tip the right edge down for the next page,
  the left for the previous. It sends the same `tab` keystroke Tab already sends rather than
  inventing a gesture message, so the host keeps one mapping and nothing about the wire changed. The
  thresholds — fire at 25°, re-arm inside 10°, a 600ms holdoff, and a face-up check so `atan2`
  reading a flip as ±180° cannot page on the way over — are **reasoned from flint's own filter
  constants, not felt in a hand**. Inert while the filter box is open, for the reason the arrow keys
  are.
- **Standalone WiFi mode** (`app/src/standalone.cpp`). With no host on the cable past a grace period,
  the unit fetches OpenSea trending itself and draws it, after a three-second screen naming what it
  is. This reverses the original cable-only scoping, knowingly: it needs an API key compiled into the
  device, which flint's own rules forbid and this repository's design argued against, and Ryan took
  that trade explicitly for a unit carried away from the desk. Everything is gated on the key being
  compiled in at both the definition and the call site, so a checkout without `app/src/secrets.h`
  builds and behaves exactly as before the file existed. Worth re-reading as a *decision* before
  anyone treats it as precedent.
- **Two of flint's own views in the build** — Maze and Calm, named in `FLINT_PROFILE_VIEWS` in
  `platformio.ini`, for a unit handed to somebody who has never seen Anchor. Picked for costing
  nothing to be wrong about: no network, no store prefix, nothing touching Anchor's data or wire
  protocol. A third was in the build briefly and is the one piece of this that *did* get measured:
  Beat, a drum machine, was tried on the unit and dropped, because the ADV's speaker cannot carry
  one. A negative result on real silicon, which is worth more than the two that still compile only.

### The gap

- **Battery percentage is invisible — still, and this is now the cheapest open finding here.**
  `CardputerDevice`'s `#power` field and `onPower()` handler exist in `adapters/cardputer.ts`, the
  device sends `{ t: "power", percent, charging }` every `POWER_MS`, and the adapter consumes it —
  but only to derive the backlight through `backlightFor`. Re-checked: `cli.ts` still never calls
  `onPower()`, and `panel.ts` has no battery reading or segment source. So nothing tells a person
  looking at the screen that the unit is low until the backlight itself dims, which is the device
  reporting its own state by getting harder to read. Effort: a reading/segment source in `panel.ts`
  over a percent threaded from the adapter into `PanelState` the way `timeframe` already is — no
  contract change, no new device capability, purely wiring what already crosses the wire.
- **An IMU is present after all — and is now used.** The earlier pass of this audit checked the
  design record's "What the device is" list, found neither touch nor an IMU, and concluded there was
  nothing to propose. That list describes a Cardputer v1.1; the ADV on the desk has a BMI270, flint
  exposes it as `motion::`, and tilt-to-page is built on it (above). The correct residue of this row
  is narrower and still true: **there is no touch panel on this device**, so nothing touch-shaped
  should be proposed for it — and the lesson is the general one, that a vendor list for a *nearby*
  model is not a measurement of the unit you have.
- **The proposal queue is the one deliberately-unbuilt role**, and it is unbuilt for a reason that is
  not a hardware gap: `docs/devices-cardputer.md` already specifies the full design (a `detail` card
  with a footer that never truncates, a badge for `HUMAN_ONLY_ACTION_KINDS` — invariant 3 —
  drawn from typed fields never from free text) and the blocker is a missing `/proposals` route on
  the data service, which is explicitly out of scope for the device layer. `Surface`'s `detail` kind
  exists now — it landed for the ESP32's ambient page — and is directly reusable here with no further
  contract work: the Cardputer side of this feature is more ready than the design record believed,
  and the remaining work is entirely in `service/` and `executor/`, not in the device layer.
- **Nothing about this device should render an approval affordance beyond "look at this on the
  desktop."** Restated here because it is the one idea in this audit where the temptation runs the
  other way — a keyboard *feels* like an obvious place to type "yes" — and `docs/devices-cardputer.md`
  already closes that door explicitly, correctly, and in detail (invariant 1, invariant 2 on
  pre-registered addresses, invariant 3 on delegated authority). Nothing here proposes reopening it;
  flagged so a future reader does not mistake "the Cardputer has a keyboard" for "the Cardputer could
  confirm a transaction."

## A capability nobody listed: being the right device on the end of the cable

Not one of the chip-level gaps above cost this project as much as the plainest capability of all —
a driver attaching to *its own board*. The pulse display's service had restarted **6,601 times**,
read off the unit's own journal. Most were `no serial port found` on a five-second loop while the
board was unplugged; the rest, once both boards were on the desk at once, were `connected but sent
no hello within 5000ms`, because the pulse driver had opened the **Cardputer's** port.

The mechanism is worth naming in an audit about what hardware reports, because it is a case of
hardware reporting *too little*: `listPorts()` matches `/espressif|usb_jtag|m5stack/i`, and every
ESP32-S3 with native USB enumerates through the same Espressif JTAG/serial descriptor. A Cardputer
and a pulse display are indistinguishable until one of them speaks. `cli.ts` took `listPorts()[0]`,
which with two boards is a coin flip whose losing side is a handshake timeout, an exit, and a restart
into the same coin flip.

Both drivers now try every candidate and keep the one that answers *as the device they asked for*,
with the probe timeout dropped to 2s when there is a list to get through (a pulse display re-announces
every 500ms, so two seconds of silence is an answer), closing any port that turns out not to be
theirs rather than holding one that belongs to another service. A path given by name is still taken
at its word, with its own error reported. The unit file also pins the pulse display by its stable
`by-id` path, the way the Cardputer's already did.

**Measured on hardware**, both boards plugged in at once: each service attaches to its own board and
`NRestarts=0`. That is the falsifiable half — the previous arrangement produced a restart count
nobody could mistake for healthy, and this one produces none.

## Cross-device pattern worth naming once

Every gap in this document that turned out to be genuinely free was free because the *wire protocol
already carried it* and one end simply did not use it. Three have now been taken: the host reads
taps, the pulse firmware sends them, and the Cardputer turns a lean into the keystroke Tab already
sent. None of the three needed a `types.ts` change, which is the claim this document made and which
the implementations bore out.

What is left divides cleanly, and the division is more useful than the list:

- **Wiring, cheap, nobody has done it** — the Cardputer battery percentage. The data crosses the wire
  every `POWER_MS` and is read only to dim a backlight.
- **Built but unmeasured** — ESP32 touch, Cardputer tilt, standalone WiFi mode. Each needs a person
  and the physical unit, not an engineer. The habit this project keeps insisting on applies hardest
  here: a device that compiles is not a device that works, and "the code is on the board" is a claim
  whose falsification test is somebody's finger.
- **Scope decisions, not wiring** — the proposal queue (needs a `/proposals` route in `service/`),
  and ESP32 battery/RTC (needs a decision about whether that display is allowed to stop being
  USB-tethered). Both have a paragraph in the relevant design record making the case; neither has
  been overtaken by anything landed since.
- **Decided against** — the pulse display's IMU, and a tap on the deck's strip. These are answers
  wearing the costume of gaps, and the reasons live in the code beside them. Read those before
  re-proposing either.
