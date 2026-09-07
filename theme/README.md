# theme

Anchor's design system. Two files, in cascade order:

| File | What it is |
|---|---|
| `tokens.css` | The palette and scale. Colours, spacing, radii, glass, the ambient wash. |
| `components.css` | Named things built from the tokens: pills, steps, buttons, rows, surfaces. |

**Compose from these. Do not invent alongside them.** The site, the Quickshell widget and the
standalone pages in `~/Documents` all draw from this one vocabulary, which is the only reason a
change to the palette reaches all three.

## The three rules

1. **Never a raw colour in a component.** Every value in `components.css` is a token. A component
   that needs a colour the tokens do not have needs a *token* — added to `tokens.css` and gated by
   `scripts/check-contrast.ts` — not a hex escaping into a rule.
2. **One accent per view.** Exactly one variant of each component carries the attention colour:
   `.pill--required`, `.btn--strong`, `.step.is-current`. Everything else distinguishes itself by
   weight — border, fill, text strength — never by inventing a second hue. That is what makes the
   rule enforceable rather than aspirational: a screen full of shouting is not expressible in this
   vocabulary.
3. **Motion is opt-in.** Every transition sits inside `@media (prefers-reduced-motion: no-preference)`,
   so the reduced-motion path is the absence of a rule rather than an override someone has to
   remember.

## Extending it

Add to `tokens.css`; never fork it and never define a competing palette. If your new colour is text
on a surface, add the pair to `PAIRS` in `scripts/check-contrast.ts` in the same change — CI runs it
and a colour that looks good but fails WCAG AA cannot land.

```bash
node scripts/check-contrast.ts    # 32 pairs, light and dark
```

## The components

### Pills — `.pill`

A small semantic label. The variant chooses **weight, never hue**.

| Variant | For | Drawn as |
|---|---|---|
| `.pill--required` | The one thing that must happen | Filled, bordered, accent-coloured |
| `.pill--recommended` | Worth doing; nothing is blocked on it | Bordered, full-strength text |
| `.pill--optional` | Permission to skip | Hairline border, muted text |
| `.pill--done` | A fact about the past | No border, subtle text, `✓` prepended |

`optional` is worded and drawn as permission, not warning. It is the affordance that lets someone
*leave a step behind*, so it must not look like something has gone wrong. Make it a `<button>` and
it gains a pointer, a hover and a `›` — a pill you can press is a control; a pill you cannot is a
caption.

```html
<button class="pill pill--optional">2 optional</button>
<span class="pill pill--done">stored</span>
```

### Steps — `.steps` / `.step`

A sequence with a position in it. States: `.is-done`, `.is-current`, `.is-upcoming`.

Numbering is decoration on most lists. It is legitimate here because these genuinely are a sequence
— a key stored before the service runs cannot be verified — so the number encodes something true.

The marker is the whole emphasis budget: `.is-current` is a filled disc with the number knocked out
of it. Show the detail line on the current step only; on an upcoming step it is noise, and the CSS
hides it for you.

**A completed step should leave the list**, with `.progress` keeping the record. Ticking rows in
place makes a queue that never gets shorter.

```html
<ol class="steps">
  <li class="step is-current">
    <span class="step-marker">1</span>
    <div><div class="step-title">Start the data service</div>
         <div class="step-detail">Everything Anchor shows is read through it.</div></div>
  </li>
</ol>
```

### Progress — `.progress`

Segments, not a continuous bar. A continuous bar answers "how far", which is a guess; segments
answer "how many, and which" — countable, and true. One `.progress-seg` per step, `.is-filled` on
the completed ones. Label the container for screen readers, since the shape carries the meaning:

```html
<div class="progress" role="img" aria-label="Step 2 of 3">
  <span class="progress-seg is-filled"></span>
  <span class="progress-seg"></span>
  <span class="progress-seg"></span>
</div>
```

This is the one place motion is spent: a segment filling as its step completes.

### Buttons — `.btn`, `.btn--strong`

Two weights, and only two. A third is how a design ends up with no hierarchy at all. `.btn--strong`
is the one thing to click on a view — accent-tinted, never a solid slab, because a filled button at
this scale outweighs the content above it.

### Rows — `.rows` / `.row`

A name on the left, a value on the right, an optional second line under the name. The shape of
almost every list here: floors, deadlines, diary entries, activity.

`.row-name` and `.row-sub` truncate by default. That is a layout choice on a diary title and a
**defence** on a collection name, so it is the default rather than something each caller remembers
to opt into. `.row--faded` is for data we have but can no longer vouch for — faded, never hidden,
because removing a stale row reads as one the user deleted.

### Surfaces — `.card`, `.well`, `.lift`

`.surface` and `.glass` live in `tokens.css`; they are as primitive as a colour. These three are
what every consumer was building by hand on top of them:

- `.card` — a surface with the padding it almost always wants.
- `.well` — an inset, one step *away* from the reader. Hints, commands, quoted output. Borderless
  on purpose: an inset that also has an edge reads as a card that failed to raise.
- `.lift` — composes onto any of them to make it respond to the pointer.

## What is not here

The **Quickshell widget** cannot use this stylesheet — QML has no CSS. `widget/Pill.qml`,
`SetupStep.qml` and `StepProgress.qml` implement the same vocabulary against the live Omarchy
palette instead, because a bar widget has to wear the desktop's colours rather than the project's.
The names, the variants and the one-accent rule are deliberately identical, so the two stay
recognisable as one system; the contrast floor is enforced at runtime there (`Model.dimAlpha`)
rather than in CI, because the colours are the user's current theme and are not known until it runs.

## Roadmap step 3 — gallery and palette

Separate from the above, and not built yet: owned works rotate as wallpaper or a desktop gallery,
with an optional palette extracted into the current Omarchy theme. Every visual change must be
reversible in one action.
