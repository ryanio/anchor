/**
 * Rasterisation, against the real rasteriser.
 *
 * These deliberately shell out rather than mocking. The thing that can break here is the tool, not
 * our arithmetic: a short buffer is silently painted as garbage on a device, and the check that
 * prevents it is worth proving can actually fail.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clearRasterCache,
  RasterError,
  rasterCacheSize,
  rasteriserAvailable,
  rasterize,
} from "./raster.ts";

const solid = (color: string, width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
  `<rect width="${width}" height="${height}" fill="${color}"/></svg>`;

// Skipped rather than failed where there is no rasteriser, and the reason is printed: these prove
// the tool works, so without the tool there is nothing to prove. A skip that says why is honest; a
// mock of the thing under test would not be.
const noRasteriser = rasteriserAvailable()
  ? false
  : "no working SVG rasteriser — install imagemagick and librsvg";

describe("rasterize", { skip: noRasteriser }, () => {
  test("returns exactly width * height * 3 bytes of RGB", async () => {
    const buffer = await rasterize(solid("#7aa2f7", 4, 2), { width: 4, height: 2 });
    assert.equal(buffer.length, 24);
  });

  test("the bytes are the colour asked for, in RGB order", async () => {
    // Not a smoke test: BGR would pass a length check and paint the panel blue-for-red.
    const buffer = await rasterize(solid("#ff8000", 2, 1), { width: 2, height: 1 });
    assert.deepEqual([...buffer.subarray(0, 3)], [255, 128, 0]);
  });

  test("a 120x120 key is 43,200 bytes, as the device requires", async () => {
    const buffer = await rasterize(solid("#000000", 120, 120), { width: 120, height: 120 });
    assert.equal(buffer.length, 43_200);
  });

  test("refuses a size that does not match the SVG rather than returning a short buffer", async () => {
    await assert.rejects(() => rasterize(solid("#000000", 4, 2), { width: 99, height: 99 }), RasterError);
  });

  test("caches by source and size together", async () => {
    clearRasterCache();
    const svg = solid("#123456", 3, 3);
    const first = await rasterize(svg, { width: 3, height: 3 });
    const second = await rasterize(svg, { width: 3, height: 3 });
    assert.equal(first, second, "an unchanged face should not be re-rasterised");
    assert.equal(rasterCacheSize(), 1);
    // Keying on the source alone would hand this the cached buffer and skip the length check.
    await assert.rejects(() => rasterize(svg, { width: 5, height: 5 }), RasterError);
  });
});
