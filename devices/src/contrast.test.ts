/**
 * The readability gate for device surfaces.
 *
 * `scripts/check-contrast.ts` holds the web surfaces to WCAG AA. Devices cannot use it — their
 * palette is not `theme/tokens.css` but whichever Omarchy theme the user is wearing — so the same
 * threshold is enforced here, against every theme this machine can put on a key.
 *
 * This exists because the first version of the key face used `inkDim` for labels. It looked
 * deliberate and measured 2.0-3.4:1 depending on the theme, which is unreadable, and the report
 * that it was unreadable came from a person looking at hardware rather than from any test.
 *
 * Two more lessons are recorded below, both of the same shape as that one — careful attention to
 * the thing being looked at, none to the thing being looked *through*. Every assertion here used to
 * compare a mark against `ground`, and the illegible marks were the ones on an *active* tile, a
 * surface `ground` does not describe. And every palette used to arrive via `loadTokens`, which
 * falls back to Tokyo Night for a name it cannot resolve — so a theme with no readable
 * `colors.toml` was measured as Tokyo Night and passed. Both are covered now; neither was visible
 * in a green test run.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { installedThemes, themesIn } from "./themes.ts";
import { activeFill, deviceTokens, onActive, type Tokens, toRgb } from "./tokens.ts";

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

describe("contrast", () => {
  test("the ratio maths matches known values", () => {
    // Make the instrument fail before trusting it: these are the WCAG reference extremes.
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
    assert.equal(contrast("#000000", "#000000"), 1);
  });
});

describe("the themes this repo ships", () => {
  const shipped = themesIn(join(dirname(fileURLToPath(import.meta.url)), "../../themes"));

  test("are found, and are palettes rather than empty files", () => {
    // Without this the suite below would pass by checking nothing at all, which is the failure the
    // file header describes: a theme that cannot be read is not a theme that passed.
    assert.ok(shipped.length > 0, "no themes found under themes/ — the gate would be vacuous");
    for (const theme of shipped) {
      assert.ok(typeof theme.colors.background === "string", `${theme.name}: colors.toml has no background`);
    }
  });
});

describe("device palettes meet AA", () => {
  const themes = installedThemes();

  test("there are themes to check", () => {
    if (themes.length === 0) {
      console.log("no Omarchy themes installed; palette checks skipped");
    }
    assert.ok(true);
  });

  for (const { name: theme, colors } of themes) {
    test(`${theme}: key labels and readings are legible`, () => {
      const tokens: Tokens = deviceTokens(theme, colors);
      // 4.5:1 is the AA floor for body text, which is what a key label is.
      assert.ok(
        contrast(tokens.ink, tokens.ground) >= 4.5,
        `${theme}: label ink ${tokens.ink} on ${tokens.ground} is ${contrast(tokens.ink, tokens.ground).toFixed(2)}:1`,
      );
      assert.ok(
        contrast(tokens.inkStrong, tokens.ground) >= 4.5,
        `${theme}: strong label ${tokens.inkStrong} is ${contrast(tokens.inkStrong, tokens.ground).toFixed(2)}:1`,
      );
      // Text contrast, not the 3:1 an icon or a rule would need, because every toned colour is also
      // drawn as a tile's *reading* — a portfolio total or a P&L, which `autoSize` shrinks to 13px
      // to keep its last digits. A number that small cannot claim the large-text exemption.
      for (const role of ["accent", "positive", "negative", "warning"] as const) {
        const value = tokens[role];
        assert.ok(
          contrast(value, tokens.ground) >= 4.5,
          `${theme}: ${role} ${value} on ${tokens.ground} is ${contrast(value, tokens.ground).toFixed(2)}:1`,
        );
      }
    });

    /**
     * The assertion that was measuring the wrong surface.
     *
     * An active key is not drawn on `ground`. It is filled with its tone, and the icon and label go
     * on top of *that*. The old face tinted the tile 30% toward the tone and then drew the tone on
     * it, which came out at 2.25:1 on `rose-pine` and 2.63:1 on `catppuccin-latte` — an "on" key
     * less legible than an "off" one. It was plain in a preview and invisible to this file.
     */
    test(`${theme}: an active key's marks are legible on its own fill`, () => {
      const tokens: Tokens = deviceTokens(theme, colors);
      for (const role of ["accent", "positive", "negative", "warning"] as const) {
        const fill = activeFill(tokens, tokens[role]);
        const mark = onActive(tokens, fill);
        assert.ok(
          contrast(mark, fill) >= 4.5,
          `${theme}: ${role} active mark ${mark} on ${fill} is ${contrast(mark, fill).toFixed(2)}:1`,
        );
        // An "on" key that looks like an "off" key is not a state, whatever its label says.
        assert.ok(
          contrast(fill, tokens.ground) >= 1.5,
          `${theme}: ${role} active fill ${fill} is ${contrast(fill, tokens.ground).toFixed(2)}:1 off ground`,
        );
      }
    });

    /**
     * Depth instead of dividers (`theme/README.md` principle 5) only works when the layers differ.
     * Five stock themes set `lighter_background` to their own `background`, so a pressed key flashed
     * at 1.02:1 — through the deck's diffuser, no feedback at all — and nine put the gap between
     * keys within 1.02:1 of the key itself, which leaves the grid as one unbroken slab.
     */
    test(`${theme}: the three surfaces and the tile edge are distinguishable`, () => {
      const tokens: Tokens = deviceTokens(theme, colors);
      const pairs: [string, string, string, number][] = [
        ["pressed key", tokens.raised, tokens.ground, 1.18],
        ["gap between keys", tokens.ground, tokens.sunken, 1.14],
        ["tile edge", tokens.line, tokens.ground, 1.55],
      ];
      for (const [what, a, b, floor] of pairs) {
        assert.ok(
          contrast(a, b) >= floor,
          `${theme}: ${what} ${a} on ${b} is ${contrast(a, b).toFixed(2)}:1, under ${floor}`,
        );
      }
      // The edge must stay an edge. A boundary that reaches text contrast reads as content.
      assert.ok(
        contrast(tokens.line, tokens.ground) <= 4.5,
        `${theme}: tile edge ${tokens.line} is ${contrast(tokens.line, tokens.ground).toFixed(2)}:1 — an edge, not a rule`,
      );
    });
  }
});
