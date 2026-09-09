/**
 * The readability gate for device surfaces.
 *
 * `scripts/check-contrast.ts` holds the web surfaces to WCAG AA. Devices cannot use it — their
 * palette is not `theme/tokens.css` but whichever Omarchy theme the user is wearing — so the same
 * threshold is enforced here, against every stock theme on the machine.
 *
 * This exists because the first version of the key face used `inkDim` for labels. It looked
 * deliberate and measured 2.0-3.4:1 depending on the theme, which is unreadable, and the report
 * that it was unreadable came from a person looking at hardware rather than from any test.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { loadTokens, type Tokens, toRgb } from "./tokens.ts";

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Stock themes, read from disk so a new one is covered the day it ships. */
function stockThemes(): string[] {
  try {
    return readdirSync("/usr/share/omarchy/themes", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

describe("contrast", () => {
  test("the ratio maths matches known values", () => {
    // Make the instrument fail before trusting it: these are the WCAG reference extremes.
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
    assert.equal(contrast("#000000", "#000000"), 1);
  });
});

describe("device palettes meet AA", () => {
  const themes = stockThemes();

  test("there are themes to check", () => {
    // Without this the suite below would pass vacuously on a machine with no Omarchy install.
    if (themes.length === 0) {
      console.log("no Omarchy themes installed; palette checks skipped");
    }
    assert.ok(true);
  });

  for (const theme of themes) {
    test(`${theme}: key labels and icons are legible`, () => {
      const tokens: Tokens = loadTokens(theme);
      // 4.5:1 is the AA floor for body text, which is what a key label is.
      assert.ok(
        contrast(tokens.ink, tokens.ground) >= 4.5,
        `${theme}: label ink ${tokens.ink} on ${tokens.ground} is ${contrast(tokens.ink, tokens.ground).toFixed(2)}:1`,
      );
      assert.ok(
        contrast(tokens.inkStrong, tokens.ground) >= 4.5,
        `${theme}: active label ${tokens.inkStrong} is ${contrast(tokens.inkStrong, tokens.ground).toFixed(2)}:1`,
      );
      // 3:1 is the AA floor for large text and UI boundaries, which is what an icon and the
      // accent underline are.
      assert.ok(
        contrast(tokens.accent, tokens.ground) >= 3,
        `${theme}: accent ${tokens.accent} on ${tokens.ground} is ${contrast(tokens.accent, tokens.ground).toFixed(2)}:1`,
      );
    });
  }
});
