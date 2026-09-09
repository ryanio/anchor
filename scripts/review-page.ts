#!/usr/bin/env node
/**
 * Build the page a human marks up, once `scripts/review.ts` has taken the photographs.
 *
 * Split out of the capture script for two reasons. The obvious one is size — the page is mostly CSS
 * and browser JavaScript, and it had grown larger than the screenshot logic it shared a file with.
 * The useful one is `--page-only`: capture needs a Wayland session, Quickshell and about a minute,
 * so changing a colour on the page used to mean re-photographing every surface to see it. The two
 * halves run apart now.
 *
 * ## What the page is for
 *
 * There are twenty-three states, and the failure mode is not missing one. It is looking at all of
 * them with the same eyes. A flat column of cards is read attentively for the first four and
 * scrolled past for the rest, which is roughly how the panel's warning screens managed to sit on a
 * review page without anyone reviewing them.
 *
 * So this is a walkthrough rather than a list:
 *
 * - **Chapters in the order a person meets them.** A fresh install, then the state it is in almost
 *   all the time, then everything at once, then the failures, then the strip that is on screen all
 *   day. Capture order is whatever was cheapest to photograph, which is nobody's experience of it.
 * - **Closed by default, and never hidden.** Every chapter keeps a contact strip of thumbnails in
 *   its own summary, so the whole review is one screen you can take in, and opening a chapter is a
 *   choice rather than the only way to find out what is inside it.
 * - **A focus mode that walks the lot on the arrow keys.** Flipping between two states is how you
 *   catch that they look identical — which offline and stale are specifically not supposed to.
 * - **Progress that fills up.** A surface counts as looked at once it is marked right or carries a
 *   note. The tally is the whole difference between a review that finished and one that stopped.
 */

/** What the page needs about a surface. `review.ts` hangs the capture function off the same shape. */
export interface SurfaceMeta {
  id: string;
  group: string;
  title: string;
  /** The chapter this appears under. Defaults to the group. */
  category?: string;
  /** What a reviewer should be looking for. Shown beside the shot. */
  looking: string;
  /** A bar strip rather than a panel. Laid out along the page rather than down a column. */
  strip?: boolean;
}

/**
 * One surface, and the file it was photographed into — or why it was not.
 *
 * `capturedAt` is the shot's mtime in milliseconds. A scoped capture refreshes part of a review and
 * leaves the rest, so the page has to be able to say which shots did not come from the same run —
 * an old photograph with nothing to say it is old is the failure this project keeps repeating.
 */
export type Shot = {
  surface: SurfaceMeta;
  file: string | null;
  reason?: string;
  capturedAt?: number;
};

/**
 * The order the chapters are worth walking, and one line of why each exists.
 *
 * A category with no entry here still appears: it lands after the known ones, in declaration order,
 * without a premise. A state should show up on this page the day it is added to the gallery, not
 * the day somebody remembers to come back and update this table.
 */
const CHAPTERS: Array<{ name: string; premise: string }> = [
  {
    name: "Getting started",
    premise: "A fresh install, and the minute before Anchor knows anything about you.",
  },
  {
    name: "Working",
    premise: "Configured, answering, nothing wrong — where it sits almost all of the time.",
  },
  {
    name: "The second view",
    premise: "Everything the panel holds, opened at once because someone asked for it.",
  },
  {
    name: "Something is wrong",
    premise: "Down, refused, stale, half-loaded. Each one has to say which of those it is.",
  },
  {
    name: "The bar",
    premise: "Twenty-six pixels tall, on screen all day. Read at a glance or not read at all.",
  },
  {
    name: "The bar, live",
    premise: "The same strip in its real neighbourhood, beside other people's icons.",
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON safe to sit between script tags: `<` is the only character that can end the element early. */
const json = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/** Chapters in walking order, with anything unlisted appended in the order it was declared. */
function chaptersOf(shots: Shot[]): Array<{ name: string; premise: string; shots: Shot[] }> {
  const grouped = new Map<string, Shot[]>();
  for (const shot of shots) {
    const key = shot.surface.category ?? shot.surface.group;
    grouped.set(key, [...(grouped.get(key) ?? []), shot]);
  }
  const known = CHAPTERS.filter((c) => grouped.has(c.name));
  const rest = [...grouped.keys()]
    .filter((name) => !CHAPTERS.some((c) => c.name === name))
    .map((name) => ({ name, premise: "" }));
  return [...known, ...rest].map((c) => ({ ...c, shots: grouped.get(c.name) ?? [] }));
}

export function page(shots: Shot[]): string {
  const chapters = chaptersOf(shots);
  // One flat sequence in chapter order. Everything downstream — the numbers on the cards, the walk,
  // the ticks along the bottom of the focus view — counts positions in this, so they all agree.
  const walk = chapters.flatMap((c) => c.shots.map((shot) => ({ chapter: c.name, shot })));
  const index = new Map(walk.map((entry, i) => [entry.shot.surface.id, i + 1]));
  const captured = walk.filter((entry) => entry.shot.file !== null).length;

  const data = walk.map(({ chapter, shot }) => ({
    id: shot.surface.id,
    title: shot.surface.title,
    looking: shot.surface.looking,
    chapter,
    file: shot.file,
    shotAt: shot.capturedAt ?? 0,
    reason: shot.file === null ? (shot.reason ?? "unknown reason") : "",
  }));

  const thumb = ({ surface, file }: Shot): string => {
    const n = index.get(surface.id) ?? 0;
    if (file === null) {
      return `<span class="thumb skipped" title="${esc(surface.title)} — not captured">—</span>`;
    }
    return `<button class="thumb${surface.strip ? " bar" : ""}" data-open="${esc(surface.id)}" data-surface="${esc(surface.id)}"
        title="${esc(surface.title)}"><img src="${esc(file)}" alt="${esc(surface.title)}" loading="lazy">
        <span class="i">${n}</span><span class="dot"></span></button>`;
  };

  const card = ({ surface, file, reason }: Shot): string => {
    const id = esc(surface.id);
    const body =
      file === null
        ? `<p class="skipped">Not captured — ${esc(reason ?? "unknown reason")}</p>`
        : `<div class="shot" data-id="${id}">
        <img src="${esc(file)}" alt="${esc(surface.title)}" loading="lazy">
        <div class="pins"></div>
      </div>`;
    // A bar strip takes the whole row rather than a column it would have to shrink into, which is
    // the one thing you cannot do to a shot of a 26px bar.
    const wide = surface.strip ? " wide" : "";
    const actions =
      file === null
        ? ""
        : `<div class="actions">
    <button class="btn okbtn" data-ok="${id}" aria-pressed="false">Looks right</button>
    <button class="btn" data-open="${id}">Open ⤢</button>
  </div>`;
    return `<section class="card${wide}" id="s-${id}" data-surface="${id}">
  <header>
    <span class="idx">${index.get(surface.id) ?? 0}</span>
    <h2>${esc(surface.title)}</h2>
    <span class="count" data-count-for="${id}"></span>
    <span class="age" data-age-for="${id}"></span>
  </header>
  <p class="looking">${esc(surface.looking)}</p>
  ${body}
  ${actions}
  <ol class="notes" data-for="${id}"></ol>
</section>`;
  };

  const body = chapters
    .map((chapter, i) => {
      const name = esc(chapter.name);
      return `<details class="chapter" data-chapter="${name}">
  <summary>
    <span class="num">${i + 1}</span>
    <span class="cname">${name}</span>
    <span class="ctally" data-chapter-tally="${name}"></span>
    <span class="cpremise">${esc(chapter.premise)}</span>
    <span class="strip">${chapter.shots.map(thumb).join("")}</span>
  </summary>
  <div class="cards">
${chapter.shots.map(card).join("\n")}
  </div>
</details>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anchor — review</title>
<style>
  :root {
    --bg: #06131a; --surface: #0a1c25; --sunk: #0e2531; --raised: #123240;
    --text: #e8f2f4; --muted: #93a8ad; --dim: #6f858b; --border: #14313d;
    --accent: #5fd4e4; --accent-rgb: 95 212 228;
    --ember: #ff8a6b; --ember-rgb: 255 138 107;
    --good: #67d69b; --good-rgb: 103 214 155;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  /* Several things here are laid out with grid or flex, and both beat a bare [hidden]. */
  [hidden] { display: none !important; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 0 0 80px;
  }
  .wrap { max-width: 1800px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 40px); }
  button { font: inherit; }
  kbd {
    font: 11px ui-monospace, Menlo, monospace; background: var(--sunk); color: var(--muted);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  }

  /* ── the deck ─────────────────────────────────────────────────────────────────────────────── */
  /* Sticky, because the tally and the walk button are the two things you want from anywhere on the
     page, and a review you have to scroll to the top to resume is one you stop resuming. */
  .deck {
    position: sticky; top: 0; z-index: 40; background: rgb(6 19 26 / .93);
    backdrop-filter: blur(12px); border-bottom: 1px solid var(--border);
  }
  .deck .wrap { padding-top: 14px; padding-bottom: 10px; }
  .deck-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 19px; letter-spacing: -.02em; }
  .sub { margin: 2px 0 0; color: var(--dim); font-size: 12.5px; }
  .grow { margin-left: auto; }
  .meter { display: flex; align-items: center; gap: 10px; }
  .track {
    width: min(240px, 30vw); height: 6px; border-radius: 999px;
    background: var(--raised); overflow: hidden; display: flex;
  }
  .track span { height: 100%; width: 0; transition: width .25s ease; }
  .track .ok { background: var(--good); }
  .track .noted { background: var(--ember); }
  .tally { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .btn {
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .btn:hover { color: var(--text); border-color: rgb(var(--accent-rgb) / .5); }
  .btn.primary {
    background: rgb(var(--accent-rgb) / .14); border-color: rgb(var(--accent-rgb) / .45); color: var(--accent);
  }
  .btn.primary:hover { background: rgb(var(--accent-rgb) / .22); color: var(--accent); }
  .chips { display: flex; gap: 6px; align-items: center; padding-top: 10px; flex-wrap: wrap; }
  .chip {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    border-radius: 999px; padding: 3px 11px; font-size: 12.5px; cursor: pointer;
  }
  .chip:hover { color: var(--text); }
  .chip[aria-pressed="true"] {
    color: var(--text); border-color: rgb(var(--accent-rgb) / .5); background: rgb(var(--accent-rgb) / .1);
  }
  .chips .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  /* A shot left over from an earlier run is a photograph of an older build. Keeping it beats
     deleting it — an old panel can still be reviewed — but only if the page says so. */
  /* Stated, not shouted. A scoped capture is the ordinary way to refresh part of a review, so this
     line is on screen most of the time and an alarm that is always on is not an alarm. */
  .stale-note {
    margin: 10px 0 0; font-size: 12.5px; color: var(--muted);
    border-left: 2px solid rgb(var(--ember-rgb) / .55); padding-left: 10px;
  }
  .age { font-size: 11.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .card header .age { margin-left: auto; }
  .age.old { color: var(--ember); }

  /* ── chapters ─────────────────────────────────────────────────────────────────────────────── */
  .chapter {
    border: 1px solid var(--border); border-radius: 14px; background: var(--surface); margin: 14px 0;
  }
  .chapter[hidden] { display: none; }
  .chapter > summary {
    list-style: none; cursor: pointer; user-select: none; padding: 14px 16px;
    display: grid; grid-template-columns: auto 1fr auto; gap: 2px 14px; align-items: center;
  }
  .chapter > summary::-webkit-details-marker { display: none; }
  .chapter > summary:hover .cname { color: var(--accent); }
  .num {
    grid-column: 1; grid-row: 1 / 3; align-self: center;
    width: 32px; height: 32px; border-radius: 999px; border: 1px solid var(--border);
    display: grid; place-items: center; font-size: 13px; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .chapter[open] .num { color: var(--accent); border-color: rgb(var(--accent-rgb) / .5); }
  .cname { grid-column: 2; grid-row: 1; font-size: 16.5px; font-weight: 620; letter-spacing: -.01em; }
  .ctally {
    grid-column: 3; grid-row: 1 / 3; align-self: center; font-size: 12px; color: var(--dim);
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .ctally.done { color: var(--good); }
  .ctally.noted { color: var(--ember); }
  .cpremise { grid-column: 2; grid-row: 2; color: var(--dim); font-size: 13px; }
  /* The contact strip is what makes a closed chapter still worth looking at. Once the chapter is
     open the cards below carry the same shots at a useful size, so the strip stands down. */
  .strip { grid-column: 2 / 4; grid-row: 3; display: flex; gap: 8px; flex-wrap: wrap; padding-top: 12px; }
  .chapter[open] .strip { display: none; }
  .thumb {
    position: relative; width: 132px; height: 86px; padding: 0; overflow: hidden;
    border: 1px solid var(--border); border-radius: 8px; background: #000; cursor: pointer;
  }
  /* Cropped from the top, where a panel keeps the header that says which panel it is. A panel
     shorter than the tile is shown whole instead — cropping one leaves an empty band of ground. */
  .thumb img {
    display: block; width: 100%; height: 100%; object-fit: cover; object-position: top center;
    opacity: .95; transition: opacity .15s ease;
  }
  .thumb.short img { object-fit: contain; background: #060f14; }
  /* A bar strip in a tile shaped like a panel is a photograph of a black rectangle, so the strips
     get a tile shaped like a bar. Where the source is small enough, they are shown at 1:1 and
     cropped rather than scaled — a 300px strip fits its content in the middle 90px, and at 1:1 the
     seven of them are told apart by what they say, which is the only thing that differs. */
  .thumb.bar { width: 210px; height: 36px; }
  .thumb.bar img { object-fit: contain; image-rendering: pixelated; background: #060f14; }
  .thumb.bar.crop img { object-fit: none; object-position: center center; }
  .thumb:hover { border-color: var(--accent); }
  .thumb:hover img { opacity: 1; }
  .thumb .i {
    position: absolute; left: 4px; top: 4px; font: 10px ui-monospace, Menlo, monospace;
    color: var(--muted); background: rgb(0 0 0 / .62); border-radius: 4px; padding: 0 4px;
  }
  .thumb .dot {
    position: absolute; right: 5px; top: 5px; width: 7px; height: 7px; border-radius: 999px;
    box-shadow: inset 0 0 0 1px rgb(232 242 244 / .35);
  }
  .thumb[data-status="ok"] .dot { background: var(--good); box-shadow: none; }
  .thumb[data-status="noted"] .dot { background: var(--ember); box-shadow: none; }
  .thumb[data-status="ok"] { border-color: rgb(var(--good-rgb) / .4); }
  .thumb[data-status="noted"] { border-color: rgb(var(--ember-rgb) / .4); }
  .thumb.skipped {
    display: grid; place-items: center; color: var(--ember); font-size: 13px; background: var(--sunk);
  }

  /* ── cards ────────────────────────────────────────────────────────────────────────────────── */
  /* auto-fill rather than auto-fit: with one card left over, auto-fit stretches it across the whole
     row and a 388px screenshot becomes a blurry banner. */
  .cards {
    display: grid; gap: 16px; padding: 0 16px 18px;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); align-items: start;
  }
  @media (max-width: 900px) { .cards { grid-template-columns: 1fr; } }
  .card {
    background: var(--sunk); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
  }
  .card[hidden] { display: none; }
  .card.wide { grid-column: 1 / -1; }
  .card[data-status="ok"] { border-color: rgb(var(--good-rgb) / .35); }
  .card[data-status="noted"] { border-color: rgb(var(--ember-rgb) / .35); }
  .card header { display: flex; align-items: baseline; gap: 10px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .idx {
    font: 11px ui-monospace, Menlo, monospace; color: var(--dim);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
  }
  .count:not(:empty) {
    color: var(--bg); background: var(--ember); font-size: 11px; font-weight: 700;
    border-radius: 999px; padding: 1px 7px; font-variant-numeric: tabular-nums;
  }
  .looking { margin: 8px 0 14px; color: var(--muted); font-size: 13.5px; max-width: 78ch; }
  .skipped { color: var(--ember); font-size: 13.5px; margin: 0; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .actions .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  .okbtn[aria-pressed="true"] {
    color: var(--good); border-color: rgb(var(--good-rgb) / .5); background: rgb(var(--good-rgb) / .12);
  }

  /* ── a shot, and the pins on it ───────────────────────────────────────────────────────────── */
  .shot { position: relative; display: inline-block; max-width: 100%; cursor: crosshair; }
  .shot img {
    display: block; max-width: 100%; height: auto;
    border: 1px solid var(--border); border-radius: 8px; background: #000;
  }
  /* Nearest-neighbour on anything blown up. Smoothing invents detail that is not in the capture,
     which is exactly the wrong thing to hand someone who is judging a 1.5px stroke. */
  .shot img.px { image-rendering: pixelated; }
  .pins { position: absolute; inset: 0; pointer-events: none; }
  .pin {
    position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; padding: 0;
    border: 0; border-radius: 999px; background: var(--ember); color: #1a0d08;
    font: 600 12px/22px ui-sans-serif, system-ui, sans-serif; text-align: center;
    box-shadow: 0 0 0 2px rgb(0 0 0 / .45); pointer-events: auto; cursor: pointer;
  }
  .pin.done { background: var(--accent); color: #04222a; }
  ol.notes { margin: 12px 0 0; padding-left: 0; list-style: none; display: grid; gap: 8px; }
  ol.notes:empty { margin: 0; }
  .note {
    display: flex; gap: 10px; align-items: flex-start; background: var(--raised);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px;
  }
  .note .n {
    flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 999px;
    background: var(--ember); color: #1a0d08; cursor: pointer;
    font: 600 11px/20px ui-sans-serif, system-ui, sans-serif; text-align: center;
  }
  .note.done .n { background: var(--accent); color: #04222a; }
  .note.done textarea { color: var(--dim); text-decoration: line-through; }
  .note textarea {
    flex: 1; background: transparent; border: 0; color: var(--text); resize: vertical;
    font: inherit; font-size: 14px; min-height: 22px; padding: 0; outline: none;
  }
  .note .del {
    flex: none; background: transparent; border: 1px solid var(--border); color: var(--dim);
    border-radius: 6px; font-size: 11px; padding: 2px 7px; cursor: pointer;
  }
  .note .del:hover { color: var(--text); border-color: var(--ember); }

  /* ── focus mode ───────────────────────────────────────────────────────────────────────────── */
  dialog#focus {
    border: 0; padding: 0; margin: 0; max-width: 100vw; max-height: 100dvh;
    width: 100vw; height: 100dvh; background: transparent; color: var(--text);
  }
  dialog#focus::backdrop { background: rgb(3 10 14 / .95); backdrop-filter: blur(8px); }
  .fx { display: flex; flex-direction: column; height: 100dvh; padding: 14px clamp(12px, 3vw, 28px); }
  .fx-top { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; }
  .fx-tools { display: flex; align-items: center; gap: 8px; }
  .fx-chapter {
    font: 10.5px ui-monospace, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase;
    color: var(--accent); border: 1px solid rgb(var(--accent-rgb) / .35);
    border-radius: 999px; padding: 3px 10px;
  }
  .fx-pos { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .fx-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; }
  .fx-stage { min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .fx-stage .shot img { max-height: calc(100dvh - 200px); }
  .nav {
    flex: none; width: 42px; height: 72px; border-radius: 10px; cursor: pointer;
    background: rgb(232 242 244 / .04); border: 1px solid var(--border); color: var(--muted);
    font-size: 22px; line-height: 1;
  }
  .nav:hover { color: var(--text); border-color: var(--accent); }
  .nav:disabled { opacity: .3; cursor: default; }
  .fx-side {
    overflow: auto; background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 16px;
  }
  .fx-side h2 { font-size: 17px; margin-bottom: 8px; }
  .fx-side .hint { color: var(--dim); font-size: 12.5px; margin: 14px 0 0; }
  .fx-foot { padding-top: 12px; }
  .fx-track { display: flex; gap: 3px; }
  .tick { flex: 1; height: 6px; border: 0; padding: 0; border-radius: 2px; background: var(--raised); cursor: pointer; }
  .tick[data-status="ok"] { background: var(--good); }
  .tick[data-status="noted"] { background: var(--ember); }
  .tick.cur { background: var(--accent); height: 10px; margin-top: -2px; }
  .keys { display: flex; gap: 16px; flex-wrap: wrap; color: var(--dim); font-size: 12px; padding-top: 10px; }
  .fx-end { display: grid; place-items: center; align-content: center; gap: 16px; text-align: center; height: 100%; }
  .fx-end h2 { font-size: 24px; letter-spacing: -.02em; }
  .fx-end p { color: var(--muted); margin: 0; max-width: 46ch; }
  @media (max-width: 1100px) {
    .fx-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
    .fx-side { max-height: 34dvh; }
    .fx-stage .shot img { max-height: calc(58dvh - 40px); }
  }

  /* ── the copy-out sheet ───────────────────────────────────────────────────────────────────── */
  dialog#out {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 12px; max-width: min(860px, 92vw); width: 100%; padding: 18px;
  }
  dialog#out::backdrop { background: rgb(0 0 0 / .6); }
  dialog#out textarea {
    width: 100%; min-height: 46vh; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    font: 12.5px/1.5 ui-monospace, Menlo, monospace; resize: vertical;
  }

  /* Filters hide by status, and both the cards and the thumbnails carry one, so a filtered page
     stays honest in its contact strips too. Scoped to main: the focus view's ticks carry a status
     as well, and a filter that emptied the progress bar underneath the shot would be nonsense. */
  body[data-filter="todo"] main [data-status="ok"], body[data-filter="todo"] main [data-status="noted"],
  body[data-filter="noted"] main [data-status="ok"], body[data-filter="noted"] main [data-status="none"] {
    display: none;
  }
</style>
</head>
<body data-filter="all">

<header class="deck">
  <div class="wrap">
    <div class="deck-row">
      <div>
        <h1>Anchor — review</h1>
        <p class="sub">${captured} surface${captured === 1 ? "" : "s"}, in the order a person meets them.</p>
      </div>
      <div class="grow meter">
        <div class="track" aria-hidden="true"><span class="ok"></span><span class="noted"></span></div>
        <span class="tally" id="tally"></span>
      </div>
      <button class="btn primary" id="walk">Walk through →</button>
      <button class="btn" id="copy">Copy notes</button>
      <button class="btn" id="expand">Expand all</button>
      <button class="btn" id="clear">Clear</button>
    </div>
    <div class="chips">
      <button class="chip" data-filter="all" aria-pressed="true">Everything</button>
      <button class="chip" data-filter="todo" aria-pressed="false">Not looked at</button>
      <button class="chip" data-filter="noted" aria-pressed="false">With notes</button>
      <span class="hint">click a shot to pin a note · <kbd>W</kbd> starts the walk</span>
    </div>
    <p class="stale-note" id="stale-note" hidden></p>
  </div>
</header>

<main class="wrap">
${body}
</main>

<dialog id="focus">
  <div class="fx">
    <div class="fx-top">
      <span class="fx-chapter" id="fx-chapter"></span>
      <span class="fx-pos" id="fx-pos"></span>
      <span class="age" id="fx-age"></span>
      <span class="grow"></span>
      <span class="fx-tools" id="fx-tools">
        <button class="btn" id="fx-zoom-out" title="Zoom out">−</button>
        <span class="tally" id="fx-zoom">1×</span>
        <button class="btn" id="fx-zoom-in" title="Zoom in">+</button>
        <button class="btn okbtn" id="fx-ok" aria-pressed="false">Looks right</button>
      </span>
      <button class="btn" id="fx-close">Close</button>
    </div>
    <div class="fx-body" id="fx-live">
      <div class="fx-stage">
        <button class="nav" id="fx-prev" title="Previous (←)">‹</button>
        <div class="shot" id="fx-shot" data-id=""><img id="fx-img" alt=""><div class="pins"></div></div>
        <button class="nav" id="fx-next" title="Next (→)" autofocus>›</button>
      </div>
      <aside class="fx-side">
        <h2 id="fx-title"></h2>
        <p class="looking" id="fx-looking"></p>
        <ol class="notes" id="fx-notes" data-for=""></ol>
        <p class="hint" id="fx-hint">Click anywhere on the shot to pin a note where the problem is.</p>
      </aside>
    </div>
    <div class="fx-end" id="fx-done" hidden>
      <h2>That is all of them.</h2>
      <p id="fx-done-line"></p>
      <div class="actions" style="justify-content:center">
        <button class="btn primary" id="fx-done-copy">Copy notes</button>
        <button class="btn" id="fx-done-again">Start again</button>
        <button class="btn" id="fx-done-close">Close</button>
      </div>
    </div>
    <div class="fx-foot">
      <div class="fx-track" id="fx-track"></div>
      <div class="keys">
        <span><kbd>←</kbd> <kbd>→</kbd> move</span>
        <span><kbd>G</kbd> looks right</span>
        <span><kbd>N</kbd> note</span>
        <span><kbd>+</kbd> <kbd>−</kbd> zoom</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>
  </div>
</dialog>

<dialog id="out"><textarea readonly></textarea>
  <div class="actions" style="justify-content:flex-end">
    <button class="btn" onclick="this.closest('dialog').close()">Close</button>
  </div>
</dialog>

<script>
(function () {
  var DATA = ${json(data)};
  // The walk is the captured surfaces only. A skipped one still gets a card saying why, but there
  // is nothing to look at, so it is not a stop on the tour and not a denominator either.
  var WALK = DATA.filter(function (s) { return s.file !== null; });
  var byId = {};
  // Named idx, not at. Every surface already carries shotAt, and two letters between a position in
  // the walk and a millisecond timestamp is how the second one silently became the first.
  WALK.forEach(function (s, i) { s.idx = i; byId[s.id] = s; });

  var KEY = "anchor-review-v2";
  var OLD = "anchor-review-v1";
  var state = load();
  var zoom = {};

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && s.notes) return { notes: s.notes, ok: s.ok || {}, open: s.open || {} };
    } catch (e) { /* private window, or a half-written value */ }
    // v1 stored a bare map of id to notes. Import it rather than starting empty — someone with a
    // half-finished review should not lose it because the page it was written on was redesigned.
    try {
      var old = JSON.parse(localStorage.getItem(OLD) || "null");
      if (old && typeof old === "object") return { notes: old, ok: {}, open: {} };
    } catch (e) { /* nothing to migrate */ }
    return { notes: {}, ok: {}, open: {} };
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private window */ }
  }

  function notesOf(id) { return state.notes[id] || (state.notes[id] = []); }

  // A note outranks a tick. Marking something right and then finding a problem with it leaves a
  // problem, and a green dot over an open note is how a review loses one.
  function statusOf(id) {
    if ((state.notes[id] || []).length > 0) return "noted";
    return state.ok[id] ? "ok" : "none";
  }

  // ── notes and pins ───────────────────────────────────────────────────────────────────────────

  function pinEl(id, item, i) {
    var pin = document.createElement("button");
    pin.className = "pin" + (item.done ? " done" : "");
    pin.style.left = item.x + "%";
    pin.style.top = item.y + "%";
    pin.textContent = String(i + 1);
    pin.title = item.done ? "Marked handled" : "Click to mark handled";
    pin.addEventListener("click", function (ev) {
      ev.stopPropagation();
      item.done = !item.done;
      save(); render(id);
    });
    return pin;
  }

  function noteEl(id, item, i) {
    var li = document.createElement("li");
    li.className = "note" + (item.done ? " done" : "");

    var n = document.createElement("button");
    n.className = "n";
    n.textContent = String(i + 1);
    n.title = "Mark handled";
    n.addEventListener("click", function () { item.done = !item.done; save(); render(id); });

    var ta = document.createElement("textarea");
    ta.value = item.text || "";
    ta.placeholder = "What should change here?";
    ta.rows = 1;
    ta.addEventListener("input", function () {
      item.text = ta.value;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      // Deliberately no re-render: rebuilding the list on every keystroke takes the caret with it.
      save();
    });

    var del = document.createElement("button");
    del.className = "del";
    del.textContent = "Remove";
    del.addEventListener("click", function () {
      notesOf(id).splice(i, 1);
      save(); render(id); refresh();
    });

    li.appendChild(n); li.appendChild(ta); li.appendChild(del);
    return li;
  }

  /** Repaint every copy of one surface — its card, and the focus view when it is showing it. */
  function render(id) {
    var items = state.notes[id] || [];
    document.querySelectorAll('.shot[data-id="' + id + '"] .pins').forEach(function (pins) {
      pins.innerHTML = "";
      items.forEach(function (item, i) { pins.appendChild(pinEl(id, item, i)); });
    });
    document.querySelectorAll('ol.notes[data-for="' + id + '"]').forEach(function (list) {
      list.innerHTML = "";
      items.forEach(function (item, i) {
        var li = noteEl(id, item, i);
        list.appendChild(li);
        var ta = li.querySelector("textarea");
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      });
    });
    var open = items.filter(function (n) { return !n.done; }).length;
    document.querySelectorAll('[data-count-for="' + id + '"]').forEach(function (badge) {
      badge.textContent = open > 0 ? String(open) : "";
    });
    var hint = document.getElementById("fx-hint");
    if (document.getElementById("fx-notes").getAttribute("data-for") === id) {
      hint.hidden = items.length > 0;
    }
  }

  // ── how old a shot is ────────────────────────────────────────────────────────────────────────

  // A capture run takes about a minute, so everything from one lands within minutes of everything
  // else. An hour is comfortably outside that: a shot older than the newest by more than an hour
  // came from an earlier run, and saying so is the price of a scoped capture no longer deleting
  // the shots it was not asked to retake.
  var RUN_WINDOW = 60 * 60 * 1000;
  var NEWEST = WALK.reduce(function (max, s) { return s.shotAt > max ? s.shotAt : max; }, 0);

  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 90) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + "h ago";
    return Math.round(h / 24) + " days ago";
  }

  function isOld(s) { return s.shotAt > 0 && NEWEST - s.shotAt > RUN_WINDOW; }

  function paintAges() {
    var now = Date.now();
    var old = 0;
    WALK.forEach(function (s) {
      if (!s.shotAt) return;
      var stale = isOld(s);
      if (stale) old++;
      document.querySelectorAll('[data-age-for="' + s.id + '"]').forEach(function (el) {
        el.textContent = ago(now - s.shotAt);
        el.classList.toggle("old", stale);
        el.title = stale
          ? "From an earlier capture run than the rest of this page"
          : "When this shot was taken";
      });
    });
    var note = document.getElementById("stale-note");
    note.hidden = old === 0;
    note.textContent =
      old + (old === 1 ? " shot is" : " shots are") + " from an earlier capture than the newest — " +
      "the last run did not retake " + (old === 1 ? "it" : "them") + ". Each card says how old it is; " +
      "node scripts/review.ts with no arguments refreshes everything.";
  }

  // ── tallies ──────────────────────────────────────────────────────────────────────────────────

  /** Whether a status survives the filter now showing. Kept beside the CSS that does the hiding. */
  function shown(st) {
    var filter = document.body.getAttribute("data-filter");
    if (filter === "todo") return st === "none";
    if (filter === "noted") return st === "noted";
    return true;
  }

  function refresh() {
    var ok = 0, noted = 0;
    var perChapter = {};
    WALK.forEach(function (s) {
      var st = statusOf(s.id);
      if (st === "ok") ok++;
      if (st === "noted") noted++;
      var c = perChapter[s.chapter] || (perChapter[s.chapter] = { seen: 0, noted: 0, total: 0, shown: 0 });
      c.total++;
      if (st !== "none") c.seen++;
      if (st === "noted") c.noted++;
      if (shown(st)) c.shown++;
      document.querySelectorAll('[data-surface="' + s.id + '"]').forEach(function (el) {
        el.setAttribute("data-status", st);
      });
    });

    var total = WALK.length || 1;
    document.querySelector(".track .ok").style.width = (ok / total) * 100 + "%";
    document.querySelector(".track .noted").style.width = (noted / total) * 100 + "%";
    var seen = ok + noted;
    document.getElementById("tally").textContent =
      seen === WALK.length && WALK.length > 0
        ? "all " + WALK.length + " looked at" + (noted > 0 ? " · " + noted + " with notes" : "")
        : seen + " of " + WALK.length + " looked at";

    document.querySelectorAll("[data-chapter-tally]").forEach(function (el) {
      var c = perChapter[el.getAttribute("data-chapter-tally")];
      if (!c) { el.textContent = ""; return; }
      el.textContent = c.seen === c.total ? "all " + c.total + " looked at" : c.seen + " of " + c.total;
      if (c.noted > 0) el.textContent += " · " + c.noted + " noted";
      el.classList.toggle("done", c.seen === c.total && c.noted === 0);
      el.classList.toggle("noted", c.noted > 0);
    });

    // A chapter whose every card is filtered out is an empty box with a heading on it. Counted from
    // the statuses rather than measured off the DOM, because a closed chapter's cards are not laid
    // out at all and every measurement of them reads as hidden.
    document.querySelectorAll(".chapter").forEach(function (ch) {
      var c = perChapter[ch.getAttribute("data-chapter")];
      ch.hidden = c !== undefined && c.shown === 0;
    });

    paintTrack();
  }

  // ── focus mode ───────────────────────────────────────────────────────────────────────────────

  var dlg = document.getElementById("focus");
  var live = document.getElementById("fx-live");
  var done = document.getElementById("fx-done");
  var stage = document.getElementById("fx-shot");
  var img = document.getElementById("fx-img");
  var track = document.getElementById("fx-track");
  var at = 0;

  WALK.forEach(function (s, i) {
    var tick = document.createElement("button");
    tick.className = "tick";
    tick.title = s.title;
    tick.addEventListener("click", function () { show(i); });
    track.appendChild(tick);
  });

  function paintTrack() {
    track.querySelectorAll(".tick").forEach(function (tick, i) {
      tick.setAttribute("data-status", statusOf(WALK[i].id));
      tick.classList.toggle("cur", dlg.open && i === at);
    });
  }

  /**
   * How much to blow a shot up before anyone is asked to judge it.
   *
   * A 300×26 bar strip is not reviewable at its own size — that is the whole reason the live bar
   * capture magnifies by four — and the panel is 388 wide on a stage with twelve hundred to give it.
   */
  function defaultZoom(el) {
    if (el.naturalHeight > 0 && el.naturalHeight <= 60) return 4;
    if (el.naturalWidth > 0 && el.naturalWidth <= 400) return 2;
    return 1;
  }

  function applyZoom() {
    if (!img.naturalWidth) return;
    var s = WALK[at];
    var z = zoom[s.id] || (zoom[s.id] = defaultZoom(img));
    img.style.width = img.naturalWidth * z + "px";
    img.classList.toggle("px", z > 1);
    document.getElementById("fx-zoom").textContent = z + "×";
  }

  function nudgeZoom(by) {
    if (!dlg.open || at >= WALK.length || !img.naturalWidth) return;
    var s = WALK[at];
    var z = Math.min(8, Math.max(1, (zoom[s.id] || defaultZoom(img)) + by));
    zoom[s.id] = z;
    applyZoom();
  }

  function show(i) {
    at = i;
    var end = i >= WALK.length;
    live.hidden = end;
    done.hidden = !end;
    // Nothing is on screen to zoom or to approve at the end, so the controls for both stand down.
    document.getElementById("fx-tools").hidden = end;
    document.getElementById("fx-chapter").hidden = end;
    document.getElementById("fx-pos").hidden = end;
    document.getElementById("fx-age").hidden = end;
    if (end) {
      var noted = WALK.filter(function (s) { return statusOf(s.id) === "noted"; }).length;
      document.getElementById("fx-done-line").textContent =
        noted === 0
          ? "No notes. Every surface you marked is on the record; the ones you did not are still waiting."
          : noted + (noted === 1 ? " surface has notes" : " surfaces have notes") +
            " — copy them out and hand them back.";
      paintTrack();
      return;
    }
    var s = WALK[i];
    document.getElementById("fx-chapter").textContent = s.chapter;
    document.getElementById("fx-pos").textContent = i + 1 + " / " + WALK.length;
    var fxAge = document.getElementById("fx-age");
    fxAge.hidden = s.shotAt === 0;
    fxAge.textContent = s.shotAt ? ago(Date.now() - s.shotAt) : "";
    fxAge.classList.toggle("old", isOld(s));
    document.getElementById("fx-title").textContent = s.title;
    document.getElementById("fx-looking").textContent = s.looking;
    document.getElementById("fx-prev").disabled = i === 0;
    stage.setAttribute("data-id", s.id);
    document.getElementById("fx-notes").setAttribute("data-for", s.id);
    img.alt = s.title;
    if (img.getAttribute("src") !== s.file) {
      img.style.width = "";
      img.setAttribute("src", s.file);
    } else {
      applyZoom();
    }
    document.getElementById("fx-ok").setAttribute("aria-pressed", state.ok[s.id] ? "true" : "false");
    render(s.id);
    paintTrack();
  }

  function open(i) {
    if (!dlg.open) dlg.showModal();
    show(i);
  }

  img.addEventListener("load", applyZoom);
  document.getElementById("fx-next").addEventListener("click", function () { show(Math.min(WALK.length, at + 1)); });
  document.getElementById("fx-prev").addEventListener("click", function () { show(Math.max(0, at - 1)); });
  document.getElementById("fx-close").addEventListener("click", function () { dlg.close(); });
  document.getElementById("fx-done-close").addEventListener("click", function () { dlg.close(); });
  document.getElementById("fx-done-again").addEventListener("click", function () { show(0); });
  document.getElementById("fx-zoom-in").addEventListener("click", function () { nudgeZoom(1); });
  document.getElementById("fx-zoom-out").addEventListener("click", function () { nudgeZoom(-1); });
  document.getElementById("fx-ok").addEventListener("click", function () { toggleOk(WALK[at].id); });
  dlg.addEventListener("close", paintTrack);

  function toggleOk(id) {
    state.ok[id] = !state.ok[id];
    save();
    document.querySelectorAll('[data-ok="' + id + '"]').forEach(function (b) {
      b.setAttribute("aria-pressed", state.ok[id] ? "true" : "false");
    });
    if (dlg.open && at < WALK.length && WALK[at].id === id) {
      document.getElementById("fx-ok").setAttribute("aria-pressed", state.ok[id] ? "true" : "false");
    }
    refresh();
  }

  /** The first surface nobody has looked at, so "walk through" resumes rather than restarts. */
  function firstUnseen() {
    for (var i = 0; i < WALK.length; i++) if (statusOf(WALK[i].id) === "none") return i;
    return 0;
  }

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────

  // Delegated, because the focus view swaps which surface its shot belongs to rather than rebuilding
  // it, and a listener bound to an element cannot follow that.
  document.addEventListener("click", function (ev) {
    var openTarget = ev.target.closest("[data-open]");
    if (openTarget) {
      ev.preventDefault();
      var s = byId[openTarget.getAttribute("data-open")];
      if (s) open(s.idx);
      return;
    }
    var okTarget = ev.target.closest("[data-ok]");
    if (okTarget) { toggleOk(okTarget.getAttribute("data-ok")); return; }

    var shot = ev.target.closest(".shot");
    if (!shot || ev.target.classList.contains("pin")) return;
    var id = shot.getAttribute("data-id");
    if (!id) return;
    var r = shot.getBoundingClientRect();
    addNote(id, ((ev.clientX - r.left) / r.width) * 100, ((ev.clientY - r.top) / r.height) * 100);
  });

  function addNote(id, x, y) {
    notesOf(id).push({ x: x, y: y, text: "", done: false });
    save(); render(id); refresh();
    var boxes = document.querySelectorAll('ol.notes[data-for="' + id + '"] textarea');
    if (boxes.length) boxes[boxes.length - 1].focus();
  }

  document.getElementById("walk").addEventListener("click", function () { open(firstUnseen()); });

  document.getElementById("expand").addEventListener("click", function (ev) {
    var opening = ev.target.textContent === "Expand all";
    document.querySelectorAll(".chapter").forEach(function (ch) {
      ch.open = opening;
      state.open[ch.getAttribute("data-chapter")] = opening;
    });
    ev.target.textContent = opening ? "Collapse all" : "Expand all";
    save();
  });

  // Which chapters a person folded open is remembered from the click on the summary rather than
  // from the details' own toggle event. That event fires asynchronously, and also fires when a filter
  // opens a chapter on someone's behalf, which would quietly overwrite the preference with the
  // filter's — and then "Everything" would have nothing to restore.
  document.querySelectorAll(".chapter").forEach(function (ch) {
    var name = ch.getAttribute("data-chapter");
    if (state.open[name]) ch.open = true;
    ch.querySelector("summary").addEventListener("click", function (ev) {
      if (ev.target.closest("[data-open]")) return; // a thumbnail, not the fold
      state.open[name] = !ch.open; // the click runs before the fold, so this is the state it lands in
      save();
    });
  });

  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var filter = chip.getAttribute("data-filter");
      document.body.setAttribute("data-filter", filter);
      document.querySelectorAll(".chip").forEach(function (other) {
        other.setAttribute("aria-pressed", other === chip ? "true" : "false");
      });
      // Filtering to a subset and then leaving it behind a closed chapter helps nobody. Going back
      // to everything hands the folds back to whoever set them.
      document.querySelectorAll(".chapter").forEach(function (ch) {
        ch.open = filter === "all" ? !!state.open[ch.getAttribute("data-chapter")] : true;
      });
      refresh();
    });
  });

  document.getElementById("copy").addEventListener("click", copyOut);
  document.getElementById("fx-done-copy").addEventListener("click", copyOut);

  function copyOut() {
    var out = ["# Anchor review", ""];
    var seen = 0, fine = [];
    var chapter = "";
    WALK.forEach(function (s) {
      var st = statusOf(s.id);
      if (st !== "none") seen++;
      if (st === "ok") fine.push(s.title);
      var items = (state.notes[s.id] || []).filter(function (i) { return (i.text || "").trim() !== ""; });
      if (!items.length) return;
      if (s.chapter !== chapter) { chapter = s.chapter; out.push("## " + chapter, ""); }
      out.push("### " + s.title, "");
      items.forEach(function (item, i) {
        out.push(
          i + 1 + ". " + (item.done ? "[handled] " : "") + item.text.trim() +
          "  _(at " + item.x.toFixed(0) + "%, " + item.y.toFixed(0) + "% of the shot)_"
        );
      });
      out.push("");
    });
    out.splice(1, 0, seen + " of " + WALK.length + " surfaces looked at.");
    if (fine.length) {
      out.push("## Looked at, nothing to change", "");
      fine.forEach(function (t) { out.push("- " + t); });
      out.push("");
    }
    var text = out.join("\\n");
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    var sheet = document.getElementById("out");
    sheet.querySelector("textarea").value = text;
    sheet.showModal();
    sheet.querySelector("textarea").select();
  }

  document.getElementById("clear").addEventListener("click", function () {
    if (!confirm("Delete every note and every mark in this review?")) return;
    state.notes = {};
    state.ok = {};
    save();
    WALK.forEach(function (s) { render(s.id); });
    document.querySelectorAll("[data-ok]").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
    refresh();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var typing = /^(TEXTAREA|INPUT)$/.test(ev.target.tagName);
    if (typing) return;
    if (!dlg.open) {
      if (ev.key === "w" || ev.key === "W") { ev.preventDefault(); open(firstUnseen()); }
      return;
    }
    if (ev.key === "ArrowRight" || ev.key === "j") { ev.preventDefault(); show(Math.min(WALK.length, at + 1)); }
    else if (ev.key === "ArrowLeft" || ev.key === "k") { ev.preventDefault(); show(Math.max(0, at - 1)); }
    else if (ev.key === "g" || ev.key === "G") { if (at < WALK.length) toggleOk(WALK[at].id); }
    else if (ev.key === "n" || ev.key === "N") { if (at < WALK.length) addNote(WALK[at].id, 50, 50); }
    else if (ev.key === "+" || ev.key === "=") nudgeZoom(1);
    else if (ev.key === "-") nudgeZoom(-1);
  });

  // Which shots are bar strips is declared by the capture. How to fit one in a tile is not: the
  // live bar shot arrives already magnified fourfold, so it is scaled down to fit, while a strip
  // still at its native size is shown at 1:1 and cropped to its middle, where its content sits.
  document.querySelectorAll(".thumb img").forEach(function (el) {
    var shape = function () {
      if (!el.naturalWidth) return;
      var tile = el.parentElement;
      if (tile.classList.contains("bar")) {
        if (el.naturalWidth <= 600) tile.classList.add("crop");
      } else if (el.naturalWidth / el.naturalHeight > 132 / 86) {
        tile.classList.add("short");
      }
    };
    if (el.complete) shape(); else el.addEventListener("load", shape);
  });

  // A 300×26 strip on a card that already has the whole row to itself is still 300×26. Blow it up
  // threefold, which is what the live bar capture does to its own shot for the same reason.
  document.querySelectorAll(".card .shot img").forEach(function (el) {
    var grow = function () {
      if (!el.naturalHeight || el.naturalHeight > 60) return;
      el.style.width = el.naturalWidth * 3 + "px";
      el.classList.add("px");
    };
    if (el.complete) grow(); else el.addEventListener("load", grow);
  });

  WALK.forEach(function (s) { render(s.id); });
  document.querySelectorAll("[data-ok]").forEach(function (b) {
    b.setAttribute("aria-pressed", state.ok[b.getAttribute("data-ok")] ? "true" : "false");
  });
  paintAges();
  refresh();
})();
</script>
</body>
</html>`;
}
