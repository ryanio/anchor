/**
 * The palette must come from the user's theme, and must never fall over when it cannot.
 *
 * The failure this guards against is a device that renders correctly on the machine it was written
 * on. `colors.toml` is read from disk, the theme is resolved by a subprocess, and a CI runner has
 * neither — so the interesting cases are the missing ones.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mix, parseFlatToml, slugify, toRgb, toTokens } from "./tokens.ts";

describe("slugify", () => {
  test("maps Omarchy display names onto theme directory names", () => {
    assert.equal(slugify("Tokyo Night"), "tokyo-night");
    assert.equal(slugify("Catppuccin Latte"), "catppuccin-latte");
    assert.equal(slugify("Retro 82"), "retro-82");
  });
});

describe("parseFlatToml", () => {
  test('reads the key = "value" pairs every theme ships', () => {
    const parsed = parseFlatToml('mode = "dark"\naccent = "#7aa2f7"\nbackground = "#1a1b26"\n');
    assert.deepEqual(parsed, { mode: "dark", accent: "#7aa2f7", background: "#1a1b26" });
  });

  test("skips comments, blanks and anything it does not understand", () => {
    // A theme that grows a table must contribute nothing rather than a guess.
    const parsed = parseFlatToml(
      '# a comment\n\naccent = "#fff"\n[table]\nnested = "x"\nbroken\narr = [1, 2]\n',
    );
    assert.equal(parsed.accent, "#fff");
    assert.equal(parsed.arr, undefined);
    assert.equal(parsed.broken, undefined);
    // Keys inside a table are not distinguished from top-level ones by this reader, which is why
    // themes are flat; what matters is that the malformed lines above contributed nothing.
    assert.equal(Object.hasOwn(parsed, "arr"), false);
  });
});

describe("toTokens", () => {
  test("maps Omarchy colours onto the device vocabulary", () => {
    const tokens = toTokens("Test", {
      mode: "dark",
      accent: "#7aa2f7",
      dark_background: "#13141c",
      lighter_background: "#24283b",
      darker_background: "#0e0e14",
      foreground: "#a9b1d6",
      green: "#9ece6a",
      red: "#f7768e",
    });
    assert.equal(tokens.ground, "#13141c");
    assert.equal(tokens.raised, "#24283b");
    assert.equal(tokens.sunken, "#0e0e14");
    assert.equal(tokens.positive, "#9ece6a");
    assert.equal(tokens.negative, "#f7768e");
    assert.equal(tokens.dark, true);
  });

  test("a light theme reports itself as light", () => {
    assert.equal(toTokens("Latte", { mode: "light" }).dark, false);
  });

  test("every token resolves even from an empty palette", () => {
    // A theme missing a key must not produce `undefined` in an SVG fill attribute.
    const tokens = toTokens("Empty", {});
    for (const [name, value] of Object.entries(tokens)) {
      if (name === "themeName" || name === "dark") continue;
      assert.match(String(value), /^#[0-9a-f]{3,6}$/i, `${name} should be a colour, got ${value}`);
    }
  });
});

describe("colour maths", () => {
  test("parses hex, including shorthand", () => {
    assert.deepEqual(toRgb("#7aa2f7"), [122, 162, 247]);
    assert.deepEqual(toRgb("7aa2f7"), [122, 162, 247]);
    assert.deepEqual(toRgb("#fff"), [255, 255, 255]);
  });

  test("returns black rather than throwing on nonsense", () => {
    assert.deepEqual(toRgb("not a colour"), [0, 0, 0]);
    assert.deepEqual(toRgb(""), [0, 0, 0]);
  });

  test("mix interpolates and clamps", () => {
    assert.equal(mix("#000000", "#ffffff", 0), "#000000");
    assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
    assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
    assert.equal(mix("#000000", "#ffffff", 5), "#ffffff");
    assert.equal(mix("#000000", "#ffffff", -5), "#000000");
  });
});
