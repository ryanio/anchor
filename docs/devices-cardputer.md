# The M5Stack Cardputer as an Anchor device

The Cardputer is the third shape in the device family, after the Stream Deck and the ESP32 pulse
display, and the first one that is *typed at*. That single fact is what makes it worth a design
document rather than another entry in a geometry table: a keyboard is an input the shared contract
has no vocabulary for, and a 240x135 screen wants a surface the shared contract cannot express.

This document says which of those should change the contract and which should not, where the
proposal queue's approval boundary sits, and what runs on the device.

> **Status: scaffold.** `devices/src/adapters/cardputer.ts` implements `AnchorDevice` and its tests
> run with nothing plugged in. No part of it has been run against hardware — there is none attached.
> Every hardware fact below comes from M5Stack's or Espressif's documentation and is marked. AGENTS.md
> is emphatic that a plausible reading is not a measured one, and this file keeps that distinction.

## What the device is

**From vendor documentation, unverified here.** Cardputer v1.1: an M5Stack StampS3 (ESP32-S3FN8, Wi-Fi
and BLE, native USB) in a card-sized body with a 1.14" ST7789 TFT at **240x135**, a **56-key**
membrane keyboard, a 1400 mAh battery in the base plus a small cell in the Stamp, microSD, IR, a
microphone, a speaker, a Grove port, and USB-C.

Three of them are the "Onchain Mission Control" concept from the field notes: one for the activity
feed, one for the collection and floor watchlist, one for the agent proposal queue. The fourth
concept, "Mint Eligibility Radar", is a feed with a different filter, not a different device.

## Transport: a USB cable, not the network

`service/src/server.ts` opens with the constraint that settles this: it binds `127.0.0.1` only —
**never the LAN, never the tailnet**. AGENTS.md invariant 6 says the same thing from the other side.
A Wi-Fi Cardputer polling the data service would need something to listen beyond loopback, and that
is a security decision with a human's name on it, not an implementation detail an adapter gets to
make.

So the primary transport is **USB CDC serial**, and the trade is deliberate:

| | USB serial (chosen) | Wi-Fi to a bound service | Local MQTT broker |
|---|---|---|---|
| Loopback invariant | untouched | broken — needs a reviewed bind | broken — a broker is a listener |
| Trust boundary | a cable, same as the Stream Deck | the LAN, or a tailnet | the broker, plus its auth |
| New runtime dependency | none (`fs` + `stty`) | none | yes — an MQTT client |
| Three devices on one desk | three cables or a hub | none | none |
| Device can be anywhere | no | yes | yes |

The cable is the honest v1. It keeps the Cardputer exactly as trusted as the Stream Deck — a thing on
the end of a wire — and it costs nothing new to install. The cost is real and worth stating: three
Cardputers scattered around a desk is a nicer product than three Cardputers tethered to one laptop,
and the field notes' architecture sketch does say "local MQTT broker". That is a **later, reviewed
step**, not a thing to slide in; see "Decisions for a human" at the end.

### Framing and encoding

Newline-delimited JSON, one message per line, in both directions. The framing is safe rather than
merely convenient: `JSON.stringify` escapes every newline it could emit, so a message can never
contain the byte that terminates it — including a message built from a collection name, which
AGENTS.md treats as hostile data.

**The wire carries surfaces, not pixels.** `devices/src/types.ts` already anticipates this in the
`Surface` doc comment: "a future ESP32 adapter can send the same surface over the wire and draw it
with its own primitives." Two reasons it is right here too:

- **Size.** A nine-tile frame is a few hundred bytes of JSON. A full 240x135 RGB565 framebuffer is
  64,800 bytes. On a battery, over a serial link, repeated every time a clock digit changes, that
  difference is the whole power budget.
- **Theme.** The host sends the resolved token palette once at connect and again whenever the Omarchy
  theme changes. The firmware therefore never holds a colour of its own — `theme/README.md`
  principle 8 ("never a colour at a call site") survives the cable, and the Cardputer re-themes live
  with the rest of the desktop.

The cost is that the device draws text in its own ROM font rather than the user's fontconfig
monospace. AGENTS.md is firm that the font family is system-wide and not ours to set — but that rule
is about *the user's desktop*, and a Cardputer is not on it. A device with 8 MB of flash and no
fontconfig cannot wear the desktop's typeface, and pretending otherwise by shipping one font we chose
would be worse: it would be Anchor picking a face. The device's font is a property of the device,
like a Kindle's, and that is the honest position.

If it ever matters, the escape hatch already exists: the host can rasterise through `svg.ts` and
`raster.ts` exactly as the Stream Deck does and ship pixels, at 64,800 bytes a frame. That mode is
not built, and it should not be built until someone looks at the semantic renderer and finds it
wanting.

### Message shapes

Host to device:

| `t` | Carries |
|---|---|
| `hello` | protocol version |
| `theme` | theme name, dark flag, the eleven token colours |
| `frame` | paint ops: slot id, rect, the `Surface`, and whether the cursor is on it |
| `query` | the filter box: active flag and current text |
| `backlight` | 0–100 |
| `ping` | liveness, every five seconds |
| `clear` | shutting down |

Device to host:

| `t` | Carries |
|---|---|
| `hello` | firmware version, protocol version, reported screen size |
| `key` | one key, up or down, plus a shift flag |
| `power` | charge percentage and whether it is charging |

That is the whole protocol. Note what is absent, because the absence is the design: there is no
message meaning "do this", "approve", "sign", or "fetch". The device is a screen and a keyboard.

Everything arriving from the device is validated before it is believed: a line over 4 KB is a fault
rather than a message, a key must be a single printable code point or one of eight named keys, and a
charge level is clamped rather than trusted. A USB device on a desk can be unplugged and replaced
with something else that speaks the same protocol, so the adapter treats it the way it treats
marketplace text.

## Surfaces: what a 240x135 screen with a keyboard needs

### What works today, with no contract change

The screen is carved into a **240x24 status bar** and a **3x3 grid of 80x37 tiles**. That maps the
*existing* panel vocabulary onto the device exactly: the strip slot carries `segments`, the nine key
slots carry `keys`, the number row 1–9 presses them, Tab pages, and the arrow keys move a cursor.
`devices/src/adapters/cardputer.test.ts` drives it with an unmodified `Panel` to prove the claim the
device layer exists to make — that a new device is a rendering problem, not a rewrite.

This is genuinely useful. It is the "quick commands" half of the third Cardputer's role, and it works
on the day the hardware arrives.

### What does not work, and why it needs the contract to grow

All three Cardputer roles in the field notes are **lists**: an activity feed, a floor watchlist, a
proposal queue. `Surface` is `tile | bar`. A grid of nine tiles cannot express "row 4 of 37", cannot
scroll, and cannot show a name on the left with a value on the right — which is the shape almost
everything in Anchor already has.

The question the brief asks is whether that is a shared extension or a Cardputer concern. It is
**shared**, and the argument has three parts:

1. **It is already the design system's dominant shape.** `theme/README.md` describes `.rows` / `.row`
   as "a name on the left, a value on the right, an optional second line under the name. The shape of
   almost every list here: floors, deadlines, diary entries, activity." A device vocabulary that has
   tiles and bars but no rows is missing the component the rest of the project is built out of, and
   the widget has already implemented it twice — in CSS and in QML.
2. **It is not Cardputer-specific.** The Stream Deck's 800x100 LCD strip can carry a two-row list
   comfortably. The ESP32 AMOLED auction concept is a list of deadlines. A `list` surface earns its
   place in `types.ts` on the same grounds `bar` did: more than one device wants it, and each renders
   it with its own primitives.
3. **The alternative breaks the layer.** `Panel.build` is the only thing that turns config plus live
   state into surfaces. A surface kind the panel cannot emit is a surface no config can request — so
   a Cardputer-local list type would force the *adapter* to fetch its own data and decide what goes in
   it. That is exactly the coupling the device layer exists to prevent, and it would put a data client
   inside a rendering seam.

The detail view is the same argument one step further. A proposal has a fixed field set and a footer
that says where approval happens, and a footer is not a row; a `list` that can also be a detail is one
name with two layouts, which is how a vocabulary stops being enforceable.

### Proposed additions to `types.ts`

Sketched here so it can be sequenced against the ESP32 work rather than merged blind. **Not
implemented** — the scaffold does not fake these.

```ts
export interface ListRow {
  readonly icon?: string;
  /** Left. Truncates — a defence on a collection name, not just a layout choice. */
  readonly name: string;
  /** Right. Absent renders as an em dash, never a zero. */
  readonly value?: string;
  /** Second line under the name, shown when the row is selected or when there is room. */
  readonly sub?: string;
  readonly tone?: TokenName;
  /** Data we have but can no longer vouch for. Faded, never hidden. */
  readonly faded?: boolean;
}

// added to the Surface union:
| {
    readonly kind: "list";
    readonly title?: string;
    readonly rows: readonly ListRow[];
    /** Index into `rows`, or -1. The panel owns this; the device reports movement. */
    readonly selected?: number;
    /** What to say when there is nothing, so an empty list is never a blank rectangle. */
    readonly empty?: string;
  }
| {
    readonly kind: "detail";
    readonly title: string;
    readonly subtitle?: string;
    readonly fields: readonly { label: string; value: string; tone?: TokenName }[];
    /** One line the renderer must draw last and must not truncate away. */
    readonly footer?: string;
  }
```

Three notes on the shapes:

- `faded` and the em-dash rule are lifted straight out of `theme/README.md` and `panel.ts`. They are
  not new policy; they are the existing policy finally expressible on a device.
- `selected` lives on the surface, which means the **panel** owns selection once lists exist. It has
  to: only the panel knows how many rows there are. The scaffold's grid cursor is device-local
  precisely because the panel has no cursor concept yet, and that is a stopgap, not a position.
- `footer` is non-negotiable for the proposal card and is the reason `detail` is not just `list`. See
  below.

### What does *not* need to change

Worth stating, because the temptation with a keyboard is to add an input kind per key:

| Keyboard use | Existing input | Why it fits |
|---|---|---|
| Arrow keys moving a selection | `rotate` on the list slot, delta ±1 | An encoder detent and an arrow key are the same intent. A Stream Deck dial would drive the same list. |
| Enter | `press` then `release` | Identical to a key on any other device. |
| Number keys | `press` / `release` on `key:n` | A number key *is* a key slot. |
| Tab / shift-Tab | `swipe` on the strip slot | `Panel.handle` already pages on a swipe, in both directions. |
| Cursor movement with no activation | *nothing* | Focus is device-local. The Stream Deck does not report a finger hovering either. |
| Typing characters | **nothing fits** | The one real gap. |

Four of six keyboard uses degrade onto the contract as it stands. The scaffold implements all four
today. Only text needs the contract to grow.

## Text input, and what it is legitimately for

**Filtering and search over what is already on screen. That is the entire list.**

A Cardputer keyboard is good for exactly one thing in this product: typing `azuki` to narrow a
watchlist of forty rows to three. It is a *view* control.

What it is never for, and what the design makes unreachable rather than discouraged:

- **Authorisation.** No password, PIN, passphrase, or confirmation phrase. AGENTS.md invariant 1 and
  the whole of `docs/autonomy.md`: policy is enforced outside the requester. A string typed on a desk
  toy is not a policy input.
- **Secrets of any kind.** No seed words, no private key, no API token. `theme/README.md` principle 4
  already writes the rule for the desktop panel — "anything that needs a secret typed... gets a plain
  one-line instruction and a way to open the right prompt elsewhere, never a field in the UI" — and it
  binds harder here. Keystrokes cross the USB cable as plaintext JSON, the firmware is reflashable by
  anyone holding the cable, and there is no secure element in this design. **Treat a Cardputer as a
  public terminal**, and the rule follows on its own.
- **Addresses and amounts.** A destination typed on this device would be a destination the executor
  never pre-registered, which invariant 2 forbids outright. Nothing on the Cardputer composes a
  transaction, so there is nothing for a number to be an amount *of*.
- **Commands.** The filter string is a predicate, never a verb. It is not evaluated, not dispatched,
  not passed to a shell, and not concatenated into a request path.

Three properties in the scaffold hold this up, and each has a test:

1. **Filtering is a mode, not a modifier.** While the filter box is open, *no keystroke produces any
   `DeviceInput` at all* — not an arrow, not Tab, not Enter. A filter box that can also fire a key
   action is a filter box that dispatches an action by accident, and on a device whose job is showing
   proposals that is precisely the accident to make unreachable.
2. **The box is bounded and clean.** 64 characters, single printable code points only. Control and
   format characters are refused at decode, so a rogue keyboard cannot push terminal escape sequences
   into a string this process later writes to its own stderr.
3. **The committed string goes to a host callback, not into the input stream.** `onQuery` is a public
   method on the adapter, outside `AnchorDevice` — the same pattern `StreamDeckDevice` uses for its
   `tokens` setter. Nothing consumes it yet. That is deliberate: it is a marker for where
   `DeviceInput` needs to grow, not a working side channel.

### The contract change

```ts
// added to the DeviceInput union:
| { readonly kind: "text"; readonly slot: string; readonly value: string }
```

Committed text, not per-keystroke. Per-keystroke would make every character a panel event and would
tempt someone into incremental dispatch; a committed string is a filter being applied.

**Where the filter is applied matters.** It must narrow rows the host already has. If it ever becomes
a query parameter to the data service, then an untrusted device is steering the host's requests, and
that needs encoding, an allowlist of filterable fields, and a fresh look — it is not the same feature.

## The proposal queue, and where the boundary sits

This is the sharpest test in the brief, so here is the answer plainly: **the Cardputer renders a
proposal and can say "I want to look at this". Nothing else. Approval happens on the desktop, by a
human, against a hardware wallet, with the Cardputer not in the path and not consulted.**

### What the device may do

- Show that a proposal exists: its kind, the asset, the ceiling, the expiry, its age, and who drafted
  it.
- Show a queue depth and let someone move through it.
- Mark a proposal that names a **human-only action kind** — `set-approval-for-all`, `approve-delegate`,
  `set-authority` (invariant 3, `HUMAN_ONLY_ACTION_KINDS` in `executor/src/types.ts`) — with a badge
  that is drawn differently and carries no affordance at all beyond "look at this on the desktop".
- Raise the item on the desktop: focus the review window, or fire an Omarchy notification. That is a
  **desktop** action dispatched through the existing `actions.ts` vocabulary — `hypr`, `omarchy` or
  `exec` — and it moves no value. `actions.ts` has already written this boundary down for the whole
  device family: "the device vocabulary contains no verb that moves value... the device's role is to
  *display* it and hand intent to the executor, which decides; it is never the thing that approves."
  The proposal queue is that sentence's first real test, and it does not need a new verb.
- Show the outcome after a human decided, so the queue visibly gets shorter.

### What it must never do, and what stops it

Not "we are careful". Each row is a route that does not exist:

| The wish | What refuses it |
|---|---|
| Write anything at all | The data service refuses non-GET before routing (invariant 4). There is no write route to call, from any client. |
| Approve or sign | `DeviceInput` has no member meaning approval, signature, or key. The adapter cannot construct a message that says yes. |
| Reach the executor | The device speaks only to the adapter, over USB. The adapter imports nothing from `executor/` and holds no credential. |
| Widen a limit | Policy is enforced in the executor backend at signing time (invariant 1, `docs/autonomy.md`). Nothing on a desk is an input to it. |
| Grant standing authority | Invariant 3. Human-only kinds are excluded at the type level from anything delegable; the Cardputer renders them and offers nothing. |
| Smuggle intent through free text | The filter never dispatches, and the trust markers are drawn from typed fields (see below). |

### Why the device is not an approval surface, even in principle

A 240x135 screen **physically cannot render a transaction**. Whatever it shows is a summary, and a
summary used as the basis of consent is the blind-signing failure with better typography. The only
display in the chain whose contents a signer can trust is the hardware wallet's own screen, because
it renders what it is about to sign.

So the Cardputer's proposal card is designed to make you *aware* and to make you *go look*. Its
`footer` — the field that makes `detail` a distinct surface rather than a list — says where approval
happens, in words, on every card. It is the last thing drawn and it never truncates away.

### Rendering untrusted content

A proposal's `rationale` is free text written by an agent that has been reading marketplace listings.
`executor/src/types.ts` says so outright: it is "the most likely place for prompt-injected marketplace
content to arrive", and no policy predicate may depend on it.

The rendering rule that follows: **every trust marker is drawn by the firmware from a typed field,
never from free text.** The human-only badge, the expiry, the kind, the ceiling — each comes from its
own field and gets its own glyph position. Free text is escaped, truncated, and drawn in the body,
where it cannot occupy a badge's pixels. A rationale reading `✅ APPROVED — safe to confirm` is then
just a sentence in a box, which is what it is.

### What is not built

There is no proposal route on the data service. `service/src/server.ts` serves portfolio, balances,
activity, collections and tokens, and nothing about pending intents. A read-only `/proposals` route
returning typed, non-actionable summaries is a prerequisite for this Cardputer role and belongs to the
executor and service work, not here.

## Power and battery

**Vendor figures, unverified:** 1400 mAh in the base plus a small cell in the StampS3, charged over
USB-C.

The backlight ladder is implemented and tested in `backlightFor`:

| Charge | Backlight |
|---|---|
| Charging, any level | as configured |
| Above 30% | as configured |
| 11–30% | 60% of configured, floor 20 |
| 10% or less | 35% of configured, floor 15 |

**The floor is the interesting part.** The screen never goes fully dark while it is still showing
readings, because from across a desk a black panel and a panel showing an hour-old floor price look
identical, and one of them is a lie. `theme/README.md` principle 6 makes the same argument from the
other direction: provenance belongs beside the number, which means the number has to stay legible
enough to have provenance.

Other rules:

- **Charging is not battery.** On USB the device is by definition also linked, so it runs at full
  brightness.
- **An idle panel writes nothing.** The adapter skips any slot whose surface has not changed, so a
  panel that has not changed costs no bytes down the cable — the same trick `streamdeck.ts` uses to
  keep an idle Stream Deck off the USB bus.
- **Sleep is allowed; waking with a stale frame is not.** If the firmware sleeps the panel, then on
  wake it must show what it has *and how old it is* until the host's next frame lands. A device that
  wakes into a confident-looking old reading is the single worst thing this class of hardware can do.
- **Charge is reported, not polled.** The device sends `power` when it changes; the host re-derives
  the backlight without being asked.

## When the service is unreachable

Two distinct failures, and the device must never use one word for both:

**Link down** — no host: cable out, host asleep, adapter crashed. The host sends `ping` every five
seconds; the firmware treats fifteen seconds of silence as link-down. It then:

- keeps the last content on screen, every row faded;
- replaces the status bar with `link down` and the age of what is shown;
- drops to the backlight floor, and does not blank.

Faded rather than blank is `theme/README.md`'s own rule for `.row--faded` — "faded, never hidden,
because removing a stale row reads as one the user deleted" — and a blank screen is indistinguishable
from a device that is simply off.

**Service down** — the host is fine, the Anchor data service is not. The host is still painting, and
the panel already handles this: `SEGMENT_SOURCES["anchor.service"]` renders `anchor · not running`,
and readings render as an em dash rather than a zero, because a zero is a reading and there is nothing
to read. That distinction is already tested in `panel.test.ts`; the Cardputer inherits it for free.
The service being up but having no wallet configured is a third, separately worded state, for the same
reason.

**Proposals under either failure** get the strictest treatment. They stay on screen, marked
unverified, with their age as the headline — a proposal may have been cancelled, filled, or expired
while the link was down, and the device cannot know. The "raise on the desktop" affordance stays,
because it is a desktop action and still exactly the right thing to do. Nothing about the rendering
may imply currency.

**Boot with no host** shows the Anchor mark, the firmware and protocol versions, and `waiting for
host`. Not an empty panel, and certainly not a plausible-looking one.

## Firmware

### What runs on the device

A thin renderer, and deliberately nothing else. It holds:

- the palette, received from the host;
- the slot rectangles, received per frame, so layout stays authoritative on the host side;
- how to draw a `tile` and a `bar` — and, once the contract grows, a `list` and a `detail`;
- the keyboard scan, and the mapping to protocol key names;
- a link-liveness timer and the battery reading.

It holds **no** data model, no wallet, no key, no cache of anything it did not just receive, and — in
the USB build — no network stack at all. Wi-Fi and BLE should be compiled out: an ESP32 with a radio
it never uses is attack surface with no upside, and leaving it out is also the clearest possible
statement that the device does not talk to anything but the cable.

### Framework

**Arduino core for ESP32, with M5Unified / M5Cardputer and M5GFX.** The reasoning is the same one
AGENTS.md applies to OpenSea's packages: prefer the vendor's own tooling over a hand-rolled copy,
because the platform moves and the copy rots. M5GFX is M5Stack's own driver and already knows the
Cardputer's ST7789 offsets — a detail that is exactly the kind of thing to get subtly wrong by hand —
and M5Cardputer provides the keyboard matrix scan.

Alternatives, and why not for v1:

- **ESP-IDF** — more control and a smaller image, considerably more work, and the display and keyboard
  drivers would be ours. Worth revisiting only if the Arduino redraw budget is missed.
- **MicroPython / UIFlow** — fastest to iterate and the obvious choice for a demo, but slower redraws,
  a much larger runtime for something that should be tiny, and a filesystem full of editable source on
  a device the design treats as public.

The firmware needs a JSON reader. ArduinoJson is the usual answer and is a **firmware** dependency —
it does not touch `package.json` and does not affect Anchor's runtime dependency count — but it should
still be pinned and named in the build, and a hand-rolled reader for a seven-message protocol is a
legitimate alternative worth an hour's thought.

### Flashing

Over USB-C. The ESP32-S3 has native USB, so no bridge chip and no driver.

```bash
# Arduino CLI, once the sketch exists
arduino-cli compile --fqbn esp32:esp32:m5stack_stamps3 devices/firmware/cardputer
arduino-cli upload  --fqbn esp32:esp32:m5stack_stamps3 -p /dev/ttyACM0 devices/firmware/cardputer

# or flash a prebuilt image
esptool.py --chip esp32s3 --port /dev/ttyACM0 write_flash 0x0 cardputer-anchor.bin
```

**Unverified, and the first things to check with hardware in hand:**

- Keep *USB CDC On Boot* enabled in the board settings. Disable it and the serial port disappears,
  which reads as a dead device.
- If the port does not enumerate, hold G0 while plugging in for download mode.
- The port should appear under `/dev/serial/by-id/` with an Espressif JTAG/serial descriptor. The
  adapter's port matcher is written against that name and is guesswork until someone looks.
- On Omarchy, logind grants the logged-in user access to the device node, the same as for
  `/dev/hidraw*` and the Stream Deck. If it does not, that is a udev rule, not a permissions hack.

M5Burner is fine for one-off flashing by hand; it should not be the documented path, because a
reproducible build is the point.

### Where firmware should live

Not decided. `devices/firmware/cardputer/` in this repo keeps the protocol and its two ends in one
commit, which is worth a lot for a wire format that will change — but it also puts a C++ toolchain in
a repo whose CI is Node, and `arduino-cli compile` is a slow gate. The alternative is a small
out-of-tree repo pinned by protocol version. **Ryan's call.**

Whichever it is, the build settings are part of the artefact: board, flash size, PSRAM, USB CDC on
boot, and the pinned library versions.

## What the scaffold does today

`devices/src/adapters/cardputer.ts`, with `devices/src/adapters/cardputer.test.ts` running under
`node --test` with no hardware:

- implements `AnchorDevice` in full, with capabilities declaring one strip and nine key slots and
  only the three input kinds the device actually has;
- lays out 240x135 as a status bar plus a 3x3 grid, with a test that the slots tile the screen
  exactly;
- speaks the NDJSON protocol above, validating everything inbound and skipping unchanged slots
  outbound;
- maps the keyboard: arrows move a device-local cursor, Enter and the number row press, Tab pages via
  a swipe, `/` opens the filter;
- runs the filter as a mode in which no `DeviceInput` is emitted at all;
- derives the backlight from the reported charge, with a floor;
- is driven, in its own tests, by an unmodified `Panel` built from an ordinary `panel.json` config.

What it deliberately does not do: fake a list surface, invent an input kind, open a network socket,
add a dependency, or touch shared code.

## Decisions for a human

1. **The contract changes.** `Surface` gains `list` and `detail`; `DeviceInput` gains `text`;
   `panel.ts` gains a slot-id helper for a screen. These land in files the ESP32 work is also touching
   and should be sequenced, not merged in parallel.
2. **A `/proposals` route** on the data service — read-only, typed, non-actionable. Without it the
   proposal-queue Cardputer has nothing to render.
3. **Wi-Fi or a broker**, if tethered Cardputers turn out to be unacceptable. That is a change to
   invariant 6's blast radius and needs `docs/security.md` updated in the same change, plus — for
   MQTT — the first new runtime dependency this workspace would take.
4. **Where firmware lives**, and whether its build is a CI gate.
5. **`O_NOCTTY`.** If it turns out to matter for opening the serial port from a daemon with no
   controlling terminal, `fs.createReadStream` cannot pass the flag and the fix is either a tiny
   native helper or a serial-port dependency. Worth knowing before it is a surprise.
