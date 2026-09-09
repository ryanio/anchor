/**
 * A mistyped config must say what is wrong and where, because the alternative is debugging by
 * staring at hardware. Each case below is a mistake that would otherwise show up as a blank key.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConfigError, loadConfig, parseConfig } from "./config.ts";

const minimal = { pages: [{ name: "desktop", keys: [{ index: 0, label: "x" }] }] };

describe("parseConfig", () => {
  test("accepts a minimal page and applies defaults", () => {
    const config = parseConfig(minimal);
    assert.equal(config.brightness, 70);
    const page = config.pages[0];
    assert.ok(page !== undefined);
    assert.equal(page.name, "desktop");
    assert.equal(page.keys[0]?.action, "");
    assert.deepEqual(page.dials, []);
  });

  test("rejects a config with no pages", () => {
    assert.throws(() => parseConfig({ pages: [] }), ConfigError);
    assert.throws(() => parseConfig({}), ConfigError);
  });

  test("rejects a key with no index, naming the path", () => {
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", keys: [{ label: "x" }] }] }),
      (error: Error) => error instanceof ConfigError && error.message.includes("pages[0].keys[0].index"),
    );
  });

  test("rejects duplicate page names", () => {
    assert.throws(() => parseConfig({ pages: [{ name: "a" }, { name: "a" }] }), /duplicate page name/);
  });

  test("rejects out-of-range brightness", () => {
    assert.throws(() => parseConfig({ brightness: 101, ...minimal }), /brightness must be 0-100/);
    assert.throws(() => parseConfig({ brightness: -1, ...minimal }), /brightness must be 0-100/);
  });

  test("rejects a tone that is not a token name", () => {
    // Guards principle 8 at the config boundary: a config cannot introduce a colour, only pick one.
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", keys: [{ index: 0, tone: "#ff0000" }] }] }),
      /not a token name/,
    );
  });

  test("rejects wrong types rather than coercing them", () => {
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", keys: [{ index: "0" }] }] }),
      /must be an integer/,
    );
    assert.throws(() => parseConfig({ pages: [{ name: "a", keys: {} }] }), /must be an array/);
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", keys: [{ index: 0, label: 5 }] }] }),
      /must be a string/,
    );
  });

  test("requires a segment to name a source", () => {
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", segments: [{ icon: "x" }] }] }),
      /source is required/,
    );
  });
});

describe("the packaged default config", () => {
  test("loads and defines both pages", () => {
    const { config } = loadConfig();
    assert.deepEqual(
      config.pages.map((page) => page.name),
      ["desktop", "anchor"],
    );
  });

  test("every icon is a private-use glyph, so no config carries a literal replacement char", () => {
    const { config } = loadConfig();
    const icons: string[] = [];
    for (const page of config.pages) {
      for (const key of page.keys) if (key.icon) icons.push(key.icon);
      for (const dial of page.dials) if (dial.icon) icons.push(dial.icon);
      for (const segment of page.segments) if (segment.icon) icons.push(segment.icon);
    }
    assert.ok(icons.length > 0, "the default config should ship icons");
    for (const icon of icons) {
      const point = icon.codePointAt(0) ?? 0;
      assert.ok(point >= 0xe000 && point <= 0xf8ff, `${JSON.stringify(icon)} is not a Nerd Font glyph`);
    }
  });

  test("every page action names a verb the dispatcher knows", () => {
    const known = new Set(["omarchy", "hypr", "exec", "page", "volume", "brightness", "theme", "noop"]);
    const { config } = loadConfig();
    for (const page of config.pages) {
      for (const key of page.keys) {
        if (key.action === "") continue;
        assert.ok(known.has(key.action.split(" ")[0] ?? ""), `${page.name}/${key.label}: ${key.action}`);
      }
      for (const dial of page.dials) {
        if (dial.press === "") continue;
        assert.ok(
          known.has(dial.press.split(" ")[0] ?? ""),
          `${page.name} dial ${dial.index}: ${dial.press}`,
        );
      }
    }
  });

  test("every page target referenced by a `page` action exists", () => {
    const { config } = loadConfig();
    const names = new Set(config.pages.map((page) => page.name));
    for (const page of config.pages) {
      for (const key of page.keys) {
        if (!key.action.startsWith("page ")) continue;
        assert.ok(names.has(key.action.slice(5).trim()), `${page.name}/${key.label} goes nowhere`);
      }
    }
  });
});
