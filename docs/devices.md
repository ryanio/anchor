# Devices

Anchor's plans have always ended at hardware: an ESP32 portfolio-pulse display, Cardputers as
dedicated terminals, an auction hourglass that shifts colour as a deadline approaches. This document
is the layer those share, and the rules a new device has to hold to.

The Stream Deck is the first device. It is deliberately **not** the shape of the interface.

## The contract

A device declares what it has. Anchor paints into it and receives input back.

```ts
interface AnchorDevice {
  readonly id: string;
  readonly capabilities: DeviceCapabilities;   // slots + which inputs it can report
  paint(frame: Frame): Promise<void>;          // Frame = ReadonlyMap<slotId, Surface>
  setBrightness(percent: number): Promise<void>;
  onInput(handler: (input: DeviceInput) => void): void;
  close(): Promise<void>;
}
```

A `SlotSpec` is a named region: an id, a kind (`key`, `strip`, `screen`, `encoder`), its pixel size,
and whether it is `paintable`.

That last flag is not redundant with the kind, and the reason is instructive. The Stream Deck +'s
four encoders report turns and presses but have no display; other Elgato models put an LED ring
around theirs. Both are encoders, only one can be drawn on. Painting is gated on the flag, so a
panel never rasterises a frame that has nowhere to go.

A `Surface` is medium-neutral. Four exist:

| Surface | For |
|---|---|
| `tile` | One key: icon, label, an optional large `value`, meter or badge |
| `bar` | A row of icon/text segments — a status strip |
| `list` | Rows on a screen, with panel-owned `selected` |
| `detail` | One thing in full: title, labelled lines, a footer that is never truncated |

`list` and `detail` are shared vocabulary rather than device-specific, and the reason is structural:
`Panel.build` is the only thing that turns config plus state into surfaces, so a surface the panel
cannot emit is one no config can request — and an adapter-local list type would force the *adapter*
to fetch its own data. That is the exact coupling this layer exists to prevent.

The proof that it is shared: the same page config becomes a grid of keys on a Stream Deck and a list
of rows on a screen device, and a test asserts both carry identical readings.

A surface says what to show, not how to draw it. The Stream Deck adapter
rasterises surfaces to RGB; a network device could just as well receive the surface and draw it
itself. That choice belongs to the adapter.

## Why this shape

**The panel never learns which device it is driving.** `Panel.build()` is handed a device's slots
and fills the ones that exist. A device with two keys and no strip gets the same panel logic as one
with eight keys and a touch strip, and a test drives exactly that case.

**There are two implementations, on purpose.** `VirtualDevice` is not a test double bolted on
afterwards; it is the second implementation, and an interface with one implementation is only that
implementation's shape written down twice. It also lets key faces be rendered and reviewed on a
machine with nothing plugged in — which matters, because AGENTS.md forbids shipping a visual change
you have only reasoned about, and hardware cannot be screenshotted.

## The rules

### No device signs, spends, or approves

This is the important one, and it is a boundary rather than an omission.

Invariant 1 in `AGENTS.md` says policy is enforced outside whatever is requesting the action. A
device is the least trustworthy requester in the system: it is a piece of plastic on a desk that
anyone walking past can press, and it has no session, no authentication, and no way to know who
pressed it.

So the device vocabulary contains no verb that moves value — not `sign`, not `approve`, not
`transfer`. `actions.test.ts` asserts they are refused. When Anchor grows a proposal queue, a device
may *display* a proposal and may express interest in one; the executor decides, and a human with a
hardware wallet approves. Invariant 3 — delegating standing authority is human-only — applies with
particular force to anything shown on a screen you do not have to unlock.

### Colour comes from the user's theme

Never a literal, at any call site. `tokens.ts` resolves the device palette from the live Omarchy
theme's `colors.toml`, the same source the Quickshell widget uses (`theme/README.md` principle 8).
Themes are flat `key = "value"` files with an identical key set, which is what makes the mapping
stable rather than a guess.

Marks are then held to WCAG AA — 4.5:1 for label text, 3:1 for icons and rules — over every
installed theme, gated by `contrast.test.ts`. A theme designed for a large screen at arm's length
does not always clear the bar on a 120px key: Omarchy's `rose-pine` puts a `#56949f` accent on an
`#ede7e1` ground, which is 2.79:1. Rather than lower the threshold, a failing mark colour is blended
toward the theme's own foreground until it clears, so the result still belongs to the palette.

### Text is a filter, never a command

`DeviceInput` has a `text` member for devices with a keyboard, and it is deliberately *committed*
text rather than a keystroke stream — a stream invites dispatching on each one. The panel uses it to
narrow the rows already on screen. Nothing evaluates it, it never reaches `actions.dispatch`, and a
test asserts that committing `page other` changes no page.

If a filter ever becomes a query parameter to the data service, an untrusted device is steering host
requests. That is a different feature and needs an allowlist; say so rather than letting it happen.

### A display blanks when the session locks

`setBlanked` is optional on `AnchorDevice`, because a device only ever driven while someone is
present does not need it. A desk display does: it sits in a room its owner has walked out of, and
`docs/security.md` reasoning applies — a panel still showing a portfolio after the screen locks is a
security property, not a nicety.

The signal is logind's `LockedHint`, not a search for a lock-screen process, because that is what
every other desktop component uses and it does not care which locker is installed. The Stream Deck
adapter both clears the keys and takes the backlight to zero: brightness alone leaves the image
faintly readable in a dark room and fully readable to a phone camera.

### The font is the user's

`monospace`, never a named family. The Omarchy shell's `Style.qml` defaults to `monospace` so every
surface follows the fontconfig alias `omarchy font set` writes, and a device that named a font would
be the one surface ignoring the user's choice.

## Adding a device

1. Implement `AnchorDevice` in `devices/src/adapters/`. Read capabilities *from the device* where
   you can — the Stream Deck adapter reads Elgato's `CONTROLS` array rather than keeping a table of
   per-model constants, which is why a Mini or XL works through the same file.
2. Map the device's native events onto `DeviceInput`.
3. Write tests that run with no hardware. Everything except the transport should.
4. If the shared contract genuinely does not fit — a device with a keyboard, or one that needs a
   scrolling list — extend `types.ts` deliberately and say why in your PR. Do not work around it in
   an adapter; the next device will need the same thing.

Run the gates: `npm run typecheck` and `npm test` in `devices/`, `npm run lint` at the root.

## Status

| Device | State |
|---|---|
| Elgato Stream Deck + | Working. Measured on firmware 2.0.3.5: 8 keys at 120x120, an 800x100 LCD segment, 4 encoders with no display. Input and output verified on hardware. |
| Other Stream Deck models | Should work — capabilities are read from the device, not hard-coded — but untested. |
| ESP32 pulse display | Designed, not built. See `devices-esp32.md`. |
| M5Stack Cardputer | Designed, not built. See `devices-cardputer.md`. |

The Anchor page currently shows service reachability and whether a wallet is configured. It does not
render a portfolio value: the shape of `/portfolio/value`'s `data` comes from the OpenSea SDK and has
not been measured against a live credentialed service, and this project has already spent an
afternoon on a plausible number taken for a true one. The envelope's `meta` — `fetchedAt`,
`ageSeconds`, `stale` — *is* read from `service/src`, and is what provenance will be drawn from.
