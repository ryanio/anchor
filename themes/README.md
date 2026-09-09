# themes

Omarchy themes authored by this project. They are ordinary user themes — a flat `colors.toml` in
the shape every stock theme uses — so the whole desktop wears them: terminal, Neovim, notifications,
the bar, the Quickshell widget, and the Stream Deck.

| Theme | Mode | Reads as |
|---|---|---|
| `harbor` | dark | Deep water and running lights. Slate navy, cyan accent. |
| `lantern` | dark | The warm counterpart. Near-black with amber. |
| `driftwood` | light | Bleached wood and deep water. Warm paper, petrol blue. |

## Install

```bash
cp -r themes/harbor themes/lantern themes/driftwood ~/.config/omarchy/themes/
omarchy theme set Harbor
```

`omarchy theme list` picks them up with no further step, and a user theme wins over a stock one of
the same name. Nothing here ships a `.lua`, a terminal config or a `vscode.json`: those name a
program to launch or an extension to install, `omarchy-theme-set` refuses them from an installed
theme for exactly that reason, and every one of them is generated from `colors.toml` anyway.

## Why a theme of our own

These exist because the stock set is authored for a screen, and a Stream Deck key is not one. Two
rules came out of looking at all twenty-two on a 120×120 backlit tile, and both are in the palettes
rather than in a renderer:

**The ground is not black.** A key face at #000000 reads as a dead key on a lit deck, and a ground
with no luminance of its own leaves the gap between keys nowhere to go — `devices/src/tokens.ts` has
to derive a *lighter* gap to give such a key any shape at all. Harbor grounds at `#131e28` and
Lantern at `#1e1913`, each with enough room beneath it for a near-black gap that reads as a bezel.

**`selection` is an edge, not a whisper.** It draws the outline of every key. Across the stock set
it runs from 1.13:1 to 2.50:1 against the tile, and the bottom of that range draws nothing; these
sit at 2.07–2.20:1, comfortably inside the band `deriveSurfaces` would otherwise correct them into.

A third applies only to Driftwood, and is the reason light themes are the hard case: on a light key
a mark has to go **down** to be legible. Every coloured role in it is a deep, saturated version of
its hue rather than the pastel a light theme reaches for — the yellow is an ochre, the green a pine,
the red an oxide — so all four clear 4.5:1 as authored and none arrives on the deck as a different
colour from the one on the desktop.

The measurable claim: these are the only themes on a stock Omarchy install whose surface ladder,
tile edge and four tones all pass `devices/src/contrast.test.ts` exactly as written, with nothing
corrected at paint time. Every stock theme needs at least one correction.

## Backgrounds

`make-backgrounds.sh` recomputes each wallpaper from that theme's own `colors.toml`, so a palette
change and its desktop stay in step. Run it after editing a colour; do not hand-edit the JPEGs.

```bash
themes/make-backgrounds.sh
```

## Changing a colour

Run the gate. It reads these files directly rather than through `omarchy theme dir`, so it covers
them on a machine with no Omarchy install:

```bash
cd devices && npm test
```

Then **look at the result** — AGENTS.md forbids shipping a visual change you have only reasoned
about, and a palette is nothing but a visual change:

```bash
cd devices
node --experimental-strip-types src/cli.ts --dry-run --theme Harbor --page desktop --preview /tmp/k.png
```
