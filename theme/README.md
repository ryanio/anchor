# theme

Anchor's design system. Two files, in cascade order:

| File | What it is |
|---|---|
| `tokens.css` | The palette and scale. Colours, spacing, radii, glass, the ambient wash. |
| `components.css` | Named things built from the tokens: pills, steps, buttons, rows, surfaces. |

**Compose from these. Do not invent alongside them.** The site, the Quickshell widget and the
standalone pages in `~/Documents` all draw from this one vocabulary, which is the only reason a
change to the palette reaches all three.

## Design principles

These govern every surface Anchor draws — the site, the standalone pages, and the Quickshell
widget. They are here rather than in a PR description because they are standing rules.

1. **Open on a few things.** The default view is what someone can take in at a glance: a handful of
   lines and one obvious action. The bar for a row appearing on open is that someone would *act* on
   it. Measure against Omarchy's own Tailscale menu, which is a switch and a short list.
2. **Reassurance is not information.** A row that exists so the user feels informed — a freshness
   line on a current reading, a split of a number already shown, a note that nothing bad can
   happen — is a candidate for hiding. Say it once, somewhere it can be looked up.
3. **Defer, don't delete — but be willing to delete.** Advanced, diagnostic and rarely-needed
   things move behind a disclosure, a tab or a secondary view; they stay true and reachable. What
   *does* get deleted is redundancy: the same fact said four ways is three rows of nothing. The
   best fix in this project so far was removing a setup step, not restyling one.
4. **A step should do the thing, not describe it.** If the panel can complete an action, it offers
   a button; the raw command becomes a footnote behind the disclosure. The exception is anything
   that needs a secret typed — that gets a plain one-line instruction and a way to open the right
   prompt elsewhere, never a field in the UI.
5. **Depth instead of dividers.** Three surfaces — ground, raised, sunken — do the work that a
   stack of hairlines does badly. A separator says where a group ends; a surface says that *and*
   gives the eye somewhere to rest.
6. **Never a colour at a call site.** Every colour resolves through a token here, or — in the
   widget — through the live Omarchy theme. A hex value in a `.qml` file or a component rule is the
   thing to avoid, and it is what keeps a future re-theme a one-file change (see below).

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
node scripts/check-contrast.ts    # 38 pairs, light and dark
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

### Surfaces — `.card`, `.card--raised`, `.well`, `.lift`

`.surface` and `.glass` live in `tokens.css`; they are as primitive as a colour. These three are
what every consumer was building by hand on top of them:

- `.card` — a surface with the padding it almost always wants.
- `.card--raised` — a group of rows one step further toward the reader. The third layer, and the
  counterpart of the widget's `PanelBlock`. On a light theme it resolves to the same value as
  `.card`, deliberately: white is the top of a light stack and there is no headroom above it.
- `.well` — an inset, one step *away* from the reader. Hints, commands, quoted output. Borderless
  on purpose: an inset that also has an edge reads as a card that failed to raise.
- `.lift` — composes onto any of them to make it respond to the pointer.

Three layers, not five. `ground → raised → sunken` is enough to group anything, and a fourth is how
a design ends up with no hierarchy at all — the same argument as the two button weights.

## What is not here

The **Quickshell widget** cannot use this stylesheet — QML has no CSS. `widget/Pill.qml`,
`SetupStep.qml`, `StepProgress.qml` and `PanelBlock.qml` implement the same vocabulary against the
live Omarchy palette instead, because a bar widget has to wear the desktop's colours rather than the
project's. The names, the variants, the three surfaces and the one-accent rule are deliberately
identical, so the two stay recognisable as one system.

The contrast floor there is enforced at runtime (`Model.dimAlpha`) rather than in CI, because the
colours are the user's current theme and are not known until it runs. That is not an excuse for not
gating them: `widget/test/model.test.mjs` runs the same WCAG arithmetic over the palettes of the
stock Omarchy themes — including `white` (a #ffffff ground with no headroom above it) and
`vantablack` (#000000, with none below) — and asserts that all three surfaces stay distinct and
still carry text at AA. That test is in CI.

## Roadmap step 3 — gallery and palette

Separate from the above, and not built yet: owned works rotate as wallpaper or a desktop gallery,
with an optional palette extracted into the current Omarchy theme. Every visual change must be
reversible in one action.

### Where a theme provider plugs in

Nothing here is built, and nothing here is blocked either. When a chosen NFT re-themes the desktop,
there are exactly two seams and no third:

| Consumer | Seam |
|---|---|
| Site and standalone pages | `tokens.css` — the semantic layer. Rewrite the `--bg` / `--text` / `--accent` block and every component follows, because rule 1 above means no rule holds a colour of its own. |
| Quickshell widget | The active Omarchy theme's `colors.toml`. `widget/OmarchyPalette.qml` reads it at runtime and `Model.panelSurfaces` derives the panel's three layers from it. |

The honest implementation is the second seam: **write the palette into the Omarchy theme**, and the
whole desktop follows — terminal, Neovim, notifications, the bar, this widget — with nothing in
Anchor to change. `omarchy theme set` already reloads it live. Failing that, one more source merged
into `OmarchyPalette.themeColors` reaches every colour the widget draws.

What would block it is a hex literal at a call site, which is why rule 6 is a rule. There are none:
`grep -n '#[0-9a-f]\{6\}' widget/*.qml` returns nothing but the fallback in `OmarchyPalette`, which
is the value used when no theme is applied at all.
