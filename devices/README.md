# devices

Anchor on physical hardware. The Stream Deck is the first device; ESP32 displays and Cardputers
are the reason the layer exists at all.

**Opt-in.** Nothing here is installed unless you own a device. This workspace keeps its own
`package.json` and its only runtime dependency lives here, so `npm ci` at the repo root does not
pull a USB HID binding onto a machine with nothing plugged in.

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

### Key state

`state` decides when a key renders as active: `nightlight`, `awake`, `muted`, `workspace:N`,
`occupied:N`, `page:<name>`.

### Dial controls

`control` is one of `volume`, `brightness`, `workspace`, `theme`, or `none`. `press` takes any
action. `step` scales each detent.

### Strip segments

`workspace`, `window`, `volume`, `brightness`, `cpu`, `memory`, `theme`, `clock`, `page`,
`anchor.service`, `anchor.chain`.

A reading that is absent renders as `—`, never as `0`. A zero is a reading; on a machine with no
backlight, "0%" would be a false one.

## Colour and type

Colour resolves through the live Omarchy theme, never a literal — the same rule the Quickshell
widget follows (`theme/README.md` principle 8). Switch theme and the panel follows within a second.

The font family is `monospace`, not a named font, so the device follows whatever `omarchy font set`
wrote. Hierarchy comes from size, weight and colour within that family.

Marks are held to WCAG AA against the tile: 4.5:1 for labels, 3:1 for icons and rules, over every
installed theme, gated by `src/contrast.test.ts`. A theme whose accent does not clear the bar is
nudged toward its own foreground until it does rather than being drawn illegibly.

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
