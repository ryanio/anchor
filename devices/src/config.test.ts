/**
 * A mistyped config must say what is wrong and where, because the alternative is debugging by
 * staring at hardware. Each case below is a mistake that would otherwise show up as a blank key.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dispatch, useFakeProcesses } from "./actions.ts";
import { ConfigError, loadConfig, parseConfig } from "./config.ts";
import { BROWSE_PAGES, ROTATING_PAGES, readKeySource, SEGMENT_SOURCES } from "./panel.ts";
import { EMPTY_SNAPSHOT } from "./state/desktop.ts";

const OFFLINE = { reachable: false, detail: "not running", hasWallet: false, primaryChain: "" };

// The packaged file, by path: with no path `loadConfig` prefers the user's own devices.json.
const SHIPPED = new URL("../config/panel.json", import.meta.url).pathname;

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

  test("takes a page's layout, and refuses one it does not have", () => {
    // Absent is the default and means today's behaviour: a page of keys. A typo must not quietly
    // become that too, because a browse page rendered as an empty key grid looks like the feature
    // is broken rather than like the config is.
    assert.equal(parseConfig(minimal).pages[0]?.layout, undefined);
    const screen = parseConfig({ pages: [{ name: "a", layout: "screen" }] });
    assert.equal(screen.pages[0]?.layout, "screen");
    assert.throws(
      () => parseConfig({ pages: [{ name: "a", layout: "screeen" }] }),
      (error: Error) => error instanceof ConfigError && error.message.includes("pages[0].layout"),
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
  test("ships every page the panel names in code", () => {
    // `panel.ts` treats these names specially; a config without one leaves that behaviour unreachable.
    const names = new Set(loadConfig(SHIPPED).config.pages.map((page) => page.name));
    for (const name of [...ROTATING_PAGES, ...BROWSE_PAGES.keys()]) {
      assert.ok(names.has(name), `${name} is named in panel.ts but not shipped`);
    }
  });

  test("every page with keys at all fills the whole device", () => {
    // Eight keys is what the hardware has. A page using five is five buttons of product and three
    // of background. A page with *no* keys is a different thing: it is not for a keyed device at
    // all — `tokens`/`nfts` exist only for a screen's `pulseDetail`, and a Stream Deck showing one
    // would get eight blank tiles, which `Panel.build` already handles by clearing them.
    const { config } = loadConfig(SHIPPED);
    for (const page of config.pages) {
      if (page.keys.length === 0) continue;
      assert.equal(page.keys.length, 8, `${page.name} uses ${page.keys.length} of 8 keys`);
    }
  });

  test("every data-backed key names a source the panel can read", () => {
    const { config } = loadConfig(SHIPPED);
    for (const page of config.pages) {
      for (const key of page.keys) {
        if (key.source === "") continue;
        assert.notEqual(
          readKeySource(key.source, { desktop: EMPTY_SNAPSHOT, service: OFFLINE }),
          null,
          `${page.name}/${key.index}: unknown source ${key.source}`,
        );
      }
    }
  });

  test("every strip segment names a source the panel can read", () => {
    const { config } = loadConfig(SHIPPED);
    for (const page of config.pages) {
      for (const segment of page.segments) {
        assert.ok(segment.source in SEGMENT_SOURCES, `${page.name}: unknown segment ${segment.source}`);
      }
    }
  });

  test("every icon is a private-use glyph, so no config carries a literal replacement char", () => {
    const { config } = loadConfig(SHIPPED);
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

  test("every key that is not showing a reading is showing an icon", () => {
    /*
     * A key either reports something or does something. One that reports has a `source` and fills
     * its face with the reading; one that does has an `action` and an icon, because a label alone on
     * a 72px key is a word floating in a box.
     *
     * This exists because four keys shipped with `"icon": ""`. The icon test above them skips a key
     * whose icon is falsy — it was written to catch a *wrong* glyph, and an absent one walked past
     * it — so the second row of the deck rendered as four blank squares and stayed that way until
     * somebody looked at the hardware and said so. A config that cannot draw a key is a config
     * error, and it should fail here rather than on the desk.
     */
    const { config } = loadConfig(SHIPPED);
    for (const page of config.pages) {
      for (const key of page.keys) {
        if (key.source !== "") continue;
        assert.notEqual(
          key.icon,
          "",
          `${page.name}/${key.index} (${key.label}): an action key needs an icon`,
        );
      }
    }
  });

  test("every page action is one the dispatcher accepts", () => {
    // Dispatched for real, against faked processes: a verb the dispatcher dropped, or an argument
    // it refuses, is a dead key.
    const child = { on: () => {}, unref: () => {} };
    const restore = useFakeProcesses(
      () => child,
      (_command, _args, callback) => {
        callback(null, "", "");
        return child;
      },
    );
    try {
      const context = { setPage: () => {} };
      for (const page of loadConfig(SHIPPED).config.pages) {
        for (const key of page.keys) {
          if (key.action === "") continue;
          assert.equal(dispatch(key.action, context), true, `${page.name}/${key.label}: ${key.action}`);
        }
        for (const dial of page.dials) {
          if (dial.press === "") continue;
          assert.equal(dispatch(dial.press, context), true, `${page.name} dial ${dial.index}: ${dial.press}`);
        }
      }
    } finally {
      restore();
    }
  });

  test("every page can reach the first page, so no page is a dead end", () => {
    // A panel is not a website: there is no back button, no url bar and no way out of a page that
    // links only to pages that link back to it. This exact loop shipped once — desktop -> money ->
    // chains -> money — and the only way home was a swipe nobody had been told about.
    const { config } = loadConfig(SHIPPED);
    const home = config.pages[0]?.name ?? "";
    const edges = new Map(
      config.pages.map((page) => [
        page.name,
        page.keys.filter((key) => key.action.startsWith("page ")).map((key) => key.action.slice(5).trim()),
      ]),
    );
    for (const page of config.pages) {
      // A page with no keys at all (`tokens`/`nfts` — a screen-only ambient view, no keyed device
      // ever shows it) has no key-press navigation to be a dead end *in*: this check is about a
      // loop of `page` actions, and a page with none cannot form one.
      if (page.keys.length === 0) continue;
      const seen = new Set<string>();
      const queue = [page.name];
      while (queue.length > 0) {
        const at = queue.shift();
        if (at === undefined || seen.has(at)) continue;
        seen.add(at);
        queue.push(...(edges.get(at) ?? []));
      }
      assert.ok(seen.has(home), `${page.name} cannot reach ${home} by any sequence of key presses`);
    }
  });

  test("every page target referenced by a `page` action exists", () => {
    const { config } = loadConfig(SHIPPED);
    const names = new Set(config.pages.map((page) => page.name));
    for (const page of config.pages) {
      for (const key of page.keys) {
        if (!key.action.startsWith("page ")) continue;
        assert.ok(names.has(key.action.slice(5).trim()), `${page.name}/${key.label} goes nowhere`);
      }
    }
  });
});
