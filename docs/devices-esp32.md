# The ESP32 pulse display

## Current independent app runtime

The LVGL pool is 128 KiB, allocated from PSRAM first. The former 64 KiB pool hung when opening
Wi-Fi from Explore: a 7,872-byte render layer exceeded the largest free block of 7,232 bytes.
96 KiB passed the ordinary flow but exhausted memory with 32 scan results. At 128 KiB, the simulator
completed the maximum scan and opened the keyboard with 26,960 bytes free in its LVGL pool.
The simulator fails on allocation warnings and reports peak usage. This does not measure the
separate TLS stack or internal heap on the physical board.

The supported target is the Waveshare AMOLED `pulse/` firmware described in
[device development](device-development.md). It fetches and renders on the device. Earlier USB
pixel transport and provisioning proposals later in this document are historical designs.

The ambient screen has an Explore button. Explore lists trending tokens, opens a token's price,
24h change, volume, and full identity, and links to the configured portfolio and Wi-Fi settings.
The list, details, and portfolio use the existing LVGL chooser components. Each row is a 28 px
reading with a 20 px label, sized for the physical panel as described under
[the panel is 29 mm wide](#the-panel-is-29-mm-wide-so-size-for-a-fingertip-not-for-pixels). A selected token is
identified by chain and address; a touch captures that identity before a refresh can reorder rows.
A token that leaves the list retains its last reading with a saved/stale label. Freshness and wallet
coverage stay visible.

Pulse Wi-Fi owns the radio. The feed receives configuration, connection, setup, and network revision
state from the main loop. One worker handles one immutable request at a time. Network changes,
opening setup, and wallet changes invalidate unfinished work. Only the main loop publishes display
state, after checking the request generation. Previous wallet totals are cleared when the address
list changes. Transport phases and response-body time are bounded; cancellation lets the worker
unwind its own HTTP/TLS objects.

Prices, volumes, changes and portfolio totals are formatted with the Cardputer's exact rules from
`firmware/common/display_format.h`, and cached readings describe their age with
`firmware/common/freshness.h`.

Up to four successfully joined networks are remembered. Selecting a remembered network reuses its
password. A failed replacement preserves and restores the previous good configuration. Wi-Fi
association is separate from an OpenSea response, so connected Wi-Fi alone is not reported as
working internet. Captive portals and iPhone hotspot behavior need physical testing.

The simulator uses the firmware's own setup and loop exactly once. Scripted taps and visible-label
assertions exercise navigation; host C++ tests exercise the request coordinator. Neither can verify
panel addressing, touch settling on glass, TLS stack headroom, radio behavior, or battery runtime.
Those observations belong in the hardware inventory after testing.

## Boot diagnostics on 2026-09-22

The flashed `0716006` demo build reached its startup banner on the identified Waveshare unit. It
reported the CO5300 panel up, a 70,656-byte draw buffer in internal RAM, 206,016 bytes of internal
heap free with a 155,636-byte largest block, and 8,249,424 bytes of PSRAM free. The LVGL pool reported
127,404 total bytes and 107,904 free. These are boot readings, before a live TLS workload was verified.

The tearing-activity probe counted 18 transitions in 150 ms; its historical banner comment expects
34 to 36. That difference needs comparison with the visible panel before changing the driver. A
startup banner and memory readings do not establish touch quality, frame rate, or network operation.

## Health line for long runs

Once a minute the `pulse/` firmware prints one line to Serial:

```
anchor-pulse-lvgl: health up=60s heap=... largest=... heap_min=... psram=... lv_free=... lv_largest=... lv_used=29% worker_stack_min=... http=200 trending=online portfolio=online battery=87% usb charging
```

`heap_min` is the lowest the internal heap has been since boot, and `worker_stack_min` is the fetch
task's stack high-water mark (0 until the worker has run). A `lv_largest` that keeps falling means the
LVGL pool is fragmenting. For an endurance run, keep a serial monitor attached and compare the first
and last lines. The line prints only integers and fixed words, never text from the network. The
simulator's `health` scenario runs past the first minute and requires the line
(`--expect-serial`). The simulator's heap figures are fixed stand-ins, so only the board's numbers
mean anything.

## Historical host transport design

The sections below record the earlier USB/LAN display experiment. They do not describe the supported
independent `pulse/` build. Its network fetches and rendering run on the device, as described above.

The second Anchor device, and the first that is not on a bus.

The Stream Deck taught the device layer what a device is: it declares slots, Anchor paints surfaces
into them, and it emits input. `devices/src/types.ts` is deliberately medium-neutral about all
three. This document is what happens when that abstraction meets a device that is a small computer
on a network rather than a peripheral on a cable, and it exists because three of the answers are not
obvious and one of them is a security decision.

The milestone this serves is the one in the field notes: *one wallet gallery/theme plugin plus one
ESP32 portfolio-pulse display*. The same design carries the Auction Hourglass (a countdown that
shifts colour as the end approaches) and the Agent Memory Shrine (what the local agent is doing) —
they are different surfaces on the same transport, not different devices.

## What changes when the cable goes away

USB-HID gives three things away for free, and none of them survives the move to a network:

| On the Stream Deck | On an ESP32 |
|---|---|
| Being plugged in **is** the authorisation | Anyone on the LAN can open a socket to it |
| The device is present or it is not | It is reachable, unreachable, or lying about which |
| A frame is a `write()` that either lands or throws | A frame is packets, on a radio, with a budget |

So this design has to answer, concretely: who connects to whom, what proves what to whom, what a
frame looks like on the wire, and what the display shows when it stops hearing from us.

## Transport

### Anchor is the client. The device listens.

This is the decision the rest of the design falls out of, and it is made for one reason:

> **AGENTS.md invariant 6.** Nothing Anchor runs binds beyond `127.0.0.1` without an explicit,
> reviewed reason.

A frame server on the desktop, listening on the LAN so displays can connect to it, is exactly the
thing that invariant forbids. Inverting the usual direction keeps it intact at no cost: the ESP32
runs a one-connection TCP listener, the host opens an outbound connection to it, paints down that
socket, and reads input back up the same socket. **The Anchor process binds nothing.**

What this buys, beyond the invariant:

- The desktop's attack surface does not grow. A hostile device on the LAN cannot reach a listening
  Anchor port, because there isn't one. It can only answer a connection we chose to make, and
  everything it can then say goes through one parser that accepts three message types.
- The host decides when a device exists. Pointing Anchor at a display is a config change, not an
  arrival event that a stranger on the network can manufacture.
- Input and frames share one connection, in both directions, with no second listener and no
  callback URL.

The cost is that the ESP32 is now the thing with an open port, which is discussed under
[Putting an Anchor surface on a LAN](#putting-an-anchor-surface-on-a-lan). That is a real cost and
it is the reviewed reason this design needs sign-off on.

### The cable comes first

Everything above describes the display on a shelf, and it is still the end state. The firmware in
`devices/firmware/esp32/` speaks the identical protocol over **USB CDC serial**, and that is how the
first Anchor frame on real glass arrived — down a cable, not a radio. It is still how every frame
arrives today: there is no Wi-Fi and no TLS-PSK in the running firmware, which is a deliberate
ordering rather than an unfinished one.

Two reasons, and the second is the one that matters.

**It removes five things that can be wrong before the first pixel.** A network display needs an
SSID, a password, a provisioning portal, a generated pairing key and a QR code scanned off a screen
that is not drawing yet. A cable needs none of them, and nothing upstream of the transport changes:
same surfaces, same rasteriser, same theme, same dirty-rect diff, same bytes on the wire. Moving to
Wi-Fi later replaces two functions in the sketch and `openSerialLink` on the host.

**It makes invariant 6 vacuous rather than merely satisfied.** The inversion above — the device
listens, Anchor dials out — is what keeps the invariant true of a device on a network. Over a cable
there is no socket, no port, no address and no route at all: the bytes never enter a network stack,
so there is nothing on any LAN to reach, and no eavesdropper for a pairing key to protect against.
That is strictly stronger than the loopback exemption `checkTransport` already grants, which is why
`esp32-serial.ts` is allowed in the clear while a LAN address without a key is still refused. The
trust boundary becomes a wire, exactly as it is for the Stream Deck.

The one thing a cable adds is noise. On a native-USB ESP32 the ROM bootloader and the second-stage
bootloader write to the same CDC endpoint the protocol uses, so the first bytes after opening the
port are not ours and handing them to `decodeMessages` reports a working device as out of frame.
`findHello` resynchronises once, before the handshake, matching on the magic byte *and* a plausible
length field. It does not loosen the parser: a peer that goes out of frame after the handshake is
still a peer to hang up on.

### What was rejected

**An MQTT broker.** The field notes' architecture sketch has one, and it is the natural choice for
fan-out to several devices. It is not chosen here, for four reasons that compound:

1. `docs/security.md` already says: *never expose an unauthenticated dashboard, MQTT broker, or API
   to the LAN or internet.* An authenticated one is possible; it is a per-device ACL scheme, a
   credential store and a TLS configuration to get right, and none of that is Anchor's problem to
   solve well.
2. It is a new daemon to install, run, supervise and package — for a project whose install target is
   one Arch package.
3. It is a new runtime dependency (a broker, and a client library), and the devices workspace
   currently has exactly one.
4. A broker is a bus. A bus makes it *easy* to add a topic that carries something other than pixels,
   which is the direction this design is specifically trying not to be able to go.

Revisit it when there are five devices and the fan-out actually hurts. With one display, a broker is
a message queue between two processes that already have a socket.

**HTTP long-polling or WebSocket.** Both want a server on the host, which is the invariant problem
again. Node has a built-in WebSocket *client* but no server, so a host-side WS endpoint means either
hand-writing the handshake and framing or taking a dependency. Neither earns its place over a length-
prefixed binary stream that the firmware can parse in a fixed-size buffer with no allocation.

**mDNS discovery.** Convenient and dependency-free *if* the host resolves `.local` through NSS —
which is a property of the user's machine, not something Anchor can assume. More importantly, it
advertises. A device announcing itself as `anchor-pulse.local` tells everyone on the network that
this desk has a crypto wallet on it, which is a physical-security fact about the owner and not just
a network one. **Configure an address.** A DHCP reservation with a neutral hostname is one line in a
router and leaks nothing.

### Pairing

The device and the host authenticate each other with a **pre-shared key over TLS-PSK**. No
certificates, no CA, nothing to expire — a PSK is the right shape for two endpoints that know each
other and nobody else.

**Measured on this machine, Node 26.8.1, over loopback:** `node:tls` with `ciphers: "PSK"` and a
`pskCallback` on both ends negotiates `ECDHE-PSK-CHACHA20-POLY1305` and moves data;
`PSK-AES128-GCM-SHA256` also negotiates when named explicitly. **A mismatched key fails the
handshake** with `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC` rather than connecting — the control was made
to fail before it was trusted, per AGENTS.md. TLS 1.2 is pinned because TLS 1.3 moves PSK onto the
session-ticket path and the plain PSK suites are 1.2. **Zero dependencies**, which is why this rather
than a hand-rolled handshake.

*Not measured:* that an ESP-IDF mbedTLS build negotiates either suite. That is the first thing to
check with hardware in hand, and the fallback if it does not is to pick whichever PSK suite the
firmware's mbedTLS config does offer — the host side is one string.

The key lives in the **OS keyring**, as `service anchor key device-<name>`, read with `execFile` and
never a shell so it is never in argv or shell history. It has **no environment-variable escape
hatch**: unlike the OpenSea API key, this is the only thing between a LAN and a live portfolio.

`checkTransport()` in the adapter refuses to paint a non-loopback address with no key. That is a
function rather than a paragraph because a rule that is only written down is a rule that gets skipped
once. Loopback is allowed in the clear, for an emulator and for CI.

> A note from the first run of the tests: the first version of `isLoopback` matched `/^127\./`, which
> called `127.example.com` — a hostname somebody else controls — loopback, and would have waved a LAN
> device straight past the key requirement. It matches a dotted-quad now. The test that found it is
> the one that asserts the negative case.

### Provisioning

The device needs a network and a key; it must get neither from a file on an SD card and neither over
the air.

1. **First boot** — no credentials in NVS, so the firmware brings up a SoftAP with a
   captive portal (ESP-IDF's `wifi_provisioning` or Improv-over-serial). The user gives it an SSID
   and password over that AP, and the AP shuts down permanently once NVS is written.
2. **Pairing** — the device generates a 32-byte key on first boot from the hardware RNG, stores it in
   NVS, and shows it on its own screen **as a QR code**. The user scans it into `secret-tool` on the
   desktop. The key is therefore **displayed, never transmitted**, which is the one channel a network
   attacker is not on.

   A QR code rather than hex text on purpose: it is squares, so it needs no font, and the claim above
   that the firmware owns no typeface survives its own provisioning screen. A hex fallback would mean
   baking a bitmap font in for one screen, which is a small crack in the thing this design is built
   on. If scanning turns out to be a bad experience in practice, the alternative that keeps the key
   off the network is to generate it on the desktop and write it into NVS over **USB serial while
   flashing** — a cable is a channel a network attacker is not on either, and it needs no screen at
   all.
3. **Re-pairing** — a physical button held at boot wipes NVS and returns to step 1. Physical presence
   is the reset authority, which is the only authority a device on a desk can honestly claim.

## The wire format

### The decision: render on the host, ship pixels

`Surface` is medium-neutral by design, and the tempting reading of that is "send the surface, let the
device draw it". That is the choice this design rejects. Both options were costed.

**Sending the model** is dramatically smaller. A pulse tile serialises to **96 bytes** of JSON; the
bar on the strip page is **162 bytes**. Against a 3 KB pixel delta that is a 34× difference, and it
would let a countdown tick once a second with no network at all.

But it moves the design system into the firmware, and that is where the cost lives:

- **The font.** AGENTS.md is unambiguous that the family is system-wide and not ours to set:
  the Omarchy shell defaults to `monospace` so every surface follows the fontconfig alias
  `omarchy font set` writes. Anchor's SVG faces go through RSVG and fontconfig and pick up whatever
  the user chose. A device drawing its own text does not have fontconfig; it has whatever font was
  flashed into it. And the icons are Nerd Font glyphs in the private use area, so "just ship a font"
  means shipping and matching a specific Nerd Font patch.
- **The theme.** Every colour resolves from the live `colors.toml` (`theme/README.md` principle 8).
  Sending the model means either sending the resolved palette too and re-implementing
  `tokens.ts` on-device, or letting the device hold its own idea of the theme — which is the "one
  widget that ignores the user's desktop" failure the widget doc warns about, in hardware.
- **Every design change becomes a firmware flash.** A tweak to how an active tile is tinted ships as
  a binary to every display on the desk.
- **Two renderers drift.** The Stream Deck and the site and the widget already share one vocabulary.
  A third renderer with its own layout arithmetic is a second source of truth about what Anchor
  looks like, and the one nobody screenshots is the one that rots.

And the bandwidth objection to pixels turns out to be much weaker than it looks once the frame is
diffed and packed. **Measured on this machine** (ImageMagick 7.1.2-30, the same rasteriser the Stream
Deck adapter uses, rendering a real pulse tile with an icon, a label and a meter):

| Panel | Full frame, raw | Full frame, RLE | One label change, on the wire |
|---|---|---|---|
| 466×466 | 434,312 B | **17,499 B** (4.0%) | **3,227 B** (0.74% of a frame) |
| 240×536 | 257,280 B | 14,537 B (5.7%) | 3,772 B (1.47%) |
| 170×320 | 108,800 B | 8,937 B (8.2%) | 2,120 B (1.95%) |
| 240×240 | 115,200 B | 7,884 B (6.8%) | 1,192 B (1.03%) |

A full repaint of the largest panel is 17 KB. A portfolio number changing once a second is **3 KB/s**
— on a link that carries video. The "quarter of a megabyte per frame" number that makes shipping
pixels sound absurd is the number you get if you send the whole panel uncompressed every tick, and
that is a property of a naive protocol, not of pixels.

Rasterising costs 22-41 ms per frame on this machine, which is the real budget to watch. It is
already cached by SVG source in `raster.ts`, so an unchanged face costs nothing at all.

**So: the host renders, the device blits.** The firmware owns no fonts, no palette, no layout and no
design system. It owns a socket, a decoder and a framebuffer. That is a device that can be finished.

The escape hatch, if it is ever needed, is narrow and named: a per-second countdown on the Auction
Hourglass is the one surface where a round trip per tick is genuinely silly. The answer there is
still pixels — a dirty rect containing just the digits, which the table above prices at about 1 KB —
not a second renderer.

**One exception was taken anyway, and it is a second renderer.** `app/wifi_setup.{h,cpp}` draws a
network list and an on-screen keyboard directly on the panel with `Arduino_GFX`'s own font, so a unit
carried away from a desk can join whatever WiFi is nearby without a phone or a laptop in the loop.
Ryan chose this over the two options that would have kept the rule intact — a phone-facing captive
portal (no font needed at all, the browser renders), or staying cable-only for WiFi the way this
device already is for everything else — with the trade-off named, not by default. It is kept as
narrow as the reasoning above argues a native renderer should be: one module, one job, no palette, no
layout beyond what typing a passphrase requires, and it hands the panel back to the protocol decoder
the instant a host is on the cable. It does not reopen the question this section answers for
everything else a pulse display might show.

**That larger call has since been made, and this paragraph used to say it was open.** A standalone
renderer for actual portfolio data with no host present is what `pulse/` is: it holds its own
palette, its own typeface and its own layout, and it fetches what it shows. `app/` is still the
blitter and still the firmware that works on glass.

**And an address is configuration, not a secret** — which is the part worth writing down here,
because a portfolio on a handheld unit sounds like a credential question and is not one. AGENTS.md
now says so under "The Cardputer and the pulse display are wholly independent devices", and the
measurement behind it was taken from this checkout on 2026-09-17 with a cache-busting query
parameter, the way this repo requires a credential claim to be made:

| Call | With the API key | With no key |
|---|---|---|
| `GET /api/v2/account/{address}/portfolio?timeframe=DAY` | `200`, `cf-cache-status: MISS` | `401`, `cf-cache-status: BYPASS` |

So the origin judged the key in both directions rather than Cloudflare answering for it, and a
read-only key is the whole credential a portfolio needs. What stays off these units is anything that
can *act*: a PAT carries whatever scopes it was created with, and invariant 5 applies to it.

Two findings from that endpoint that the next person to call it would otherwise pay for again: every
money field is a **string** in snake case (`total_value_usd`, `nft_value_usd`, `pnl_absolute`) where
the host's model is camelCase, and `docs/upstream.md` entry 7 means the bare route can `500` for a
large account — `timeframe=DAY` is sent partly as the documented workaround of "always send a
parameter", and a `chains` filter is deliberately *not* sent because it would quietly narrow the
total under a label reading "Total".

### The messages

Binary, little-endian, one TCP stream. Header is 8 bytes: `[magic 0xA5][type][seq u16][length u32]`.

| Type | Direction | Payload |
|---|---|---|
| `0x01` HELLO | device → host | version, width, height, pixel format, max tile bytes, input mask, device id |
| `0x02` READY | host → device | version, brightness, keepalive ms, stale-after ms |
| `0x10` TILE | host → device | `x, y, w, h, encoding`, then pixels |
| `0x11` COMMIT | host → device | — |
| `0x12` BRIGHTNESS | host → device | percent |
| `0x13` BLANK | host → device | — |
| `0x20` INPUT | device → host | kind, slot id, two `int16`s |
| `0x30` PING / `0x31` PONG | host → device / back | — |

Properties worth stating, because each of them is a bug that would otherwise be found on hardware:

- **The device declares its own geometry.** Nothing on the host has a table of model constants — the
  same discipline as the Stream Deck adapter reading `CONTROLS` rather than hard-coding a Plus.
- **The device declares its pixel byte order.** Most ESP32 QSPI panel drivers want RGB565 high byte
  first. Letting HELLO say so means the host writes the bytes the right way round and the device
  never spends a pass swapping 434,312 of them.
- **A HELLO is untrusted input.** `width * height * 2` is an allocation, so it is bounded
  (`MAX_PANEL_PIXELS`) before anything is allocated. A device claiming 65535×65535 would otherwise
  ask the host for 8 GB before a pixel was painted.
- **A device id is sanitised at the decoder.** It lands in log lines. A device that names itself with
  an ANSI escape must not be able to rewrite the terminal of the machine it is plugged into.
- **TILE then COMMIT, atomically.** Several tiles compose one frame and COMMIT presents it. A number
  that renders half-updated is a *wrong reading*, not a cosmetic glitch, and money is what is on this
  screen.
- **Tiles are diffed and packed.** Unchanged frame, no bytes at all — the same promise the Stream
  Deck adapter makes about USB traffic. Changed frames send dirty rectangles, PackBits-coded over
  16-bit pixels, and fall back to raw whenever the coding does not actually help.

### What the format cannot say

There is no message type, and no field of one, for a signature, a key, an address, an amount, an
approval or a transaction. A device's whole vocabulary is *a slot id and two numbers*. The parser
enforces it: `HOST_BOUND_TYPES` accepts HELLO, INPUT and PONG and treats anything else from a device
as a reason to hang up, so a display cannot paint the host's idea of the panel and cannot address
another device through us.

This is AGENTS.md invariant 1 expressed as a parser rather than as a policy check. A display on a
desk is the least trustworthy requester in the system — `docs/security.md` says outright that a
commodity microcontroller has no certified secure element and must be assumed extractable on physical
possession — so it is given no way to ask for anything. A tap is a page change. It is never an
intent to spend, and there is nowhere in the format to put one.

If a device ever becomes an approval surface, `docs/security.md` already says what it may be: a
**display and presence gate**, never a key store, and the approval still happens in the executor.
That would be a new document and a human's decision, not an extra opcode.

## Putting an Anchor surface on a LAN

This section is the analysis AGENTS.md invariant 6 asks for. The honest summary: **the pixels are the
data.** A rendered portfolio is the portfolio. Everything below follows from that.

**Confidentiality.** The frame is not metadata about wallet value; it is wallet value, in a legible
typeface. Encryption is therefore not hardening, it is the feature — which is why `checkTransport`
makes an unencrypted LAN link an error rather than a warning.

**The key is extractable.** Assume anyone who picks the device up gets the PSK out of flash. So the
key is per-device and revocable (delete the keyring entry, the display stops working, nothing else
does), and it grants exactly one capability: receive pixels, send slot ids. It is not a credential
for the data service and never leaves the host↔device link. Losing a display should cost a display.

**The device has an open port.** Anyone on the network can connect to it. The firmware must therefore
refuse an unauthenticated peer at the TLS layer, accept one connection at a time, and serve nothing
else — no HTTP status page, no open OTA endpoint, no debug shell on the network. A device that also
runs a "helpful" web UI has undone this entire document.

**A compromised display is a foothold on the LAN.** It holds Wi-Fi credentials. Put it on an IoT
VLAN or a guest SSID if the router can; if the desktop and the display must share a segment, note
that the host's outbound-only design means the compromised device still cannot reach into the desktop
except through the one parser that accepts three message types.

**Discovery is disclosure.** Covered above, and worth repeating because it is the one that is easy to
get wrong while doing everything else right: a device advertising itself as `anchor-pulse` on mDNS
tells the network that this desk has a crypto wallet. That is a fact about the owner's physical
safety. Use an address.

**The display keeps showing things after you leave.** A monitor blanks when the session locks; a desk
display does not know the session locked. `docs/security.md` says the idle screensaver must never
display private wallet data while the desktop is locked, and this is that rule with the screensaver
removed. The adapter has `blank()` for it. Wiring it to the lock signal is listed under
[what this needs](#what-this-needs-from-the-shared-contract) and is not optional for a device that
shows a portfolio.

**Tailscale.** `docs/security.md` allows "loopback or behind Tailscale". A tailnet is a good answer
for a display in another room and is compatible with everything here — the host still dials out, and
the PSK still applies. It is not a substitute for the PSK: a tailnet is a network boundary, and the
threat model here includes the device itself.

## Displays

**The hardware is a Waveshare ESP32-S3-Touch-AMOLED-1.8, V2 revision**, and it is driving Anchor
frames. Identifying it took correcting a wrong answer, and the wrong answer is the more useful half.

An earlier version of this section said the board had no display. The firmware had scanned I2C on
SDA=8/SCL=9 — the ESP32-S3 Arduino defaults — found nothing, and read the silence as a result.

> **Zero devices on the wrong pins is not a negative result.** It is the instrument reporting that it
> was pointed somewhere nothing lives. AGENTS.md asks for attention to the thing you look *through*,
> and a default constant is exactly what goes unlooked-at. The claim then survived a merge, because
> the number it produced looked like data.

`devices/firmware/esp32/probe/` replaces the assumption with a measurement, and takes no pin map on
faith. It drives each safe GPIO's internal pull-down (~45k) and reports every pin an external pull-up
still holds high, on the physical grounds that an I2C bus carries pull-ups of a few kilohms and very
little else does. Twenty-seven candidate pins become five, and five become one bus.

**Measured on the real bus — SDA=15, SCL=14** — with every device asked for its identity register
rather than named from its address:

| Address | Identity register | What it is |
|---|---|---|
| 0x15 | chip 0xB7, vendor 0x41 | CST820 capacitive touch |
| 0x18 | 0x83 0x11 | ES8311 audio codec |
| 0x20 | in 0xCF, out 0x87, config 0x78 | TCA9554-class IO expander |
| 0x34 | 0x4A | AXP2101 power-management unit |
| 0x51 | — | PCF85063-class real-time clock |
| 0x6B | WHO_AM_I 0x05, rev 0x7C | QMI8658 IMU |

That fingerprint names the product *and its revision*: V2 pairs a CO5300 with a CST820, where V1 used
an SH8601 with an FT3168. The touch controller identifies the display driver. The vendor's own
`pin_config.h` then declares `IIC_SDA 15` and `IIC_SCL 14` — the physical probe and the vendor header
agree independently, which is what makes this an identification rather than a plausible story.

The panel is **368x448**, on QSPI at CS=12, SCK=11, D0-D3 = 4, 5, 6, 7, with **no reset pin** — the
vendor's example passes `GFX_NOT_DEFINED`. The old `amoled-466` guess in the geometry table named the
right driver family and the wrong size.

### Every flushed rectangle starts on an even column, or the text comes out italic

The CO5300 is written by setting a column window (`CASET`) and streaming pixels into it, and
`Arduino_CO5300::writeAddrWindow` passes whatever `x` and `w` it is handed straight through with no
alignment. This panel wants those on even columns. Give it an odd one and the controller's write
pointer advances at a different rate from the data being fed to it, so each row lands a pixel further
across than the row above — and down a block of text that is a progressive shear.

It does not look like corruption. It looks like *italics*, which is how it was reported from the desk
and why it cost most of an evening: the glyphs are the right glyphs, in the right font, at the right
size, drawn with every row offset from the last. Three separate theories died on it — a font problem,
a contrast problem, and a tearing problem — because all three are things that could plausibly slant
text, and none of them was this.

Two things made it hard to see, both worth remembering:

- **Only some elements shear.** LVGL invalidates the bounding box of whatever changed, so whether a
  given label lands on an odd column is luck. A subtitle repainting on its own is a small rectangle
  that may be odd; a full-screen repaint starts at zero and is even. So the panel looks mostly fine
  with one line wrong, which reads as a problem with *that line*.
- **The simulator cannot reproduce it, ever.** `sim/` renders into a framebuffer, and a framebuffer
  does not care where a rectangle begins. This is the sharp edge of that tool: it catches layout and
  logic and it is structurally blind to anything about how the panel is addressed. A clean render
  proves nothing about column alignment.

`pulse.ino` snaps every invalidated area outward on `LV_EVENT_INVALIDATE_AREA` (`x1 &= ~1`,
`x2 |= 1`). It costs at most two columns of redraw and cannot lose pixels. Anything else that ever
drives this panel directly needs the same rule.

### The corners of this panel are not on the glass — keep 20 px clear

The framebuffer is a full 368×448 rectangle. The display is a rounded one, and the radius is not
published: it is not in this tree, and Waveshare's 3D model gives no clean value for it. So anything
drawn into a corner is partly behind the bezel's curve, and the only way anybody here has established
the clearance is by looking at a unit.

**Three separate measurements, all by eye, and the largest of them is the number to use.**

| Where | What it measured | Value |
|---|---|---|
| `sensors/sensors.ino` | its own margins | 20 px |
| `svg.gridMetrics` | 4.5% of the short side | 17 px here |
| `pulse_wifi.cpp` | 12, then 20 after the "Wi-Fi" heading came out clipped | 20 px |

It lives in one place now — `INSET` in `devices/firmware/esp32/pulse/pulse_design.h` — and every
layout in that firmware is positioned against the safe rectangle it defines (20, 20)–(348, 428)
rather than against the panel.

What makes this cost more than it should: the failure is silent and partial. A heading loses a few
pixels off the left of its first glyph, which reads as a font or an antialiasing problem rather than
as geometry, and nothing in a screenshot shows it because the simulator draws the full rectangle. The
drift is silent too — the Wi-Fi picker's three-button row stayed 109 px wide after `INSET` went from
12 to 20, so the last button's right edge sat 5 px from the panel edge for as long as the number was
written out by hand in two files. Derive the row from the safe width; do not retype it.

### The panel is 29 mm wide, so size for a fingertip, not for pixels

The 1.8 inch panel puts 368 x 448 pixels on about 29 x 35 mm of glass, 322 pixels to the inch, so
12.7 px is a millimetre. A layout that looks roomy in a 368 px screenshot is small in the hand. On
2026-09-22 Ryan reported from the first physical session that the unit was very small to read and
that the Wi-Fi keyboard was extremely hard to use.

The keyboard was LVGL's `lv_keyboard`: ten or eleven keys a row across 352 px, 27 to 32 px a key,
which is 2.1 to 2.5 mm against the 8 to 10 mm a fingertip needs. A magnifier above the finger showed
which key was pressed but did not make the keys any easier to hit. No full keyboard fits this width at a
usable size, so `pulse/pulse_keypad_model.h` replaces it with a phone-style keypad:

- Three columns and four rows, each key 112 x 63 px (8.8 x 5 mm).
- Letters in telephone groups. Tapping a group shows that group's letters, lower case above upper
  case, at 48 px on keys 82 px wide or more; the second tap types the letter and returns to the grid.
- Digits are one tap each on their own page. The 32 ASCII symbols are in nine groups on a third page,
  one tap from the letters.

Every character WPA2 accepts, 0x20 to 0x7E, is reachable in three taps or fewer, and letters and
digits in two. `host/keypad.cpp` checks that by search rather than by listing cases. The simulator's
`keypad-join` scenario types a hidden network name and the passphrase `Pass-123` by coordinates and
checks that the saved profile holds exactly that string. The simulated unit starts with
`fixturepass` saved, so a keypad that typed the wrong characters fails the check.

Text follows the same arithmetic. 20 px Montserrat is about 1.6 mm tall. Explore rows now read at
28 px with a 20 px label, the chooser status line and buttons at 20 px, and Wi-Fi network rows at
24 px with 20 px padding. In the simulator's tree dump a network row is now 67 px (5.3 mm) instead
of 46 px. The crowded case, 32 scan results followed by the keypad, peaks at 107,888 bytes of the
128 KiB LVGL pool with a 23,384-byte largest free block.

What the simulator cannot say: whether these sizes are enough on the glass, whether two taps a letter
is acceptable to the people using it, and how the CST820 behaves on the larger keys. Those need a
unit in the hand, and the result belongs in this section.

### The AXP2101 is how this board is switched off, and the register map came from two vendor drivers

The bus table above has named the power-management IC at 0x34 since `probe/` found it, and for a long
time that was the whole relationship: no firmware here ever spoke to it. So a unit could not be
deliberately switched off, could not say how much charge it had, and could not tell you whether the
cable it was on was charging it. `pulse/pulse_power.{h,cpp}` is the driver, and this is what the next
one will want to know.

**Every register was read out of a vendor driver, never from memory.** Two independent ones, and they
agree on all of it:

- **M5Unified**, `src/utility/power/AXP2101_Class.cpp` — M5Stack's own driver for the AXP2101 on the
  Cardputer ADV, which is already checked out in this repository under
  `devices/firmware/cardputer/.pio/libdeps/`. A driver with hardware behind it, on this desk.
- **XPowersLib** (`lewisxhe/XPowersLib`) — `src/REG/AXP2101Constants.h` for the addresses,
  `src/XPowersAXP2101.hpp` for the bit meanings. The library Waveshare's own examples for this board
  pull in.

| Register | Field | What it is | Source |
|---|---|---|---|
| 0x03 | whole byte | chip id, `0x4A` on an AXP2101 | both, and `probe/` measured it here |
| 0x00 | bit 5 | VBUS good | both |
| 0x00 | bit 3 | battery present | both |
| 0x01 | bits 6:5 | `01` charging, `10` discharging, `00` standby | both |
| 0x10 | bit 0 | **soft power off** | both |
| 0x30 | bit 0 | battery-voltage ADC channel enable | both |
| 0x34/0x35 | 13 or 14 bits | battery terminal voltage, in mV, high byte first | XPowersLib masks 5 bits of the high byte, M5Unified 6 |
| 0xA4 | whole byte | fuel gauge state of charge, 0-100 | both |

The one disagreement is the battery-voltage mask, and the driver takes the narrower reading: inside
the range a lithium cell can physically be in, the two are identical, and the wider mask can only add
8192 mV to a value with a stray bit in a field the other driver calls reserved.

**Reading this part is safe; writing to it is not.** Its LDOs feed the panel and the touch controller,
so a wrong write is a dark board that a replug may not fix, and its charge registers are a cell
charged past where it should be. `pulse_power.cpp` therefore writes exactly two bits ever — bit 0 of
0x30, read-modify-written and skipped when it is already set, and bit 0 of 0x10 from `powerOff()`.
Charge current (0x62), termination voltage (0x64), the rail enables (0x80, 0x90) and the power-key
configuration (0x22) are deliberately untouched. Both writes are read-modify-writes: 0x10 in
particular holds seven other configuration bits that a bare `0x01` would clear.

**What nobody here has verified.** As of writing these boards are unplugged, so three claims are
still on the vendors' word rather than on a measurement: that bit 0 of 0x10 actually cuts power on
*this* board, that 0xA4 holds a sane state of charge on it, and which of its buttons brings it back on
afterwards. The AXP2101 is woken by its PWRON key and by a VBUS insert; how Waveshare wires that is not
established anywhere in this tree, which is why the confirmation screen says what shutting down costs
and says nothing about how to undo it. The simulator can replay these registers
(`sim/include/Wire.h`, `sim/lvgl.sh --battery`) and that exercises the decode and the screen above it;
it cannot tell you anything at all about the silicon.

### The tearing line, and an oracle that was switched off

GPIO 13 carries the panel's tearing-effect signal at about 58 Hz. It is worth its own paragraph
because it was the only instrument available while the pin map was unknown, and it produced both the
best result here and the worst mistake.

It proved a panel existed when a pin scan could not: a board with no display does not generate one.
It is also an output *of the panel*, so a sweep could look for the pins that silence it. That sweep
did find them — and then carried on past the hit instead of stopping, so it could not say which
combination was responsible, and reported two thousand more "candidates" against a line that was
already dead. The panel stayed asleep for the rest of that session. **A search whose success and
whose failure look identical is not a search.**

The second mistake was the mirror of the first. Once the pin map was known, a full initialisation
brought the controller back — and the tearing line stayed at zero, which read exactly like a panel
that was still dark. It was not: Arduino_GFX's init simply does not enable tearing, and the original
58 Hz had come from the firmware that shipped on the board. One command (`0x35`) restored the signal.
The panel had been refreshing the whole time, and the oracle was the thing that was off.

Both are the same error in opposite directions, and both are cheap to make: an instrument that
reports nothing is not the same as a world that contains nothing.

| Candidate | Panel | Bus | Full frame (RLE, measured) | Notes |
|---|---|---|---|---|
| ESP32-S3 1.43" round AMOLED (CO5300-class) | 466×466, RGB565 | QSPI | 17.5 KB | The field notes' "portfolio pulse". Round crops a bar surface badly; wants a tile |
| ESP32-S3 1.91" AMOLED (RM67162-class) | 240×536, RGB565 | QSPI | 14.5 KB | Strip shape suits a bar of segments, and the Auction Hourglass |
| ESP32-S3 1.9" IPS LCD (ST7789-class) | 170×320, RGB565 | 8-bit parallel | 8.9 KB | Cheapest. LCD backlight is always on — worse for an ambient device |
| ESP32 1.28" round LCD (GC9A01-class) | 240×240, RGB565 | SPI | 7.9 KB | Smallest useful. SPI is the slowest bus here |

What actually decides it, and what to measure before committing:

- **Colour depth is RGB565 across the board**, which is why the wire format has exactly one pixel
  format in two byte orders. 5 bits of blue is finer than the difference between two Omarchy themes,
  and Anchor's surfaces are flat fills and text with no gradient to band. Truncation, not dithering.
- **AMOLED earns its price on an ambient device**, not on refresh rate. Black pixels cost nothing, and
  an Anchor surface is mostly ground. An always-on LCD backlight on a desk at night is the thing that
  makes a device get unplugged.
- **Refresh cost is dominated by the panel, not the link** — and that prediction has now been paid
  out. This bullet used to end "**Measure:** full-frame blit time, and dirty-rect blit time for a
  3 KB rectangle", because 17 KB over a link is nothing and pushing a framebuffer over QSPI is the
  part that costs. Both were measured; the answer is in the bullet two below and in the ledger at the
  end, and the guess was right about *where* the cost was and wrong about how much of it the bus
  itself accounts for.
- **PSRAM was the constraint that bites, and it does not bite.** **Measured on the board on this
  desk:** 8 MB of embedded PSRAM, 7,943,664 bytes free at boot, and its 368×448 framebuffer —
  329,728 bytes — allocates out of it with room to spare. A 466×466 panel would need 434,312 and
  would also fit. The fallback is still implemented and still right for a board without PSRAM: claim
  a smaller panel in HELLO, because the host paints whatever geometry it is told. What is *not* yet
  measured is the same figure with Wi-Fi and a TLS session up, which is the real budget for the
  networked build.
- **The panel push is the cost, not the bus.** Pushing the whole framebuffer on every COMMIT cost
  105 ms for a changed reading. The decoder already knew which rows had arrived and simply was not
  reporting them; a band of whole rows is contiguous in the framebuffer, so pushing only those is one
  block and no copy, and it brought the figure to 70 ms.
- **Power.** Assume USB-C power for the first build. A battery-powered pulse display is a different
  project: it needs deep sleep between frames, and this protocol's persistent connection is the wrong
  shape for that. Say so rather than half-supporting it.
- **The Tilt-to-Explore Gallery** needs an accelerometer/gyro, and this board has one: the QMI8658 at
  0x6B, now proven on silicon rather than assumed from a product page. It costs no protocol change —
  motion becomes a `swipe` with a `from`/`to`, which is already an `InputKind` and already what the
  panel uses to change page. It is deliberately not wired here, and the tilt gesture shipped on the
  Cardputer instead; see [The inputs this board had all along](#the-inputs-this-board-had-all-along).

### The inputs this board had all along

For a long time this document and the firmware both said the panel had no input. That was never a
measurement. `probe/` had already found a **CST820 at 0x15 and a QMI8658 at 0x6B** on the bus above —
the same table that identified the display driver names two input devices — and the firmware's zero
input mask meant "nobody wired it up", written in a comment as though it were a fact about the
hardware. It is the `amoled-466` mistake in a different register: a plausible sentence standing in
for a question nobody asked.

`devices/firmware/esp32/sensors/sensors.ino` is a standalone bringup sketch in the shape `probe/`
established, and it asks the two chips what they say when a person actually uses them rather than
only what they are called. What it reported, against this silicon:

- **The IMU is proven.** WHO_AM_I `0x05`, revision `0x7C`, its configuration registers reading back
  exactly as written, and a clean **1.05 g** gravity vector at the ±2 g scale factor. The registers
  reading back what was written to them are the control: a bus answering with noise, or with zeroes,
  could not have produced that, and a scale factor applied to the wrong part would not have landed
  on gravity.
- **The touch controller is not.** It identifies itself — chip `0xB7`, vendor `0x41` — and then
  produced **no coordinate at all**. It also refused a six-byte burst read from register `0x01`
  while answering single-register reads of the same registers, which is a real finding and the
  reason `app/sensors.cpp` reads one register at a time with a stop rather than a repeated start.
  **Whether that is what was wrong is not known.** It needs a finger on the lit glass, and until
  somebody puts one there nothing in this file claims that touch works.
- **A bounded `Wire.setTimeOut` is not optional.** On this device `Serial` *is* the protocol and the
  decoder is fed from `loop()`, so an I2C transaction that never gives up turns a quiet sensor into
  a display that appears to freeze. Bounded at 10 ms, polled on a 20 ms beat, every read checked,
  and a missing chip simply never producing an event.

So HELLO now claims `tap` and `swipe` — `(1<<ANCHOR_INPUT_TAP)|(1<<ANCHOR_INPUT_SWIPE)` in
`say_hello()`. The mask is what the firmware is *prepared to send*, not what the glass is known to be
good for: the host reads it to decide what this device can do at all, so claiming a kind and never
sending it costs nothing, while sending an unclaimed kind is a device breaking its own HELLO.
Recognition happens in `app/sensors.cpp` from raw coordinates rather than out of the controller's
gesture register, because parts in this family differ over whether that register is populated at all
while the coordinates are always there. A finger that goes down and comes up within 24 px is a tap;
one that travels 80 px or more sideways is a swipe; the in-between case is deliberately neither,
because a smudge should not page a display. Nothing is sent before READY, and nothing is ever
printed — a stray `printf` here lands in the middle of a frame and is correctly read as a device
talking nonsense.

**The IMU is deliberately not wired to any input**, and `app/sensors.h` gives the reason rather than
leaving it to be guessed at: it is the one of the two that works, and it still should not turn pages
on *this* device, because a display whose job is to sit still on a desk and be glanced at is made
worse, not richer, by a page that turns because somebody set a mug down next to it. Tilt went to the
Cardputer, which is the unit already in a hand. That is a judgement about what this device is for,
not a limit on what it can do.

### What a tap does on the host

`Panel.handle`'s `tap` case used to end `return false;`. Taps were decoded end to end, with passing
tests, and then dropped on the floor. Now a tap on a rotating ambient page advances to the next item
and pins it there for `TAP_HOLD_MS` — ten seconds.

The mechanism matters more than the gesture, and it lives in `#steerRotation` in `panel.ts`. The
rotation index is derived from the wall clock, and that is the whole reason several units on one desk
land on the same piece at the same moment with nothing passing between them. A tap that answered by
starting a private counter would break exactly that property: the panel would never rejoin, and the
desk would look wrong in a way no single unit could reveal. So a tap is an *offset* laid over the
clock index with a deadline under it. An untouched unit's behaviour is unchanged to the millisecond;
a tapped one is out of step only for as long as somebody is looking at it; when the clock catches up
the pin is dropped and the panel is an untouched one again. During the hold the sync bar's claim
changes with it — it counts toward the end of the hold rather than the next shared flip, because a
bar that fills while nothing changes is the sync promise made falsely.

Ten seconds is **reasoned, not measured**: longer than one six-second rotation window, so a tap
landing 200 ms before a flip does not have its answer yanked away before the eye arrives, and under
two, so a panel somebody tapped and walked away from is ambient again — and back in step with the
units beside it — inside a quarter of a minute. Nothing has yet put a real thumb on this glass to
say whether that is the right number.

One refusal is as deliberate as the action. A tap whose slot is not a screen's does nothing: the
Stream Deck's touch strip emits taps too, and letting one advance the rotation would jump the eight
gallery *keys* beside it.

A tap on a page that does *not* rotate used to be refused as well, and the refusal named exactly
what was missing: a page of keys wants "open the thing I touched", the panel cannot know where a
cell was drawn because a tap carries pixels and pixel geometry lives in the renderer, and the only
thing it could have acted on was the current selection — which would fire an action from a sleeve
brushing the glass. `svg.gridCellAt` is the missing half, and it is the same function `renderGrid`
lays the cells out with rather than a second opinion about where they went; a hit test that
disagrees with the picture is worse than none, because it is wrong about the one thing the person
can see. The panel remembers the slot and the keys behind the last grid it composed — a tap arrives
later with nothing attached to it — and answers the touch with the cell under it.

The sleeve is still answered, three times over. The gutter between two tiles is dead space, so a
touch between two targets resolves to neither rather than to whichever won a rounding. The page name
travels with the remembered grid, so a tap landing between a page change and the repaint that
follows resolves against nothing. And what a cell can reach is `key.action` from `panel.json` and
nothing else — never the action a *source* supplied for what the cell happens to be showing, which
is a string built out of marketplace data. `actions.ts` has no verb that signs, spends or approves,
so invariant 1 holds here structurally rather than by care.

## When things are down

Three different failures, three different truths to tell. Conflating them is how a display ends up
confidently showing yesterday's number.

**The data service is down.** Already modelled: `state/anchor.ts` reports `reachable: false` and the
panel renders `anchor · not running` through the existing segment source. Nothing device-specific,
and the important part is that the panel must paint *that*, not keep the last good number on screen.
`theme/README.md` principle 6: a number without which wallets and how old is not checkable.

**The link is down.** The host reconnects with backoff and, on reconnect, repaints in full — the
adapter drops its cached framebuffer on close, so it never diffs a new frame against a panel that has
since gone dark.

**The host is gone, and the device does not know why.** This is the case that needs the protocol's
help, because the device cannot draw and therefore cannot write "stale" on itself. READY carries
`staleAfterMs`, and the firmware's only autonomous rendering is what it can do without a font:

1. Past `staleAfterMs` with no COMMIT and no PING, **dim the panel** on a visible ramp. Dimming is
   honest — it says "this is not live" without claiming to know what is.
2. Past a longer threshold, **blank to ground** and show whatever boot indication is baked into
   flash. A dark screen is a true statement; a stale portfolio is a false one.

Nothing between those two is a good idea. A device that invents an error message is a device with a
font, a layout and a design system in it, and the whole point of shipping pixels is that it has none.

## What this needed from the shared contract

Three things were listed here as needed before the display could show anything real. All three have
landed, and the record of what they were is worth keeping, because the first two turned out to be
shared needs rather than ESP32 ones — the Cardputer design asked for the same two independently,
which is what made them contract changes instead of adapter workarounds.

1. **`panel.ts` composes a `screen` slot.** *Done.* `Panel.build()` had no branch for
   `kind: "screen"`, so a device whose only slot was a screen received an empty frame. It now paints
   a page's keys onto a screen slot — as a `list` at first, and as a `grid` since the panel it runs
   on turned out to have a finger on it — with `selected` clamped by the panel because only the
   panel knows the cell count after a filter. `SCREEN_SLOT` **moved** to `panel.ts` next to
   `keySlot`, `dialSlot` and `STRIP_SLOT`, rather than being copied; `esp32.ts` imports it from
   there and re-exports it for its own callers. A slot id defined in two places gets spelled two
   ways.
2. **`AnchorDevice` has an optional lock hook.** *Done.* It grew `setBlanked?(blanked: boolean)`,
   which is the name the Stream Deck adapter implements and therefore the name anything subscribing
   to logind's `LockedHint` can call uniformly. `Esp32PulseDevice` now implements it too: the
   adapter's `blank()` is still the primitive, because the wire has a message for exactly it, but an
   adapter that had *only* `blank()` would be skipped silently by a lock subscriber — the display
   stays lit and nothing reports a fault. Unblanking repaints rather than restoring brightness, since
   the frame was dropped when the panel went dark.
3. **A screen-shaped page.** *Done.* A 368×448 portrait panel is not a strip, and a page whose only
   content is a row of bar segments — or a list of what would otherwise have been eight keys — reads
   badly on it. The answer is `Panel.pulseDetail()` in `devices/src/panel.ts`, and what shipped is a
   page *type* rather than a new surface: `build` offers every `screen` slot to it first and falls
   back to the page's own keys whenever it returns null, so a desktop or chains page — a set of
   things to choose between — stays something to choose from and is not forced into an ambient frame.

   Which pages it claims is named once, in `ROTATING_PAGES`: `portfolio`, `gallery`, `tokens` and
   `nfts`. The tap handler reads the same set, which is what stops the two drifting — a page added to
   one and not the other renders nothing at all, noticed on the first look, rather than accepting a
   tap that quietly does nothing.

   What it paints is a `detail`. `portfolio` is total, P&L, NFT count and window over a rotating
   piece of the wallet's own art, footed with the reading's age. `gallery` is one piece, with its own
   name as the title and its collection under it. `tokens` and `nfts` are the discovery pages — price,
   24h change with a tone, volume and chain; or a trending collection — and neither needs a wallet
   configured at all. All four rotate on the same wall-clock formula, which is the property the
   tap design had to be built around.

   The artwork is full-bleed: `svg.ts` draws it at panel size with `preserveAspectRatio="xMidYMid
   slice"` and lays a flat `ground` scrim over it at 0.62 opacity. That scrim is the one mark in the
   renderer that `contrast.test.ts` does not hold to a measured ratio, and deliberately so — there is
   no fixed contrast against a photograph whose content is not known until it arrives. It is the
   honest limit of that guarantee rather than a gap in applying it, and it is the first thing to look
   at on a mostly-light piece.

   And it was answered in front of `scripts/review.ts` rather than in a PR description, which is what
   this entry asked for. `devices/src/review.ts` carries `pulse-amoled`, `pulse-gallery`,
   `pulse-tokens` and `pulse-nfts` as rendered cards, alongside `pulse-round` for the panel whose
   corners are not there and a blanked one for the lock case.

The surfaces the contract gained alongside these are what a screen device actually paints: `detail`
(a title, labelled lines, and a footer that is never truncated), `list` (rows, with panel-owned
selection) and `grid`.

`grid` is what a page of keys became once this panel had a touch layer on it. A row was about a
fourteenth of the screen's height — roughly 2.5 mm of target, on a panel whose whole point is now
that you can put a thumb on it — and a column of thin rows is also the wrong use of a big portrait
screen. The cells are the page's keys in reading order, and nothing outside the renderer names a
column count: `gridMetrics` divides the slot by `TOUCH_TARGET_PX`, which is 120 because this
panel's own diagonal is √(368² + 448²) ≈ 580 px across 1.8 in ≈ 322 ppi ≈ 12.7 px/mm, and 9-10 mm
of finger is 114-127 px there. On this board that comes out three columns of 122 × 149; on the
1.28 in round 240×240 it comes out two by two, with the rest of the page a whole page-turn away
rather than squeezed on. Each cell is drawn by `renderTile` into a translated group rather than by
a second tile painter, so a screen device and a Stream Deck key are the same face at two sizes —
and a cell carries `emphasis`, which is the one thing a row had no word for: a list could not say
that night light is currently on.

Committed-`text` input arrived with them, for devices that have a keyboard; this board
has none, so `text` stays unclaimed here. The rest of the mask is no longer zero — it claims `tap`
and `swipe`, for the reasons under
[The inputs this board had all along](#the-inputs-this-board-had-all-along).

The firmware and this adapter still add nothing to `types.ts`: every input this board sends is a
kind the contract already had, and every surface it is painted is one the contract already carried.
What changed to serve this screen changed in `panel.ts`, which is where a decision about what a page
*means* belongs.

## Firmware

**Flashed, running, and painting.** `devices/firmware/esp32/` holds the real thing: `anchor_pulse.c`
is the decoder below, in portable C99 with no allocation and no platform calls, and it is compiled
and run on every `npm test` against frames produced by the real host adapter — so the wire format
has two implementations that are checked against each other rather than one checked against itself.
The Arduino application around it is built with `arduino-cli` against ESP32 core 3.3.11 and flashed
over USB-C, and every hardware number in [Measured, and assumed](#measured-and-assumed) came off that
board rather than off this desktop.

This paragraph read "written, and still not flashed" for longer than it was true, and the sentence
after it said that no board had been flashed and no pixel had been lit. Keeping the correction
visible rather than quietly deleting it is the point, because the gap it was describing is real and
turned out to be where the bugs were: six of them are listed in `devices/firmware/esp32/README.md`,
none was visible from the host, and every one of them sat between a decoder that passed its
conformance suite and a device that paints. That README is still the file that keeps measured and
unmeasured apart. What is *not* proved on this board today is a shorter and more specific list than
it was: Wi-Fi, TLS-PSK, free heap with a radio and a session up, colour fidelity on the glass, and
touch.

The sketch below is the ESP-IDF shape this document originally argued for and remains the right
target for the networked build; what shipped first is the same core behind an Arduino transport,
because there was no ESP-IDF toolchain on the machine and a cable needed no provisioning.

**ESP-IDF, in C.** Not Arduino, not MicroPython, and the reason is the same one that keeps this
workspace at one dependency: the firmware needs `mbedtls` PSK, `esp_wifi`, `wifi_provisioning` and
NVS, all of which are ESP-IDF components already, and the whole job is a socket, a decoder and a
blit. Arduino adds a layer to reach the same components; MicroPython adds a runtime to a device whose
constraint is RAM. LovyanGFX or the vendor's panel driver handles the QSPI/SPI blit and is the one
outside library worth taking.

Shape of it, in the order the device does things:

```
app_main
  nvs_init
  if no credentials -> wifi_provisioning softap + captive portal, then reboot
  wifi_connect (station)
  display_init (panel driver, backlight off until first COMMIT)
  key = nvs_get("pulse_psk")           // first boot: generate, store, show as a QR code
  listen(TCP :8788), accept one peer at a time
    mbedtls_ssl_conf_psk(key, "anchor-pulse")   // refuse anything else at the TLS layer
    send HELLO { version, w, h, byte order, max tile bytes, input mask, id }
    loop:
      read 8-byte header, then length bytes into a fixed buffer
      TILE       -> decode (raw | PackBits16) into the back buffer at (x,y,w,h)
      COMMIT     -> present; reset the stale timer
      BRIGHTNESS -> set backlight
      BLANK      -> clear to ground, drop the framebuffer
      PING       -> PONG
      touch      -> send INPUT { kind, slot, a, b }   // the IMU is present and proven, and is
                                                      // deliberately not behind one of these bits
    on stale timer: dim; on longer timer: blank
```

Rules the firmware must hold, each of which the host depends on:

- **Say nothing until READY.** Anything packed in behind HELLO is parsed by the handshake and then
  dropped when the stream is handed to the device object. This is a firmware rule, written here so
  the firmware author does not discover it as a missing first touch.
- **Never send a host-bound message type.** The host hangs up on one. This is a feature.
- **Fixed buffers.** `maxTileBytes` in HELLO is a promise about the buffer that exists; the host
  splits every rectangle on whole rows to fit it. Never allocate per message.
- **The backlight stays off until the first COMMIT**, so a device never shows a partly-painted frame
  on boot.
- **No OTA endpoint listening on the network.** If OTA is wanted later it goes through the same
  authenticated connection as a new message type, reviewed then. Not a second open port.

**Flashing.** USB-C, `idf.py -p /dev/ttyACM0 flash monitor`. On Omarchy the user needs read/write on
the serial device — that is `uucp` on Arch for `/dev/ttyUSB*`, and native-USB S3 boards enumerate as
`/dev/ttyACM*` where logind grants the seat owner access. Hold BOOT while plugging in if the board
does not auto-reset into the bootloader. `esptool.py erase_flash` is the way back to first boot if
provisioning goes wrong and the reset button has not been wired yet. The flow actually used on this
board is arduino-cli, and it is written out step by step in `devices/firmware/esp32/README.md`,
including the two build flags that are not cosmetic.

**Running it as a service, and the coin flip that ran 6,601 times.** A pulse display and a Cardputer
on one desk are indistinguishable from their USB descriptors — every ESP32-S3 with native USB
enumerates through the same Espressif JTAG/serial descriptor — so `listPorts()`' name match
identifies a chip family and never a device. `cli.ts` took `listPorts()[0]`, which with both boards
plugged in is a coin flip, and losing it is not a clean failure: it is a five-second handshake
timeout against the *other* device's port, an exit, and a restart into the same coin flip. The
journal had 6,601 restarts in it before anybody read it, which is the shape of a fault that reports
itself continuously and is therefore never read. `firstPortThatAnswers` in `devices/src/cli.ts` now
tries every candidate and keeps the one that answers as the device asked for, with the probe timeout
at 2s when there is a list to get through — a pulse display re-announces itself every 500 ms, so two
seconds of silence is an answer rather than a guess — and a port that turns out not to be ours is
closed immediately rather than left holding something another service needs. A named path is still
taken at its word, with its own error reported. The systemd unit additionally pins this display by
its stable `/dev/serial/by-id` path: probing is the right fallback for a person running this by
hand, but a daemon whose first act is opening another service's port is not a thing to rely on
twice.

## Measured, and assumed

Kept separate on purpose. AGENTS.md: a control that cannot be made to fail is not evidence.

**Measured on hardware, with the panel actually presenting each frame:**

- A 368×448 framebuffer is 329,728 bytes and **allocates in PSRAM**, of which the board reports
  8,388,608 bytes with 7,943,664 free at boot. The constraint this document named does not bite.
- A full frame is **23,219 bytes on the wire** in 60 messages — about 5% of the raw framebuffer,
  close to the 4.0% the desktop encoder predicted.
- **Full frame, end to end: ~213 ms** (74 ms to render and send, 139 ms until the device
  acknowledges). **A changed reading: 70 ms median.** Ping round trip: 1 ms. An unchanged frame
  costs 3 ms and **zero bytes**.
- Against the falsification test below: the full frame passes, and a changed reading **still misses**
  its 50 ms threshold. The cost is not the link. Host-side rasterisation is 22–41 ms of it, and the
  panel push is most of the rest — pushing the whole 368×448 panel on every commit cost 105 ms until
  the decoder started reporting which *rows* had changed, which brought it to 70 ms.
- The instrument is the protocol's own PONG, which cannot come back before the frame is presented.
  Details, and the bugs the hardware found, are in `devices/firmware/esp32/README.md`.
- **The two chips on the I2C bus, asked what they say rather than what they are called.** The
  QMI8658 answers WHO_AM_I `0x05`, revision `0x7C`, with its control registers reading back exactly
  as written and a 1.05 g gravity vector at the ±2 g scale factor. The CST820 answers chip `0xB7`,
  vendor `0x41`, refuses a six-byte burst read from register `0x01` while answering single-register
  reads, and **has never answered with a coordinate**.
- The application firmware compiles at 390,004 bytes with the sensor code in it, 804 bytes more than
  without — which is the check that it linked rather than being stripped out as unreachable.

**Measured here, today, on this machine (Node 26.8.1, ImageMagick 7.1.2-30):**

- Node's `tls` does PSK on both ends with no dependency, negotiating
  `ECDHE-PSK-CHACHA20-POLY1305`; `PSK-AES128-GCM-SHA256` also negotiates when named. A **wrong key
  fails the handshake** rather than connecting, which is the half that makes the first half mean
  something.
- Frame sizes, RLE ratios and dirty-rect deltas in the tables above, from the real rasteriser and the
  real encoder in `esp32-wire.ts`.
- Rasterising a pulse tile costs 22-41 ms depending on panel size.
- A pulse tile is 96 bytes as JSON; the strip bar is 162.

**Assumed, from vendor documentation and general knowledge, and not verified:**

- Every panel dimension, driver IC and bus in the candidate table **except this board's**. The
  368×448 CO5300 row is measured; the other three are vendor documentation for boards nobody here
  has held.
- That an ESP-IDF mbedTLS build offers either PSK ciphersuite.
- ESP32-S3 Wi-Fi throughput and QSPI blit times. **PSRAM availability is no longer assumed** — see
  the hardware measurements above — but the free-heap figure with a radio and a TLS session up still
  is, and that is the number the networked build actually depends on.
- **That the CST820 will ever produce a coordinate.** It answers its identity registers and has
  never answered with a touch. The single-register reads in `app/sensors.cpp` are a hypothesis about
  why, not a fix anyone has seen work, and the HELLO mask claims `tap` and `swipe` because the
  firmware is prepared to send them — not because anything has been sent. **Nothing in this document
  says touch works.** It needs a finger on the lit glass, and that is the next thing to do.
- That ten seconds is the right hold for a tapped item, and that the 24 px tap slop and 80 px swipe
  threshold are the right ones for this panel. All three are reasoned against the rotation window
  and the panel's own geometry, and none has been felt.
- Colour fidelity. The framebuffer goes to the driver as native-endian RGB565 with no swap pass, and
  that it is *correct* on the glass is a thing a person has to look at.

The falsification test for the central claim — *shipping pixels is affordable* — is simple: if a full
frame on real hardware costs more than a few hundred milliseconds end to end, or a dirty rect costs
more than about 50 ms, the argument in this document is wrong and the surface model deserves another
look. Time the blit before writing anything else.
