#!/usr/bin/env node
/**
 * Capture every surface Anchor renders, and build a page for marking them up.
 *
 *   node scripts/review.ts              capture everything available
 *   node scripts/review.ts widget site  capture only those groups
 *   node scripts/review.ts --list       show what would be captured
 *   node scripts/review.ts --page-only  rebuild the page over the shots already on disk
 *
 * Output lands in `review/` (gitignored): the PNGs, plus `review/index.html`, which walks a person
 * through every state in chapters and lets them click anywhere on a shot to drop a numbered pin and
 * write what should change. Notes live in `localStorage`, so closing the tab does not lose them, and
 * "Copy notes" puts the whole review on the clipboard as markdown to paste back to an agent. The
 * page itself is built by `review-page.ts`, and `--page-only` rebuilds it without photographing
 * anything — capture wipes `review/` and needs a live session, which is a lot to spend on a change
 * to a stylesheet.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { capturePanelStates, panelCases } from "./panel-states.ts";
import { page, type SurfaceMeta } from "./review-page.ts";
import { fileFor, shotsFor } from "./review-shots.ts";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "review");
const SRC = join(ROOT, "widget");

/** A surface worth looking at. `capture` writes the PNG, or throws with a reason to skip it. */
interface Surface extends SurfaceMeta {
  /** Where the shot lands under `review/`, when it is not `<id>.png`. */
  fileName?: string;
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

type Rect = { x: number; y: number; w: number; h: number };
type Layer = Rect & { namespace: string };

/** A rectangle in grim's geometry format. */
function geom(r: Rect): string {
  return `${r.x},${r.y} ${r.w}x${r.h}`;
}

/**
 * Where the Omarchy bar actually is, according to the compositor.
 *
 * Worth asking rather than assuming, because assuming has broken this file twice: a probe hardcoded
 * to the top six rows of the screen read the padding above the glyphs and declared the desktop
 * locked, and the bar capture hardcoded a 30px height on a 26px bar and took four pixels of whatever
 * window sat underneath. The bar is a layer-shell surface, so it has no geometry a client can read —
 * but `hyprctl` knows, and it is already a dependency here.
 *
 * Returns `null` when there is no compositor to ask, which callers treat as "fall back", not as
 * "no bar".
 */
async function barGeometry(): Promise<Rect | null> {
  if (!have("hyprctl")) return null;
  try {
    const { stdout } = await run("hyprctl", ["layers", "-j"]);
    const outputs = JSON.parse(stdout) as Record<string, { levels: Record<string, Layer[]> }>;
    for (const output of Object.values(outputs)) {
      for (const level of Object.values(output.levels)) {
        const bar = level.find((l) => l.namespace === "omarchy-bar" && l.w > 0 && l.h > 0);
        if (bar !== undefined) return { x: bar.x, y: bar.y, w: bar.w, h: bar.h };
      }
    }
  } catch {
    // A compositor that will not answer is not evidence either way.
  }
  return null;
}

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
  const bar = await barGeometry();
  try {
    // The bar's own rectangle, or a strip deep enough to contain one if the compositor will not say.
    await run("grim", ["-g", bar === null ? "0,0 400x40" : geom(bar), probe]);
    const { stdout } = await run("magick", [
      probe,
      "-colorspace",
      "Gray",
      "-format",
      "%[fx:(maxima-mean)*255]",
      "info:",
    ]);
    // Contrast, not brightness. The bar is bright glyphs on a dark ground, so the spread between
    // its brightest pixel and its mean is large; a lock screen is a smooth gradient, so the spread
    // is tiny. Measured on this machine: 148 across the real bar, 1.7 for the lock screen.
    //
    // Measure the bar itself, not a corner of the screen. The first version of this probed
    // `0,0 400x6`, and on a 26px bar those six rows are the padding *above* the glyphs — flat
    // background, spread 0. It reported an ordinary unlocked desktop as locked, which is the
    // failure that costs you nothing to fix and a whole session to notice.
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
 * exposed. Hyprland does not help either: with the panel open the only new layer it reports is a
 * full-screen `omarchy-keyboard-panel`, which is the input catcher, not the panel. So the bounds
 * come from diffing the screen before and after opening it, which beats a hardcoded region that is
 * mostly wallpaper and breaks on a different monitor.
 *
 * The difference is split into connected regions rather than reduced to one bounding box, because
 * the panel is not the only thing on screen that moves. A capture taken while a terminal was
 * printing produced a "panel" shot four times too big with the panel in one corner — the union of
 * the panel and some scrolling text. The panel is a single solid region and text is a scattering of
 * small ones, so the largest region is the panel.
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
      // Close hairline gaps so a panel's border and its interior count as one region rather than a
      // ring around a hole.
      "-morphology",
      "Close",
      "Octagon:3",
      "-define",
      "connected-components:verbose=true",
      "-define",
      "connected-components:area-threshold=2000",
      "-connected-components",
      "8",
      "null:",
    ]);

    // `  2: 360x249+809+31  929.9,155.7  9709  gray(255)` — id, bounds, centroid, area, colour.
    // gray(255) is changed, gray(0) unchanged; ignore the latter and the full-frame background.
    const regions = stdout
      .split("\n")
      .map((line) => /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+\S+\s+(\d+)\s+gray\(255\)/.exec(line))
      .filter((m) => m !== null)
      .map((m) => ({
        w: Number(m[1]),
        h: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
        area: Number(m[5]),
      }))
      .sort((a, b) => b.area - a.area);

    const biggest = regions[0];
    if (biggest === undefined) return false;
    const [w, h, x, y] = [biggest.w, biggest.h, biggest.x, biggest.y];
    if (w < 40 || h < 40) return false; // nothing meaningful changed
    const box = `${w + pad * 2}x${h + pad * 2}+${Math.max(0, x - pad)}+${Math.max(0, y - pad)}`;
    await run("magick", [after, "-crop", box, "+repage", out]);
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
 * Render every panel state, once per run.
 *
 * Fifteen surfaces come out of one Quickshell launch, so the first of them to be captured does the
 * work and the rest wait on the same promise. A failure is remembered too — otherwise fourteen
 * surfaces each retry a launch that has already been shown not to work.
 */
let panelStates: Promise<string[]> | null = null;
function ensurePanelStates(): Promise<void> {
  panelStates ??= capturePanelStates();
  return panelStates.then(() => undefined);
}

// ── the surfaces ────────────────────────────────────────────────────────────────────────────────

const SURFACES: Surface[] = [
  {
    id: "bar",
    group: "widget",
    category: "The bar, live",
    strip: true,
    title: "Bar — the mark among its neighbours",
    looking:
      "The mark has to sit in a row of other people's icons. Compare drawn height, width and weight " +
      "against its neighbours, not against itself. Aspect ratio is the usual culprit: shrinking an " +
      "icon cannot fix a shape that is taller than it is wide.",
    capture: async (file) => {
      // The right-hand end of the bar, at the bar's own height. A hardcoded height is wrong on
      // every bar but this machine's, and wrong here too — 30 against 26 took four pixels of
      // whichever window happened to sit underneath, which then read as part of the design.
      const bar = (await barGeometry()) ?? { x: 0, y: 0, w: await screenWidth(), h: 30 };
      // Wide enough for the mark to still be in frame once the widget has content. At 260 it fit
      // exactly, until the service started resolving a wallet and the item grew a dollar figure —
      // and a review shot of the mark that has cropped the mark is worse than no shot.
      const w = Math.min(360, bar.w);
      await grim(geom({ x: bar.x + bar.w - w, y: bar.y, w, h: bar.h }), file);
      await magnify(file, 4);
    },
  },
  ...panelCases().map(
    (state): Surface => ({
      id: state.id,
      group: "panel",
      title: state.title,
      looking: state.looking,
      fileName: state.file,
      category: state.category,
      strip: state.strip,
      capture: ensurePanelStates,
    }),
  ),
];

/**
 * Warn when the bar is running a different widget than the one in this checkout.
 *
 * Quickshell loads the plugin from `~/.config/omarchy/plugins/`, and the documented install is a
 * copy. So a change to `widget/` is invisible on the bar until it is copied over and the shell is
 * restarted — and the capture succeeds either way, producing a photograph of the *old* build with
 * nothing to say it is old.
 *
 * That is worse than a failure. It cost a whole round of "the fix did not work" on a fix that was
 * measurably correct, and the next step after that conclusion is usually to change something that
 * was already right.
 *
 * A symlinked install (`ln -sfn "$PWD/widget" ...`) makes this permanently a non-issue and is in
 * widget/README.md; this check exists for everyone who followed the other instruction.
 */
function warnIfWidgetIsStale(): void {
  const installed = join(homedir(), ".config/omarchy/plugins/anchor.pulse");
  if (!existsSync(installed)) return; // not installed is a different problem, and an obvious one
  const stale = readdirSync(SRC)
    .filter((f) => f.endsWith(".qml") || f.endsWith(".js") || f === "manifest.json")
    .filter((f) => {
      const there = join(installed, f);
      return !existsSync(there) || readFileSync(there, "utf8") !== readFileSync(join(SRC, f), "utf8");
    });
  if (stale.length === 0) return;

  console.warn(
    `\n  ! The bar is running an older widget. These differ from this checkout:\n` +
      stale.map((f) => `      ${f}`).join("\n") +
      `\n    You are about to photograph the installed build, not your change.\n` +
      `      cp ${SRC}/*.qml ${SRC}/*.js ${installed}/ && omarchy restart shell\n`,
  );
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

/** When the shot for a file was taken, or null when there is not one. */
const mtimeOf = (file: string): number | null => {
  try {
    return statSync(join(OUT, file)).mtimeMs;
  } catch {
    return null; // not there, which is the only thing the caller wants to know
  }
};

const pageOnly = args.includes("--page-only");
const failures = new Map<string, string>();
let taken = 0;

if (pageOnly) {
  if (!existsSync(OUT)) {
    console.error("Nothing in review/ to build a page over. Run a capture first.");
    process.exit(1);
  }
} else {
  if (wanted.some((s) => s.group === "widget")) warnIfWidgetIsStale();
  mkdirSync(OUT, { recursive: true });

  for (const surface of wanted) {
    const name = fileFor(surface);
    // Delete the shot immediately before replacing it, so a capture that fails halfway leaves no
    // photograph behind pretending to be the new one. Only the shots being retaken go: this used to
    // empty the whole directory, and `review.ts widget` threw away twenty-four panels it had not
    // been asked to take.
    rmSync(join(OUT, name), { force: true });
    try {
      await surface.capture(join(OUT, name));
      if (!existsSync(join(OUT, name))) throw new Error("the tool reported success but wrote no file");
      taken++;
      console.log(`  captured  ${surface.id}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      failures.set(surface.id, reason);
      console.log(`  skipped   ${surface.id} — ${reason}`);
    }
  }
}

// Over everything on disk, not over the surfaces this run wanted. A scoped run is a way to refresh
// part of a review, not a way to start a new one.
const results = shotsFor(SURFACES, mtimeOf, failures);

writeFileSync(join(OUT, "index.html"), page(results));
const shown = results.filter((r) => r.file !== null).length;
const took = pageOnly ? "" : `${taken} captured, `;
console.log(`\n${took}${shown} of ${results.length} on the page. Open: file://${join(OUT, "index.html")}`);
