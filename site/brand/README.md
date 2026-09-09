# Brand

One mark, at every size: a ring, two branches off it, a crossbar. It reads as an **A** — and as the
head of an anchor, which is the half of an anchor that survives being 11 pixels tall.

| File | Use |
|---|---|
| `anchor.svg` | The mark. `stroke="currentColor"` — it takes the colour of its context |
| `anchor-solid.svg` | The same drawing, heavier. Bars, tray icons, stamping on a solid fill |
| `favicon.svg` | The same drawing on a rounded tile, adapting to the OS light/dark preference |

Three files, one geometry, three weights. There is no second drawing — there was, for about a day,
and two marks for one product is a cost with no payer: the bar showed one thing and the site showed
another.

## Why the flukes are gone

The mark used to be a whole anchor, flukes and all, and a status bar broke it two ways at once.

**Shape.** It was 32 wide by 45 tall on its 64-unit grid. Every neighbour in a bar is a glyph in a
square slot, so fitted to an 11px slot it drew 10×12 and read as the one tall, narrow thing in the
row. Making it smaller cannot fix that — scaling preserves aspect ratio.

**Weight.** At that size its stroke computed to **0.93 device pixels**. Under one, so it antialiased
to grey. Not styled thin: starved. And no change of size or geometry fixes it, because a smaller
slot makes the stroke smaller with it.

Only *fewer elements* buy the room for a heavier stroke. Six became four, the bounds became 36×36 —
square — and the stroke became 1.57 device pixels at bar size. What it costs is the anchor read: at
96px this is a monogram where the old one was unmistakably an anchor. That was the trade, made
deliberately, because a mark that only works when it is large is not a mark.

## Weights

| Where | Stroke | Why |
|---|---|---|
| A bar, a tray, a favicon | 6 | 1.57 device pixels at 11px. Below this the stroke goes sub-pixel |
| A hero, a header, print | 4.5 | Room to be lighter, so it is |

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

Keep clear space of at least the ring's diameter on every side. The favicon's tile is its own clear
space, so the rule does not apply inside it.

There is no minimum size, which is the point of the redraw: the mark is legible at 11px because that
is the case it was drawn for. Below about 10px use `favicon.svg`, whose filled tile carries contrast
the bare strokes cannot.

## Generated assets

Illustration, OG cards and textures come from `scripts/generate-asset.ts` (xAI Grok Imagine). **Do not
generate the logo or icons.** Hand-authored SVG themes with `currentColor`, stays crisp at any size,
and costs a few hundred bytes — a raster does none of that.
