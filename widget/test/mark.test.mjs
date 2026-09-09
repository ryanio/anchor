/**
 * Tests that the drawn mark still matches the brand.
 *
 * `AnchorMark.qml` redraws `site/brand/`'s SVGs as QML paths rather than loading them, so that the
 * mark takes its colour from whichever Omarchy theme is applied. The cost of that choice is two
 * copies of the same geometry, and a copy drifts silently: nothing fails, the mark just stops being
 * the mark. These tests are the thing that notices.
 *
 * They also pin the promise the bar variant exists to make. The full mark is 32 wide by 45 tall, and
 * in a row of square glyphs it drew 10×12 — the one tall, narrow thing in the bar. Shrinking it
 * cannot fix that, because scaling preserves aspect ratio, so the square variant is redrawn instead.
 * If its bounds ever stop being square, the bug is back and the test says so.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, repo)), "utf8");

const qml = read("widget/AnchorMark.qml");

/**
 * Split a path into its commands and numbers.
 *
 * The SVGs are written compactly — `M32 15L21 50` — and the QML spaces everything out for
 * legibility. Tokenizing erases that difference, which is the only difference there is allowed to
 * be.
 */
function tokens(path) {
  return path.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
}

/** The QML path for one variant, read out of the ternary that chooses between them. */
function qmlPath(variant) {
  // The declaration ends at the blank line before `Shape`. Reading to the end of the file instead
  // would sweep up `fillColor: "transparent"` and compare the mark against the letters in it.
  const decl = qml.split("readonly property string _path:")[1]?.split("\n\n")[0] ?? "";
  const split = decl.indexOf("\n    : ");
  assert.ok(split > 0, "AnchorMark's path is no longer a two-armed ternary");
  const arm = variant === "compact" ? decl.slice(0, split) : decl.slice(split);
  return (arm.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1)).join("");
}

/** The same path, transcribed out of the brand SVG: the circle as two arcs, then every `d`. */
function svgPath(file) {
  const svg = read(`site/brand/${file}`);
  const circle = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  assert.ok(circle, `${file} has no ring`);
  const [, cx, cy, r] = circle.map(Number);
  const ring = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  return [ring, ...paths].join(" ");
}

/**
 * Bounding box of the path's centreline.
 *
 * Every coordinate counts, control points included. For these curves the control hull's box and the
 * curve's own box are the same — the flukes bend monotonically — so this is exact rather than
 * merely an upper bound, and it needs no arc or Bézier solving to be so.
 */
function bounds(path) {
  let x = 0;
  let y = 0;
  let cmd = "";
  const xs = [];
  const ys = [];
  const rest = tokens(path);

  while (rest.length > 0) {
    const t = rest.shift();
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      continue;
    }
    const n = Number(t);
    const rel = cmd === cmd.toLowerCase();
    const take = () => Number(rest.shift());

    if (cmd === "M" || cmd === "L" || cmd === "m" || cmd === "l") {
      x = rel ? x + n : n;
      y = rel ? y + take() : take();
      xs.push(x);
      ys.push(y);
    } else if (cmd === "h" || cmd === "H") {
      x = rel ? x + n : n;
      xs.push(x);
      ys.push(y);
    } else if (cmd === "c" || cmd === "C") {
      // Both control points, then the endpoint. All three are relative to where the curve started.
      const c = [n, take(), take(), take(), take(), take()];
      for (let i = 0; i < 6; i += 2) {
        xs.push(rel ? x + c[i] : c[i]);
        ys.push(rel ? y + c[i + 1] : c[i + 1]);
      }
      x = rel ? x + c[4] : c[4];
      y = rel ? y + c[5] : c[5];
    } else if (cmd === "a" || cmd === "A") {
      // rx ry rotation large-arc sweep dx dy. The ring is two semicircles, so its extremes are the
      // radii either side of the centre rather than the endpoints.
      const [rx, ry] = [n, take()];
      take();
      take();
      take();
      const dx = take();
      const dy = take();
      const [ex, ey] = rel ? [x + dx, y + dy] : [dx, dy];
      xs.push(Math.min(x, ex) - rx, Math.max(x, ex) + rx);
      ys.push(Math.min(y, ey) - ry, Math.max(y, ey) + ry);
      x = ex;
      y = ey;
    } else {
      assert.fail(`unhandled path command ${JSON.stringify(cmd)}`);
    }
  }

  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
}

/** The bounds AnchorMark declares for a variant, read out of its `_x0`…`_y1` ternaries. */
function declared(variant) {
  const at = (name) => {
    const m = qml.match(new RegExp(`readonly property real ${name}: compact \\? ([\\d.]+) : ([\\d.]+)`));
    assert.ok(m, `AnchorMark declares no ${name}`);
    return Number(variant === "compact" ? m[1] : m[2]);
  };
  return { x0: at("_x0"), x1: at("_x1"), y0: at("_y0"), y1: at("_y1") };
}

// -------------------------------------------------------------------------------------------
// The QML is a transcription, not a second drawing
// -------------------------------------------------------------------------------------------

for (const [variant, file] of [
  ["full", "anchor.svg"],
  ["compact", "anchor-bar.svg"],
]) {
  test(`the ${variant} mark is drawn exactly as ${file} draws it`, () => {
    assert.deepEqual(tokens(qmlPath(variant)), tokens(svgPath(file)));
  });

  test(`the ${variant} mark's declared bounds are its real bounds`, () => {
    // Wrong bounds do not fail to render; they render off-centre, or clipped by a stroke's width.
    assert.deepEqual(declared(variant), bounds(svgPath(file)));
  });
}

// -------------------------------------------------------------------------------------------
// The reason the bar variant exists
// -------------------------------------------------------------------------------------------

test("the bar variant is square, so it fills a square slot in both directions", () => {
  const b = declared("compact");
  assert.equal(b.x1 - b.x0, b.y1 - b.y0);
});

test("the full mark is taller than it is wide, which is why the bar cannot use it", () => {
  // Not an accident to be corrected: it is correct for a mark with room around it. The test is here
  // so that anyone tempted to "fix" the full mark instead sees that the bar's problem is elsewhere.
  const b = declared("full");
  assert.ok(b.x1 - b.x0 < b.y1 - b.y0);
});

test("the bar asks for the square variant, and the panel does not", () => {
  // Pulse.qml draws the bar item; PanelContent.qml is the panel, where the mark has room and takes
  // the full artwork. Slicing one file for "the part before the panel" was how this was written
  // before the split, and it silently stopped checking anything the moment the panel moved out.
  assert.match(read("widget/Pulse.qml"), /AnchorMark \{[\s\S]*?compact: true/);
  const panel = read("widget/PanelContent.qml");
  assert.match(panel, /AnchorMark \{/);
  assert.doesNotMatch(panel, /compact:\s*true/);
});
