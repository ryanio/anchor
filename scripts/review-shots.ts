#!/usr/bin/env node
/**
 * Decide what the review page gets built over.
 *
 * This exists as its own module because it is the one piece of `review.ts` worth a test, and
 * `review.ts` cannot be imported by one — it captures screenshots at the top level, so importing it
 * takes photographs.
 *
 * ## The bug this is the fix for
 *
 * `node scripts/review.ts widget` used to empty `review/` and then photograph the one group it was
 * asked for. It cost a real review: twenty-four panel shots were deleted by a run that only wanted
 * the bar, and the page rebuilt itself around the single surface that remained. Nothing said
 * anything was gone — the page looked finished, with one card on it.
 *
 * So a scoped run now replaces only what it retakes, and the page is built over **everything** on
 * disk rather than over the surfaces this run happened to want.
 *
 * That trade has a cost, and it is the one this repository keeps paying: a shot left from an earlier
 * run is a photograph of an older build with nothing to say it is old. So every shot carries the
 * time it was taken, and the page marks the ones that did not come from the same run as the rest.
 * Keeping the stale shot and labelling it beats deleting it, because a labelled old panel can still
 * be reviewed and a deleted one cannot.
 */

import type { Shot, SurfaceMeta } from "./review-page.ts";

/** A surface with a file name attached — the shape `review.ts` builds its list in. */
export interface Placed extends SurfaceMeta {
  /** Where the shot lands under `review/`, when it is not `<id>.png`. */
  fileName?: string;
}

/** Where a surface's shot lands under `review/`. */
export const fileFor = (surface: Placed): string => surface.fileName ?? `${surface.id}.png`;

/**
 * Pair every surface with the shot on disk for it.
 *
 * @param surfaces every surface that exists, not only the ones this run wanted.
 * @param mtimeOf  when the shot for a file was written, or null when there is none.
 * @param failures reasons, by surface id, for captures that were attempted and did not work. A
 *                 surface that failed says why; one that was never attempted says that instead,
 *                 because "not captured yet" and "grim refused" are different problems and a
 *                 reviewer chasing the second should not be told the first.
 */
export function shotsFor(
  surfaces: Placed[],
  mtimeOf: (file: string) => number | null,
  failures: ReadonlyMap<string, string> = new Map(),
): Shot[] {
  return surfaces.map((surface): Shot => {
    const file = fileFor(surface);
    const at = mtimeOf(file);
    if (at !== null) return { surface, file, capturedAt: at };
    const failed = failures.get(surface.id);
    return {
      surface,
      file: null,
      reason: failed ?? "not captured yet — run `node scripts/review.ts` with no arguments",
    };
  });
}
