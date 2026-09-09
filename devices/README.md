# devices

Anchor on physical hardware. The Stream Deck is the first device; ESP32 displays and Cardputers
are the reason the layer exists at all.

**Opt-in.** Nothing here is installed unless you own a device. This workspace keeps its own
`package.json` and its only runtime dependency lives here, so `npm ci` at the repo root does not
pull a USB HID binding onto a machine with nothing plugged in.

## What it needs

**ImageMagick and librsvg**, as system packages. Key faces are drawn as SVG and rasterised, so
without them a device paints nothing. Not npm dependencies and they cannot be — they are binaries,
and the point of this workspace is that its npm side stays a single USB HID binding.

```bash
omarchy pkg add imagemagick librsvg     # or: sudo pacman -S imagemagick librsvg
```

Both, not either. `resolveBinary` looks for `magick` (ImageMagick 7) or `convert` (6), but
ImageMagick 6 does not rasterise SVG itself — it shells out to `rsvg-convert`. On a machine with
ImageMagick and no librsvg the check passes and every render fails, with `delegate failed` rather
than anything about a missing package. Worth tightening: the check proves a binary exists, not that
it can rasterise an SVG.

## Try it

```bash
cd devices && npm install
node --experimental-strip-types src/cli.ts --list    # what is attached
node --experimental-strip-types src/cli.ts           # run the panel
```

No `sudo`, and no udev rule: on Omarchy, logind's `uaccess` ACL already grants the logged-in user
read/write on `/dev/hidraw*`.

Review a panel without hardware — useful in CI, or away from the desk:

```bash
node --experimental-strip-types src/cli.ts --dry-run --preview /tmp/panel.png
node --experimental-strip-types src/cli.ts --dry-run --theme "Rose Pine" --page anchor --preview /tmp/p.png
```

`--dry-run` renders through a `VirtualDevice`; `--model` picks its geometry (`plus`, `original`,
`mini`, `xl`).

## How it fits together

```
config (panel.json) ─┐
                     ├─► Panel ──► Frame (Surface per slot) ──► Adapter ──► hardware
desktop + service ───┘                     │
                                    tokens.ts (live Omarchy theme)
```

`Panel` never learns which device it is driving. It is handed a device's `SlotSpec`s and fills the
ones that exist, which is what makes the next device an adapter rather than a rewrite. See
[`../docs/devices.md`](../docs/devices.md) for the contract and how to add one.

## Configuration

`~/.config/anchor/devices.json`, falling back to [`config/panel.json`](config/panel.json).

Icons are written as `\uXXXX` escapes rather than literal glyphs. Nerd Font symbols live in the
private use area, and a literal one is a single copy-paste away from becoming a replacement
character; `""` always survives.

```json
{
  "brightness": 70,
  "pages": [
    {
      "name": "desktop",
      "keys": [
        { "index": 0, "icon": "", "label": "Terminal", "action": "omarchy launch terminal" },
        { "index": 5, "icon": "", "label": "Night", "action": "omarchy toggle nightlight", "state": "nightlight" }
      ],
      "dials": [{ "index": 0, "control": "volume", "press": "volume mute", "step": 5 }],
      "segments": [{ "source": "workspace", "icon": "" }]
    }
  ]
}
```

### Actions

Verb first. An unknown verb is refused rather than guessed at.

| Action | Does |
|---|---|
| `omarchy <args>` | Run an Omarchy command — `omarchy toggle nightlight` |
| `hypr <args>` | A Hyprland dispatcher — `hypr workspace 3` |
| `exec <cmd> <args>` | Run a command, argv-style. No shell, so no globbing or redirection |
| `page <name>` | Switch panel page |
| `volume <n>` \| `volume mute` | Adjust or mute output, with Omarchy's on-screen display |
| `brightness <n>` | Adjust the backlight, on machines that have one |
| `theme` \| `theme prev` | Cycle Omarchy themes |
| `noop` | Nothing. Useful for a key that is only a readout |

**No action can sign, spend, or approve anything.** That is deliberate: a device is the least
trustworthy requester in the system, and per invariant 1 in `AGENTS.md` the executor decides. A test
asserts those verbs do not exist.

### Key readings

`source` puts a live number on a key, shown large with the label demoted to a caption. This is what
turns a key from a button into a display — which matters when the deck sits on a machine you are
often not in front of.

| Source | Shows |
|---|---|
| `portfolio.total` / `portfolio.nft` / `portfolio.token` | Portfolio value, in USD |
| `portfolio.pnl` / `portfolio.pnlAbsolute` | P&L over the current timeframe, green up, red down |
| `portfolio.nftCount` | NFTs held |
| `token:N` | The Nth largest token holding, captioned with its symbol |
| `collection:N` | The Nth collection by holdings, captioned with its slug |

Only holdings OpenSea classifies `OK` are shown. Its `status` field also marks `SPAM`, `WARNING`,
`LOW_LIQUIDITY` and `LOW_VALUE`, and an unfiltered "top tokens" list on a wallet that has been
airdropped at is a list of scams wearing Anchor's authority.

An absent reading renders as `—`, never `0`. A zero is a reading; "no wallet configured" is not.

**`collection:N` ranks by count, not value.** `Nft` in the OpenAPI spec carries no price, so ranking
holdings by worth needs a floor-price request per collection. That is a real feature with a real
request budget, not something to approximate — and an approximation here would be indistinguishable
from a measurement.

### Key state

`state` decides when a key renders as active: `nightlight`, `awake`, `muted`, `workspace:N`,
`occupied:N`, `page:<name>`.

### Dial controls

`control` is one of `volume`, `brightness`, `workspace`, `theme`, `timeframe`, or `none`. `press`
takes any action. `step` scales each detent.

`timeframe` is the odd one out, and the most interesting: it changes what is *shown* rather than what
the machine is doing, scrubbing the portfolio window through `HOUR → DAY → WEEK → MONTH`. Those four
are what `/portfolio/value` accepts. A physical control over a data dimension is the thing a dial is
genuinely better at than a keyboard shortcut.

### Strip segments

`workspace`, `window`, `volume`, `brightness`, `cpu`, `memory`, `theme`, `clock`, `page`,
`anchor.service`, `anchor.chain`, `anchor.total`, `anchor.timeframe`, `anchor.age`.

`anchor.age` is provenance rather than decoration: it says how old the figures are and whether the
service served them stale after a failure. A number attached to its age can be checked; one that
simply appears cannot.

A reading that is absent renders as `—`, never as `0`. A zero is a reading; on a machine with no
backlight, "0%" would be a false one.

## Pages

Three ship, and each fills all eight keys:

- **desktop** — workspaces, theme, night light, screenshot; volume, workspace, brightness and theme
  on the dials.
- **portfolio** — total, NFT and token value, P&L, and the three largest holdings. Dial 1 scrubs the
  timeframe.
- **anchor** — holdings: NFTs held, top collections, absolute P&L, and links out.

Swipe the touch strip to page.

## Colour and type

Colour resolves through the live Omarchy theme, never a literal — the same rule the Quickshell
widget follows (`theme/README.md` principle 8). Switch theme and the panel follows within a second.

The font family is `monospace`, not a named font, so the device follows whatever `omarchy font set`
wrote. Hierarchy comes from size, weight and colour within that family.

Marks are held to WCAG AA against the surface they are actually drawn on, over every theme installed
on the machine *and* every theme in [`../themes`](../themes), gated by `src/contrast.test.ts`. That
test reads each `colors.toml` from disk rather than resolving it through `omarchy theme dir`,
because a name that does not resolve falls back to Tokyo Night — right at paint time, and in a gate
it means an unreadable palette gets measured as Tokyo Night and passes.

`tokens.ts` corrects a theme in three places, and only where the theme said nothing usable:

- **Tones** — `accent`, `positive`, `negative`, `warning` — clear 4.5:1 on the key. Text contrast
  rather than the 3:1 a mark would need, because each is also drawn as a tile's *reading*, and
  `autoSize` shrinks a long one to 13px to keep its last digits. The correction slides the colour's
  lightness and leaves its hue alone: blending toward the theme's foreground is a hue change, and
  rescuing `rose-pine`'s teal that way produced a slate purple that was legible and no longer Rose
  Pine.
- **Surfaces** — `raised`, `sunken` and the tile edge are real steps off the ground, derived from it
  when the theme's own value is not one, reversing direction where the ground has no headroom. Five
  stock themes set `lighter_background` to their own `background`, which made a key press flash at
  1.02:1. This is the rule `widget/PulseModel.js` already used for the panel.
- **Active keys** carry their tone as a *fill*, and `onActive` picks the marks. A key that is on
  should be lit; the previous 30% tint with the tone drawn back on top measured 2.25:1 on
  `rose-pine`, because a fixed blend fraction barely moves a near-black ground and halves the
  contrast of a near-white one.

A theme authored for a key needs none of this. See [`../themes`](../themes) for what that takes.

## Rendering

A key face is authored as SVG and rasterised by ImageMagick straight to raw RGB, which is what the
device wants — so nothing here decodes an image format, and rendering costs no dependency.
ImageMagick is already a documented tool in this repo.

Glyph metrics are measured, not assumed. Nerd Font symbols advance 0.6em but paint up to 1.04em
wide, so centring on the advance box puts an icon visibly right of centre. `src/glyphs.ts` measures
each glyph through the same rasteriser and caches the result per font under
`$XDG_CACHE_HOME/anchor/`.

## Development

```bash
npm test           # node --test, no framework
npm run typecheck
cd .. && npm run lint
```

Everything except the adapters runs with no hardware attached.
