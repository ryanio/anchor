#!/usr/bin/env node
/**
 * Capture every surface Anchor renders, and build a page for marking them up.
 *
 *   node scripts/review.ts              capture everything available
 *   node scripts/review.ts widget site  capture only those groups
 *   node scripts/review.ts --list       show what would be captured
 *
 * Output lands in `review/` (gitignored): the PNGs, plus `review/index.html`, which lets a human
 * click anywhere on a shot to drop a numbered pin and write what should change. Notes live in
 * `localStorage`, so closing the tab does not lose them, and "Copy all notes" puts the whole review
 * on the clipboard as markdown to paste back to an agent.
 *
 * ## Why this exists
 *
 * Design bugs in this project have a habit of being invisible in the source and obvious on screen.
 * A cheat sheet was fixed three times from CSS arithmetic before anyone rendered it. An icon was
 * "aligned" by matching top edges when the real problem was that its artwork is 32×45, so its aspect
 * ratio made it the tallest thing in a row of square glyphs at every size. Neither was catchable by
 * reading code, and both were obvious in a screenshot next to their neighbours.
 *
 * So: capture is cheap, looking is the expensive part, and this makes looking a single command.
 *
 * ## What it needs
 *
 * `grim` for anything on the Wayland session, `chromium` for anything with a URL or a file path, and
 * `omarchy-shell` to open the widget panel. Each surface is skipped with a reason rather than
 * failing the run, so this still does something useful over SSH or in CI.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "review");

/** A surface worth looking at. `capture` returns the PNG path, or throws with a reason to skip. */
interface Surface {
  id: string;
  group: string;
  title: string;
  /** What a reviewer should be looking for. Shown beside the shot. */
  looking: string;
  capture: (file: string) => Promise<void>;
}

// ── tools ───────────────────────────────────────────────────────────────────────────────────────

function have(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const onWayland = process.env.WAYLAND_DISPLAY !== undefined && have("grim");

/**
 * True when the desktop is actually on screen.
 *
 * Three different states produce a useless capture: the display is off (Omarchy zeroes its
 * brightness when the lock fires), the screensaver is up, or the session is locked. None of them is
 * reliably reportable here — Omarchy's lock is drawn by the shell itself, so there is no `hyprlock`
 * process to find, `loginctl` reports `LockedHint=no` throughout, and the idle plugin's
 * `processes.lock` is already false by the time the lock is still on screen.
 *
 * So this checks the pixels instead, using the one thing that is always true of an unlocked
 * Omarchy session: **the bar is there**, and a bar is high-contrast — bright glyphs on a dark
 * ground. A strip along the top edge is sampled and its contrast measured. Valid while the bar is
 * opaque, which is the default (`bar.transparent` in shell.json).
 *
 * This matters beyond a wasted run. During development a capture wrote someone's password prompt to
 * disk, twice, and it looked like a perfectly good screenshot.
 */
async function desktopVisible(): Promise<boolean> {
  if (!have("magick")) return true; // cannot tell; the blankness check below still applies
  const probe = join(OUT, ".probe.png");
  try {
    await run("grim", ["-g", "0,0 400x6", probe]);
    const { stdout } = await run("magick", [
      probe,
      "-colorspace",
      "Gray",
      "-format",
      "%[fx:(maxima-mean)*255]",
      "info:",
    ]);
    // Contrast, not brightness. The bar is bright glyphs on a dark ground, so the spread between
    // its brightest pixel and its mean is large; a wallpaper is a smooth gradient, so the spread is
    // tiny. Measured on this machine: 109 for the real bar, 1.7 for the lock screen.
    //
    // Two earlier versions of this check tested brightness and both let a lock screen through — a
    // lock screen is bright, and its top edge happened to sit within a hair of the threshold. The
    // cost of getting it wrong is writing someone's password prompt to disk, which happened twice.
    return Number(stdout.trim()) > 30;
  } catch {
    return true;
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * Grab a region of the live screen. Geometry is `x,y WxH`, grim's own format.
 *
 * Refuses a blank frame rather than writing one. Omarchy turns the display off by zeroing its
 * brightness when the lock fires, and `grim` cheerfully captures that as a perfectly valid all-black
 * PNG — so an unattended run produces six black rectangles and a review page that looks finished.
 * A screenshot tool that cannot tell "nothing there" from "nothing rendered" is worse than one that
 * fails, because someone will review the black images and conclude the UI is broken.
 */
async function grim(geometry: string, file: string): Promise<void> {
  if (!onWayland) throw new Error("no Wayland session (needs grim and WAYLAND_DISPLAY)");
  if (!(await desktopVisible())) {
    throw new Error(
      "the desktop is not on screen — it is locked, showing the screensaver, or the display is off",
    );
  }
  await run("grim", ["-g", geometry, file]);
  if (!have("magick")) return;
  const { stdout } = await run("magick", [file, "-colorspace", "Gray", "-format", "%[fx:mean*255]", "info:"]);
  if (Number(stdout.trim()) < 1) {
    rmSync(file, { force: true });
    throw new Error(
      "the display is off, so the capture was blank — wake it with `omarchy-brightness-display on`",
    );
  }
}

/**
 * Render a page headlessly.
 *
 * `--force-dark-mode` because every page here is designed dark-first and that is what the desktop
 * shows; the light variants are checked by scripts/check-contrast.ts rather than by eye.
 */
async function shot(url: string, file: string, width = 1280, height = 900): Promise<void> {
  const chromium = ["chromium", "chromium-browser", "google-chrome-stable"].find(have);
  if (chromium === undefined) throw new Error("chromium not installed");
  await run(chromium, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-dark-mode",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=4000",
    `--screenshot=${file}`,
    url,
  ]);
}

/**
 * Blow a capture up with nearest-neighbour, for shots that are too small to review at page scale.
 *
 * The bar strip is 260×30. At that size a reviewer cannot see what they are being asked about, and
 * smoothing would invent detail that is not in the pixels — point sampling keeps every edge exactly
 * where the compositor put it.
 */
async function magnify(file: string, factor: number): Promise<void> {
  if (!have("magick")) return; // reviewable, just small
  await run("magick", [file, "-filter", "point", "-resize", `${factor * 100}%`, file]);
}

/**
 * Crop to whatever actually changed between two captures.
 *
 * A panel is a layer-shell surface, so it cannot be captured by window and its geometry is not
 * exposed. Diffing the screen before and after opening it finds its bounds exactly, which beats a
 * hardcoded region that is mostly wallpaper and breaks on a different monitor.
 */
async function cropToDiff(before: string, after: string, out: string, pad = 12): Promise<boolean> {
  if (!have("magick")) return false;
  try {
    const { stdout } = await run("magick", [
      before,
      after,
      "-compose",
      "difference",
      "-composite",
      "-colorspace",
      "Gray",
      "-threshold",
      "8%",
      "-format",
      "%@",
      "info:",
    ]);
    const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(stdout.trim());
    if (m === null) return false;
    const [w, h, x, y] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (w < 40 || h < 40) return false; // nothing meaningful changed
    const geom = `${w + pad * 2}x${h + pad * 2}+${Math.max(0, x - pad)}+${Math.max(0, y - pad)}`;
    await run("magick", [after, "-crop", geom, "+repage", out]);
    return true;
  } catch {
    return false;
  }
}

/** Width of the primary monitor, so bar captures do not hardcode one machine's resolution. */
async function screenWidth(): Promise<number> {
  const { stdout } = await run("hyprctl", ["monitors", "-j"]);
  const first = (JSON.parse(stdout) as Array<{ width: number }>)[0];
  if (first === undefined) throw new Error("no monitor reported by hyprctl");
  return first.width;
}

/**
 * Open the widget panel, capture it, close it again.
 *
 * Captures the closed state first, opens the panel, captures again, and crops to whatever changed.
 * A layer-shell surface cannot be captured by window and does not expose its geometry, so diffing is
 * the only way to get a tight crop rather than a screenful of wallpaper.
 *
 * Always toggles back, even on failure — leaving someone's desktop with a panel stuck open is rude.
 */
async function panelShot(file: string): Promise<void> {
  if (!have("omarchy-shell")) throw new Error("omarchy-shell not on PATH");
  const width = await screenWidth();
  const region = `${Math.max(0, width - 1200)},0 1200x700`;
  const closed = `${file}.closed.png`;

  await grim(region, closed);
  await run("omarchy-shell", ["anchor.pulse", "toggle"]);
  try {
    await new Promise((r) => setTimeout(r, 1200));
    await grim(region, file);
  } finally {
    await run("omarchy-shell", ["anchor.pulse", "toggle"]).catch(() => undefined);
  }
  await cropToDiff(closed, file, file);
  rmSync(closed, { force: true });
}

// ── the surfaces ────────────────────────────────────────────────────────────────────────────────

const SURFACES: Surface[] = [
  {
    id: "bar",
    group: "widget",
    title: "Bar — the mark among its neighbours",
    looking:
      "The mark has to sit in a row of other people's icons. Compare drawn height, width and weight " +
      "against its neighbours, not against itself. Aspect ratio is the usual culprit: shrinking an " +
      "icon cannot fix a shape that is taller than it is wide.",
    capture: async (file) => {
      const width = await screenWidth();
      await grim(`${width - 260},0 260x30`, file);
      await magnify(file, 4);
    },
  },
  {
    id: "panel",
    group: "widget",
    title: "Panel — the whole surface",
    looking:
      "Is there one obvious thing to do? Does anything read as decoration? Check the vertical rhythm " +
      "between blocks, and whether prose is set in a face meant for prose.",
    capture: panelShot,
  },
  {
    id: "site-home",
    group: "site",
    title: "anchor.ryanio.com — home",
    looking: "First impression, hierarchy, and whether the diary countdown reads as calm or urgent.",
    capture: (file) => shot("https://anchor.ryanio.com", file, 1280, 1000),
  },
  {
    id: "site-diary",
    group: "site",
    title: "The diary entry",
    looking: "Measure, paragraph rhythm, and whether the pull quotes earn their space.",
    capture: (file) => shot("https://anchor.ryanio.com/diary/001-day-one.html", file, 1280, 1400),
  },
  {
    id: "docs-index",
    group: "docs",
    title: "~/Documents/Index.html",
    looking: "Tile grid, the wash behind the header, and whether Elsewhere reads as separate.",
    capture: (file) => shot(`file://${process.env.HOME}/Documents/Index.html`, file, 1100, 780),
  },
  {
    id: "docs-field-notes",
    group: "docs",
    title: "Field notes",
    looking: "Long-form readability, the sticky contents column, and the status pills.",
    capture: (file) =>
      shot(`file://${process.env.HOME}/Documents/omarchy-field-notes.html`, file, 1400, 1100),
  },
];

// ── page ────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(shots: Array<{ surface: Surface; file: string | null; reason?: string }>): string {
  const captured = shots.filter((s) => s.file !== null);
  const cards = shots
    .map(({ surface, file, reason }) => {
      const body =
        file === null
          ? `<p class="skipped">Not captured — ${esc(reason ?? "unknown reason")}</p>`
          : `<div class="shot" data-id="${esc(surface.id)}">
        <img src="${esc(file)}" alt="${esc(surface.title)}">
        <div class="pins"></div>
      </div>`;
      return `<section class="card" id="s-${esc(surface.id)}">
  <header>
    <h2>${esc(surface.title)}</h2>
    <span class="group">${esc(surface.group)}</span>
  </header>
  <p class="looking">${esc(surface.looking)}</p>
  ${body}
  <ol class="notes" data-for="${esc(surface.id)}"></ol>
</section>`;
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
    --bg: #06131a; --surface: #0a1c25; --sunk: #102b37;
    --text: #e8f2f4; --muted: #93a8ad; --border: #14313d;
    --accent: #5fd4e4; --accent-rgb: 95 212 228; --ember: #ff8a6b;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 32px clamp(16px, 4vw, 40px) 120px;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -.02em; }
  .lede { margin: 0 0 28px; color: var(--muted); max-width: 68ch; }
  .lede kbd {
    font: 12px ui-monospace, Menlo, monospace; background: var(--sunk);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 18px; margin-bottom: 22px;
  }
  .card header { display: flex; align-items: baseline; gap: 12px; }
  h2 { margin: 0; font-size: 17px; font-weight: 600; }
  .group {
    font: 10.5px ui-monospace, Menlo, monospace; letter-spacing: .1em;
    text-transform: uppercase; color: var(--accent);
    border: 1px solid rgb(var(--accent-rgb) / .35); border-radius: 999px; padding: 2px 8px;
  }
  .looking { margin: 8px 0 14px; color: var(--muted); font-size: 13.5px; max-width: 78ch; }
  .skipped { color: var(--ember); font-size: 13.5px; margin: 0; }
  .shot { position: relative; display: inline-block; max-width: 100%; cursor: crosshair; }
  .shot img {
    display: block; max-width: 100%; height: auto;
    border: 1px solid var(--border); border-radius: 8px; background: #000;
  }
  .pins { position: absolute; inset: 0; pointer-events: none; }
  .pin {
    position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
    border-radius: 999px; background: var(--ember); color: #1a0d08;
    font: 600 12px/22px ui-sans-serif, system-ui, sans-serif; text-align: center;
    box-shadow: 0 0 0 2px rgb(0 0 0 / .45); pointer-events: auto; cursor: pointer;
  }
  .pin.done { background: var(--accent); color: #04222a; }
  ol.notes { margin: 14px 0 0; padding-left: 0; list-style: none; display: grid; gap: 8px; }
  ol.notes:empty { margin: 0; }
  .note { display: flex; gap: 10px; align-items: flex-start; background: var(--sunk);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
  .note .n {
    flex: none; width: 20px; height: 20px; border-radius: 999px; background: var(--ember);
    color: #1a0d08; font: 600 11px/20px ui-sans-serif, system-ui, sans-serif; text-align: center;
  }
  .note.done .n { background: var(--accent); color: #04222a; }
  .note textarea {
    flex: 1; background: transparent; border: 0; color: var(--text); resize: vertical;
    font: inherit; min-height: 22px; padding: 0; outline: none;
  }
  .note button {
    flex: none; background: transparent; border: 1px solid var(--border); color: var(--muted);
    border-radius: 6px; font-size: 11px; padding: 2px 7px; cursor: pointer;
  }
  .note button:hover { color: var(--text); border-color: var(--accent); }
  .bar {
    position: fixed; left: 0; right: 0; bottom: 0; background: rgb(6 19 26 / .93);
    border-top: 1px solid var(--border); padding: 12px clamp(16px, 4vw, 40px);
    display: flex; gap: 12px; align-items: center; backdrop-filter: blur(10px);
  }
  .bar .count { color: var(--muted); font-size: 13px; margin-right: auto; }
  .bar button {
    background: rgb(var(--accent-rgb) / .12); border: 1px solid rgb(var(--accent-rgb) / .4);
    color: var(--accent); border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13.5px;
    cursor: pointer;
  }
  .bar button:hover { background: rgb(var(--accent-rgb) / .2); }
  .bar button.ghost { background: transparent; border-color: var(--border); color: var(--muted); }
  dialog {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 12px; max-width: min(860px, 92vw); width: 100%; padding: 18px;
  }
  dialog::backdrop { background: rgb(0 0 0 / .6); }
  dialog textarea {
    width: 100%; min-height: 46vh; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    font: 12.5px/1.5 ui-monospace, Menlo, monospace; resize: vertical;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Anchor — review</h1>
  <p class="lede">
    Click anywhere on a screenshot to drop a pin and say what should change. Notes save as you type.
    <kbd>Copy all notes</kbd> puts the whole review on the clipboard as markdown — paste it back to
    an agent. Click a pin to mark it handled; click its number in the list to delete it.
  </p>
  ${cards}
</div>

<div class="bar">
  <span class="count" id="count"></span>
  <button class="ghost" id="clear">Clear all</button>
  <button id="copy">Copy all notes</button>
</div>

<dialog id="out"><textarea readonly></textarea>
  <div style="margin-top:10px;display:flex;gap:10px;justify-content:flex-end">
    <button class="ghost" onclick="this.closest('dialog').close()">Close</button>
  </div>
</dialog>

<script>
(function () {
  var KEY = "anchor-review-v1";
  var state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { state = {}; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private window */ }
    var n = 0;
    for (var k in state) n += state[k].length;
    document.getElementById("count").textContent =
      n === 0 ? "No notes yet" : n + (n === 1 ? " note" : " notes");
  }

  function render(id) {
    var shot = document.querySelector('.shot[data-id="' + id + '"]');
    var list = document.querySelector('ol.notes[data-for="' + id + '"]');
    var items = state[id] || [];
    if (shot) shot.querySelector(".pins").innerHTML = "";
    list.innerHTML = "";

    items.forEach(function (item, i) {
      if (shot) {
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
        shot.querySelector(".pins").appendChild(pin);
      }

      var li = document.createElement("li");
      li.className = "note" + (item.done ? " done" : "");
      var num = document.createElement("span");
      num.className = "n";
      num.textContent = String(i + 1);
      var ta = document.createElement("textarea");
      ta.value = item.text || "";
      ta.placeholder = "What should change here?";
      ta.rows = 1;
      ta.addEventListener("input", function () {
        item.text = ta.value;
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
        save();
      });
      var del = document.createElement("button");
      del.textContent = "Remove";
      del.addEventListener("click", function () {
        items.splice(i, 1);
        save(); render(id);
      });
      li.appendChild(num); li.appendChild(ta); li.appendChild(del);
      list.appendChild(li);
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
  }

  document.querySelectorAll(".shot").forEach(function (shot) {
    var id = shot.getAttribute("data-id");
    shot.addEventListener("click", function (ev) {
      if (ev.target.classList.contains("pin")) return;
      var r = shot.getBoundingClientRect();
      state[id] = state[id] || [];
      state[id].push({
        x: ((ev.clientX - r.left) / r.width) * 100,
        y: ((ev.clientY - r.top) / r.height) * 100,
        text: "",
        done: false,
      });
      save(); render(id);
      var boxes = document.querySelectorAll('ol.notes[data-for="' + id + '"] textarea');
      if (boxes.length) boxes[boxes.length - 1].focus();
    });
  });

  document.getElementById("copy").addEventListener("click", function () {
    var out = ["# Anchor review", ""];
    document.querySelectorAll(".card").forEach(function (card) {
      var id = card.id.replace(/^s-/, "");
      var items = (state[id] || []).filter(function (i) { return (i.text || "").trim() !== ""; });
      if (!items.length) return;
      out.push("## " + card.querySelector("h2").textContent.trim(), "");
      items.forEach(function (item, i) {
        out.push(
          (i + 1) + ". " + (item.done ? "[handled] " : "") + item.text.trim() +
          "  _(at " + item.x.toFixed(0) + "%, " + item.y.toFixed(0) + "% of the shot)_"
        );
      });
      out.push("");
    });
    var text = out.length > 2 ? out.join("\\n") : "# Anchor review\\n\\nNo notes.";
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    var dlg = document.getElementById("out");
    dlg.querySelector("textarea").value = text;
    dlg.showModal();
    dlg.querySelector("textarea").select();
  });

  document.getElementById("clear").addEventListener("click", function () {
    if (!confirm("Delete every note in this review?")) return;
    state = {}; save();
    document.querySelectorAll(".shot").forEach(function (s) { render(s.getAttribute("data-id")); });
  });

  document.querySelectorAll(".card").forEach(function (c) { render(c.id.replace(/^s-/, "")); });
  save();
})();
</script>
</body>
</html>
`;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const s of SURFACES) console.log(`${s.group.padEnd(8)} ${s.id.padEnd(18)} ${s.title}`);
  process.exit(0);
}

const groups = args.filter((a) => !a.startsWith("--"));
const wanted = SURFACES.filter(
  (s) => groups.length === 0 || groups.includes(s.group) || groups.includes(s.id),
);
if (wanted.length === 0) {
  console.error(`Nothing matches ${groups.join(", ")}. Try --list.`);
  process.exit(1);
}

if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true });
mkdirSync(OUT, { recursive: true });

const results: Array<{ surface: Surface; file: string | null; reason?: string }> = [];
for (const surface of wanted) {
  const name = `${surface.id}.png`;
  try {
    await surface.capture(join(OUT, name));
    if (!existsSync(join(OUT, name))) throw new Error("the tool reported success but wrote no file");
    results.push({ surface, file: name });
    console.log(`  captured  ${surface.id}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    results.push({ surface, file: null, reason });
    console.log(`  skipped   ${surface.id} — ${reason}`);
  }
}

writeFileSync(join(OUT, "index.html"), page(results));
const ok = results.filter((r) => r.file !== null).length;
console.log(`\n${ok}/${results.length} captured. Open: file://${join(OUT, "index.html")}`);
