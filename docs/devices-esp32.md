# The ESP32 pulse display

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

**None of this was measured. There is no hardware on this branch.** The dimensions and buses below
are what the vendors publish; the frame costs are computed from them with the measurements in this
document. Treat the table as a shopping list to verify, not a result.

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
- **Refresh cost is dominated by the bus, not the link.** 17 KB over Wi-Fi is nothing; pushing a full
  466×466 framebuffer out over QSPI is the part to time. **Measure:** full-frame blit time, and dirty-
  rect blit time for a 3 KB rectangle.
- **PSRAM is the constraint that bites.** A 466×466 RGB565 framebuffer is 434 KB, which does not fit
  in internal SRAM on an S3. Either the board has PSRAM (most of these do) or the firmware composes
  tile-by-tile with no full framebuffer — which the TILE/COMMIT split already permits, at the cost of
  atomicity. **Measure:** free heap after `esp_wifi_start` plus a TLS session, which is the real
  budget, not the datasheet number.
- **Power.** Assume USB-C power for the first build. A battery-powered pulse display is a different
  project: it needs deep sleep between frames, and this protocol's persistent connection is the wrong
  shape for that. Say so rather than half-supporting it.
- **The Tilt-to-Explore Gallery** needs an accelerometer/gyro on the board (many of these carry a
  QMI8658-class IMU). It costs no protocol change: the firmware turns motion into `swipe` with a
  `from`/`to`, which is already an `InputKind` and already what the panel uses to change page.

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

## What this needs from the shared contract

Nothing here modifies `types.ts` or `panel.ts`, and two of these are needed before the display shows
anything real. Stated precisely so they can be reviewed as their own change.

1. **`panel.ts` must compose a `screen` slot.** `Panel.build()` fills `key`, `dial` and `strip` slots
   and has no branch for `kind: "screen"`, so a device whose only slot is a screen receives an empty
   frame today. The smallest correct change is a `screenSlot()` id helper next to `keySlot` and
   `dialSlot`, and a branch in `build()` that paints a page's `segments` onto a screen slot the way
   it paints them onto a strip. The adapter currently defines `SCREEN_SLOT = "screen:0"` itself; that
   constant should *move* to `panel.ts`, not be copied, so panel and adapter cannot drift apart.
   Until then the adapter paints whatever a caller puts in the frame under that id, which is what its
   tests do.
2. **Something must tell the adapter the session locked.** `blank()` exists on the adapter;
   `AnchorDevice` has no concept of it, and `cli.ts` has nowhere to call it from. Either the CLI
   subscribes to the lock signal and calls `blank()` on devices that have it, or `AnchorDevice` grows
   an optional `blank?()`. This is a security requirement, not a nicety — see above.
3. **A screen-shaped page.** A 466×466 round panel is not a strip, and a page whose only content is a
   row of bar segments will read badly on it. That is a design question for a `pulse` page type, and
   it should be answered with `scripts/review.ts` in front of it rather than in a PR description.
   AGENTS.md: do not ship a visual change you have only reasoned about.

## Firmware

Sketch, not an implementation. Nothing was flashed.

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
      touch/IMU  -> send INPUT { kind, slot, a, b }
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
provisioning goes wrong and the reset button has not been wired yet.

## Measured, and assumed

Kept separate on purpose. AGENTS.md: a control that cannot be made to fail is not evidence.

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

- Every panel dimension, driver IC and bus in the display table.
- That an ESP-IDF mbedTLS build offers either PSK ciphersuite.
- ESP32-S3 Wi-Fi throughput, PSRAM availability on any specific board, and QSPI blit times.
- That a 466×466 framebuffer needs PSRAM. Arithmetic says 434 KB and internal SRAM is smaller than
  that; the free-heap figure after Wi-Fi and TLS is the number that decides it, and it needs a board.

The falsification test for the central claim — *shipping pixels is affordable* — is simple: if a full
frame on real hardware costs more than a few hundred milliseconds end to end, or a dirty rect costs
more than about 50 ms, the argument in this document is wrong and the surface model deserves another
look. Time the blit before writing anything else.
