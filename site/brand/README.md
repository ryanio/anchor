# Brand

An anchor that reads as an **A**. Distinctive rather than a stock anchor glyph, and it survives being
shrunk to a favicon.

| File | Use |
|---|---|
| `anchor.svg` | The mark. `stroke="currentColor"` — it takes the colour of its context |
| `anchor-solid.svg` | Heavier stroke, for stamping on a solid fill (OG cards, stickers, print) |
| `favicon.svg` | Rounded tile, heavier stroke, adapts to the OS light/dark preference |

## Inline it, never `<img src>`

An SVG loaded through `<img>` is an isolated document: `currentColor` resolves against its own root,
not the page, so the mark renders black or as a broken icon. Read the file and inline it — that is
what lets one file theme itself everywhere. `site/build.ts` does this for the site header.

## Colour

The mark carries no colour of its own. Set it on the parent:

| Context | Colour |
|---|---|
| Dark background | `#5fd4e4` |
| Light background | `#0d6b80` |
| On a solid accent fill | `#f7fafb` |

## Clear space and size

Keep clear space of at least the ring's diameter on every side. Minimum 16px — below that use
`favicon.svg`, whose heavier stroke is the whole reason it exists.

## Generated assets

Illustration, OG cards and textures come from `scripts/generate-asset.ts` (xAI Grok Imagine). **Do not
generate the logo or icons.** Hand-authored SVG themes with `currentColor`, stays crisp at any size,
and costs a few hundred bytes — a raster does none of that.
