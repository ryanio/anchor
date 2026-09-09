/**
 * The device review, held to the promises it makes.
 *
 * Nothing here rasterises. CI has neither this machine's fonts nor its Omarchy themes, and AGENTS.md
 * is explicit that asserting on rasterised layout turned main red once already — so these are
 * assertions about the *matrix*: that every case resolves, that every state a real client can
 * produce is on the page, and that a frame built for a case is the frame the device would be sent.
 *
 * The failure this is aimed at is the one the panel gallery already had: a review that quietly
 * shrinks. A typo in a device id used to mean one fewer card on a page that still looked finished,
 * and "looks finished" is the only signal a reviewer gets.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "./config.ts";
import { keySlot, SCREEN_SLOT, STRIP_SLOT } from "./panel.ts";
import { buildFrame, CASES, DEVICES, deviceCases, STATES } from "./review.ts";
import { EMPTY_PORTFOLIO } from "./state/anchor.ts";
import { deviceTokens } from "./tokens.ts";

// A palette with no theme behind it: `toTokens` fills every role from its own fallbacks, so this
// works on a machine with no Omarchy install. Tokens do not affect layout, which is what is tested.
const TOKENS = deviceTokens("test", {});
const { config } = loadConfig(new URL("../config/panel.json", import.meta.url).pathname);

describe("the review matrix", () => {
  test("every case resolves to a device and a state that exist", () => {
    // `deviceCases` drops a case it cannot resolve, which keeps the renderer total and would
    // otherwise make a typo invisible: the page loses a card and says nothing about it.
    assert.equal(deviceCases().length, CASES.length);
  });

  test("ids and files are unique", () => {
    const cases = deviceCases();
    assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
    assert.equal(new Set(cases.map((entry) => entry.file)).size, cases.length);
  });

  test("every case names a page the shipped config actually has", () => {
    const pages = new Set(config.pages.map((page) => page.name));
    for (const spec of CASES) {
      if (spec.page === undefined) continue;
      assert.ok(pages.has(spec.page), `case ${spec.id} wants page ${spec.page}, which is not in the config`);
    }
  });

  test("every device is looked at, and every state is exercised", () => {
    const cases = deviceCases();
    for (const device of DEVICES) {
      assert.ok(
        cases.some((entry) => entry.device.id === device.id),
        `${device.id} has no card — a device nobody can look at is a device nobody has designed`,
      );
    }
    for (const state of STATES) {
      assert.ok(
        cases.some((entry) => entry.state.id === state.id),
        `state ${state.id} has no card`,
      );
    }
  });

  /**
   * The states the panel is in are not a wish list; `state/anchor.ts` produces exactly these
   * `detail` strings and no others. If one is added there and not here, the review stops covering
   * the panel it claims to cover — which is how the widget's warning screens went unreviewed.
   */
  test("every failure the portfolio client can report has a card", () => {
    const covered = new Set(STATES.map((state) => state.portfolio.detail));
    for (const detail of [EMPTY_PORTFOLIO.detail, "service not running", "no wallet configured"]) {
      assert.ok(covered.has(detail), `no case shows the panel when portfolio.detail is "${detail}"`);
    }
    // The status-code branch is a template, so cover it by shape rather than by an exact code.
    assert.ok([...covered].some((detail) => /^portfolio \d{3}$/.test(detail)));
  });

  test("the service is shown unreachable, up-without-a-wallet, and ready", () => {
    const services = STATES.map((state) => state.service);
    assert.ok(services.some((service) => !service.reachable));
    assert.ok(services.some((service) => service.reachable && !service.hasWallet));
    assert.ok(services.some((service) => service.reachable && service.hasWallet));
  });
});

describe("a frame built for a case", () => {
  const caseNamed = (id: string) => {
    const found = deviceCases().find((entry) => entry.spec.id === id);
    assert.ok(found !== undefined, `no case named ${id}`);
    return found;
  };

  test("fills every paintable key the device has", () => {
    const entry = caseNamed("deck-plus");
    const frame = buildFrame(entry, config, TOKENS);
    for (const slot of entry.device.capabilities.slots) {
      if (slot.paintable) assert.ok(frame.has(slot.id), `${slot.id} was left unpainted`);
    }
    assert.ok(frame.has(STRIP_SLOT));
  });

  test("a screen device gets a list rather than tiles", () => {
    const frame = buildFrame(caseNamed("pulse-amoled"), config, TOKENS);
    assert.equal(frame.get(SCREEN_SLOT)?.kind, "list");
  });

  /**
   * A held key is drawn by rewriting the tile, never by feeding a press through `Panel.handle`.
   * `handle` dispatches the key's action, so a review of the desktop page rendered that way would
   * take a screenshot and cycle the user's theme every time it ran.
   */
  test("a held key is raised, and nothing was dispatched to make it so", () => {
    const entry = caseNamed("pressed-key");
    const frame = buildFrame(entry, config, TOKENS);
    const surface = frame.get(keySlot(entry.spec.pressedKey ?? 0));
    assert.equal(surface?.kind, "tile");
    assert.equal(surface?.kind === "tile" ? surface.emphasis : "", "raised");
    // Every other key is unpressed, so the frame is one state rather than a stuck one.
    const raised = [...frame.values()].filter((s) => s.kind === "tile" && s.emphasis === "raised");
    assert.equal(raised.length, 1);
  });

  test("a blanked device is painted with nothing at all", () => {
    // The lock is a security property, not a nicety: every adapter clears the panel and drops the
    // backlight, and a frame with a portfolio still in it would be the bug.
    assert.equal(buildFrame(caseNamed("blank-deck"), config, TOKENS).size, 0);
    assert.equal(buildFrame(caseNamed("blank-pulse"), config, TOKENS).size, 0);
  });

  test("a gallery key carries the piece's name, so a list device can say which piece", () => {
    const frame = buildFrame(caseNamed("pulse-amoled"), config, TOKENS);
    const surface = frame.get(SCREEN_SLOT);
    assert.equal(surface?.kind, "list");
    if (surface?.kind !== "list") return;
    // The regression: the source used to blank the name once artwork arrived, so a screen device
    // fell through to `Key ${index}` and a row of the gallery read "Key 2".
    assert.equal(
      surface.rows.some((row) => /^Key \d+$/.test(row.label)),
      false,
      `a row fell back to its slot number: ${surface.rows.map((row) => row.label).join(", ")}`,
    );
  });
});
