/**
 * Tests that the drawn mark still matches the brand.
 *
 * `AnchorMark.qml` redraws `site/brand/anchor.svg` as a QML path rather than loading it, so that the
 * mark takes its colour from whichever Omarchy theme is applied. The cost of that choice is two
 * copies of one geometry, and a copy drifts silently: nothing fails, the mark just stops being the
 * mark. These tests are the thing that notices.
 *
 * They also pin the two properties the mark was redrawn to have, both of which a bar broke:
 *
 * - **Square bounds.** The old mark was 32 wide by 45 tall and drew 10×12 in a row of glyphs
 *   drawing 9–11 square. Shrinking it could not fix that, because scaling preserves aspect ratio.
 * - **A stroke above one device pixel.** The old mark's computed to 0.93 at bar size, which
 *   antialiases to grey. Fewer elements is what buys the weight, so a fifth element in this path
 *   is not a small change and the count is asserted.
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

/** The QML path, read out of its declaration. */
function qmlPath() {
  // The declaration ends at the blank line before `Shape`. Reading to the end of the file instead
  // would sweep up `fillColor: "transparent"` and compare the mark against the letters in it.
  const decl = qml.split("readonly property string _path:")[1]?.split("\n\n")[0] ?? "";
  assert.ok(decl.length > 0, "AnchorMark declares no path");
  return (decl.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1)).join("");
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

/** The bounds AnchorMark declares, read out of its `_x0`…`_y1` properties. */
function declared() {
  const at = (name) => {
    const m = qml.match(new RegExp(`readonly property real ${name}: ([\\d.]+)`));
    assert.ok(m, `AnchorMark declares no ${name}`);
    return Number(m[1]);
  };
  return { x0: at("_x0"), x1: at("_x1"), y0: at("_y0"), y1: at("_y1") };
}

// -------------------------------------------------------------------------------------------
// The QML is a transcription, not a second drawing
// -------------------------------------------------------------------------------------------

test("the mark is drawn exactly as anchor.svg draws it", () => {
  assert.deepEqual(tokens(qmlPath()), tokens(svgPath("anchor.svg")));
});

test("the declared bounds are the real bounds", () => {
  // Wrong bounds do not fail to render; they render off-centre, or clipped by a stroke's width.
  assert.deepEqual(declared(), bounds(svgPath("anchor.svg")));
});

test("anchor-solid.svg is the same drawing, only heavier", () => {
  // The weights differ on purpose — 6 clears one device pixel in a bar slot, 4.5 is for sizes with
  // room. The geometry may not, or "the mark" is two marks again.
  const weight = (file) => /stroke-width="([\d.]+)"/.exec(read(`site/brand/${file}`))?.[1];
  assert.deepEqual(tokens(svgPath("anchor-solid.svg")), tokens(svgPath("anchor.svg")));
  assert.notEqual(weight("anchor-solid.svg"), weight("anchor.svg"));
});

// -------------------------------------------------------------------------------------------
// The two properties it was redrawn to have
// -------------------------------------------------------------------------------------------

test("the mark is square, so it fills a square slot in both directions", () => {
  const b = declared();
  assert.equal(b.x1 - b.x0, b.y1 - b.y0);
});

test("it is four elements, which is what pays for the stroke", () => {
  // Ring, two arms, crossbar. The old anchor drew the flukes as two more strokes — six elements,
  // and a stroke computing to 0.93 device pixels at bar size. Folding each fluke into the end of
  // its own arm keeps the anchor and costs nothing, which is the whole design. A fifth `M` spends
  // it again, so this is a real constraint and not a tidiness check.
  const moves = tokens(qmlPath()).filter((t) => t === "M").length;
  assert.equal(moves, 4);
});

test("each arm ends in a fluke, so the mark is an anchor and not a monogram", () => {
  // Without these it is an A with a ring. It was, for one commit, and the flukes turned out to be
  // free: a curve continuing an existing path adds no element and no weight cost.
  const curves = tokens(qmlPath()).filter((t) => t === "c").length;
  assert.equal(curves, 2, "expected one fluke curve per arm");
});

test("the drawn stroke clears one device pixel at bar size", () => {
  // The arithmetic AnchorMark does: fit the artwork's bounds, inflated by half a stroke, into the
  // slot. Below 1.0 the stroke antialiases to grey, which is what "too thin" actually was.
  const b = declared();
  const strokeUnits = Number(/property real strokeUnits: ([\d.]+)/.exec(qml)?.[1]);
  const box = b.x1 - b.x0 + strokeUnits;
  const iconSize = 11; // Style.bar.iconCanvas 16 * 0.68, rounded — see Pulse.qml.
  assert.ok(
    (strokeUnits * iconSize) / box > 1,
    `stroke draws ${((strokeUnits * iconSize) / box).toFixed(2)} device pixels at ${iconSize}px`,
  );
});

test("the bar and the panel draw the same mark", () => {
  // The whole point of the rewrite: one drawing everywhere. They differ in weight, not geometry,
  // and neither may reach for a second component. Named by file, so moving the bar item into its
  // own component fails here rather than quietly stopping the check — which is what happened.
  for (const file of ["widget/BarItem.qml", "widget/PanelContent.qml"]) {
    assert.match(read(file), /AnchorMark \{/, `${file} draws no mark`);
  }
  assert.doesNotMatch(read("widget/BarItem.qml") + read("widget/PanelContent.qml"), /compact:/);
});
