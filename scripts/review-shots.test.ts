import assert from "node:assert/strict";
import { test } from "node:test";
import type { SurfaceMeta } from "./review-page.ts";
import { clearFor, clearKey, fileFor, type Placed, shotsFor } from "./review-shots.ts";

const surface = (id: string, extra: Partial<Placed> = {}): Placed => ({
  id,
  group: "panel",
  title: `Panel — ${id}`,
  looking: "whether it says which state it is in",
  ...extra,
});

const ALL = [surface("starting"), surface("ready-quiet"), surface("bar", { group: "widget" })];

/** A disk holding shots for exactly these files, all written at the same moment. */
const disk = (files: Record<string, number>) => (file: string) => files[file] ?? null;

test("a scoped capture keeps the shots it did not retake", () => {
  // The regression. `review.ts widget` emptied review/ and rebuilt the page around the one surface
  // it had been asked for, which cost a real review twenty-four panel shots. Only the bar is
  // retaken here; the panels must still be on the page.
  const before = { "starting.png": 1000, "ready-quiet.png": 1000, "bar.png": 1000 };
  const after = { ...before, "bar.png": 9000 };

  const shots = shotsFor(ALL, disk(after));

  assert.equal(shots.filter((s) => s.file !== null).length, 3);
  assert.deepEqual(
    shots.map((s) => s.file),
    ["starting.png", "ready-quiet.png", "bar.png"],
  );
  assert.equal(shots.find((s) => s.surface.id === "bar")?.capturedAt, 9000);
  assert.equal(shots.find((s) => s.surface.id === "starting")?.capturedAt, 1000);
});

test("a surface with no shot says it was never captured", () => {
  const shots = shotsFor(ALL, disk({ "starting.png": 1000 }));

  const missing = shots.find((s) => s.surface.id === "ready-quiet");
  assert.equal(missing?.file, null);
  assert.match(missing?.reason ?? "", /not captured yet/);
});

test("a capture that failed reports its own reason, not the generic one", () => {
  // "grim refused" and "nobody has run this yet" are different problems, and a reviewer chasing the
  // first should not be handed the second.
  const failures = new Map([["ready-quiet", "the desktop is not on screen"]]);

  const shots = shotsFor(ALL, disk({ "starting.png": 1000 }), failures);

  assert.equal(shots.find((s) => s.surface.id === "ready-quiet")?.reason, "the desktop is not on screen");
  assert.match(shots.find((s) => s.surface.id === "bar")?.reason ?? "", /not captured yet/);
});

test("a shot on disk wins over a recorded failure", () => {
  // A capture can throw after the file lands — magnify() runs on the shot grim already wrote. The
  // photograph is there and reviewable, so the page shows it rather than an apology.
  const failures = new Map([["starting", "magick is not installed"]]);

  const shots = shotsFor(ALL, disk({ "starting.png": 4200 }), failures);

  const landed = shots.find((s) => s.surface.id === "starting");
  assert.equal(landed?.file, "starting.png");
  assert.equal(landed?.capturedAt, 4200);
  assert.equal(landed?.reason, undefined);
});

test("fileName overrides the default file for a surface", () => {
  const nested = surface("stale", { fileName: "panel/stale.png" });
  assert.equal(fileFor(nested), "panel/stale.png");
  assert.equal(fileFor(surface("stale")), "stale.png");

  const shots = shotsFor([nested], disk({ "panel/stale.png": 7 }));
  assert.equal(shots[0]?.file, "panel/stale.png");
});

test("the shot list follows the surface list, not the disk", () => {
  // The page numbers its cards by position in this list, so an extra PNG left behind by a state
  // that has since been deleted must not appear as a surface.
  const shots = shotsFor(ALL, disk({ "starting.png": 1, "removed-state.png": 1 }));

  assert.equal(shots.length, ALL.length);
  assert.ok(!shots.some((s) => s.file === "removed-state.png"));
});

test("surface metadata is carried through untouched", () => {
  const shots = shotsFor([surface("bar", { strip: true })], disk({ "bar.png": 1 }));
  const meta: SurfaceMeta = shots[0]!.surface;
  assert.equal(meta.strip, true);
  assert.equal(meta.title, "Panel — bar");
});

/**
 * Clearing a batch.
 *
 * A stale shot must never survive the capture that was meant to replace it, so `review.ts` removes
 * each file just before retaking it. For a batch that is a bug: the first of thirty-three device
 * frames triggers a render that writes all thirty-three, and frame two then throws away its own
 * freshly-written PNG and waits on a promise that has already resolved. Thirty-two came out as "the
 * tool reported success but wrote no file", on a page that otherwise looked finished — which is the
 * same failure `shotsFor` above exists to prevent, one layer down.
 */
const BATCHED: Placed[] = [
  surface("solo", { group: "widget" }),
  surface("a", { batch: "devices", fileName: "devices/a.png" }),
  surface("b", { batch: "devices", fileName: "devices/b.png" }),
  surface("c", { batch: "panel", fileName: "panel/c.png" }),
];

test("a surface with no batch names only its own shot", () => {
  assert.deepEqual(clearFor(BATCHED[0]!, BATCHED), ["solo.png"]);
});

test("either member of a batch names the whole batch", () => {
  assert.deepEqual(clearFor(BATCHED[1]!, BATCHED), ["devices/a.png", "devices/b.png"]);
  assert.deepEqual(clearFor(BATCHED[2]!, BATCHED), ["devices/a.png", "devices/b.png"]);
});

test("a batch is emptied once per run, so a member cannot throw away a fresh shot", () => {
  // The loop `review.ts` runs, in miniature.
  const gone: string[] = [];
  const already = new Set<string>();
  for (const item of BATCHED) {
    const key = clearKey(item);
    if (already.has(key)) continue;
    already.add(key);
    gone.push(...clearFor(item, BATCHED));
  }
  assert.deepEqual(gone, ["solo.png", "devices/a.png", "devices/b.png", "panel/c.png"]);
  assert.equal(new Set(gone).size, gone.length, "a shot was named twice");
});

test("a scoped run names only the members it is capturing", () => {
  // `review.ts devices` must leave the panel's shots alone, batch or no batch.
  const wanted = BATCHED.filter((item) => item.batch === "devices");
  assert.deepEqual(clearFor(wanted[0]!, wanted), ["devices/a.png", "devices/b.png"]);
});
