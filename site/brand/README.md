# Brand

An anchor that reads as an **A**. Distinctive rather than a stock anchor glyph, and it survives being
shrunk to a favicon.

| File | Use |
|---|---|
| `anchor.svg` | The mark. `stroke="currentColor"` — it takes the colour of its context |
| `anchor-solid.svg` | Heavier stroke, for stamping on a solid fill (OG cards, stickers, print) |
| `anchor-bar.svg` | Square variant, for a status bar or any row of icons. See below |
| `favicon.svg` | The bar mark on a rounded tile, adapting to the OS light/dark preference |

## Inline it, never `<img src>`

An SVG loaded through `<img>` is an isolated document: `currentColor` resolves against its own root,
not the page, so the mark renders black or as a broken icon. Read the file and inline it — that is
what lets one file theme itself everywhere. `site/build.ts` does this for the site header.

## The square variant

`anchor.svg` is 32 wide by 45 tall on its 64-unit grid — an aspect of 0.71. Two things go wrong with
it in a status bar, and they need different fixes.

**Shape.** Every neighbour there is a glyph in a square slot. Fitted to an 11px slot the full mark
draws 10×12 and reads as the one tall, narrow thing in the row. Making it *smaller* cannot fix that,
because scaling preserves aspect ratio.

**Weight.** At that size the full mark's stroke computes to **0.93 device pixels**. Under one, so it
antialiases to grey — not styled thin, starved. No change of size or geometry fixes that either.
Only *fewer elements*, which buys the room for a heavier stroke.

So `anchor-bar.svg` is the top of the anchor: the ring and the branches off it, flukes cropped, on
square bounds of 36×36 at stroke 6. That draws 1.57 device pixels at bar size and fills the slot in
both directions.

**What it costs.** Without the flukes it reads as a monogram rather than an anchor. That is a trade
worth making for a 16px glyph and not for anything larger — which is why the full mark is still the
logo everywhere it has room. Use `anchor-bar.svg` in a row of icons at 16px or less, and
`anchor.svg` everywhere else.

## Colour

The mark carries no colour of its own. Set it on the parent:

| Context | Colour |
|---|---|
| Dark background | `#5fd4e4` |
| Light background | `#0d6b80` |
| On a solid accent fill | `#f7fafb` |

## Clear space and size

Keep clear space of at least the ring's diameter on every side.

**Minimum 16px for `anchor.svg`** — and at 16px prefer one of the other two, because a favicon and a
bar slot are the same problem: `favicon.svg` on a tile, `anchor-bar.svg` bare. Both carry the square
geometry, so the system is one rule — **the full anchor where there is room, the crown where there
is not** — rather than three unrelated drawings.

The tile is its own clear space, so the ring-diameter rule does not apply inside it.

## Generated assets

Illustration, OG cards and textures come from `scripts/generate-asset.ts` (xAI Grok Imagine). **Do not
generate the logo or icons.** Hand-authored SVG themes with `currentColor`, stays crisp at any size,
and costs a few hundred bytes — a raster does none of that.
