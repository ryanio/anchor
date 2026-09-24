/**
 * Action parsing and state resolution.
 *
 * These run no real commands. What they pin down is the vocabulary: which verbs exist, that an
 * unknown one is refused rather than guessed at, and — most importantly — that no verb here can move value.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { dispatch, resolveActive, tokenize, useFakeProcesses } from "./actions.ts";

// Every exit to the real world is faked for the whole file; `ran` records what would have run.
const ran: string[][] = [];
let restore: () => void;
before(() => {
  const child = { on: () => {}, unref: () => {} };
  restore = useFakeProcesses(
    () => child,
    (command, args, callback) => {
      ran.push([command, ...args]);
      callback(null, "ok", "");
      return child;
    },
  );
});
after(() => restore());

const SNAPSHOT = {
  workspace: 4,
  occupied: new Set([1, 4]),
  nightlight: true,
  stayingAwake: false,
  muted: false,
};

describe("tokenize", () => {
  test("splits on whitespace", () => {
    assert.deepEqual(tokenize("omarchy toggle nightlight"), ["omarchy", "toggle", "nightlight"]);
  });

  test("keeps a quoted argument together", () => {
    assert.deepEqual(tokenize('omarchy reminder 15 "Pickup Jack"'), [
      "omarchy",
      "reminder",
      "15",
      "Pickup Jack",
    ]);
  });

  test("an empty action is empty, not a token", () => {
    assert.deepEqual(tokenize("   "), []);
  });
});

describe("dispatch", () => {
  const context = { setPage: () => {} };

  test("an empty action and noop both succeed without doing anything", () => {
    assert.equal(dispatch("", context), true);
    assert.equal(dispatch("noop", context), true);
  });

  test("switches page through the context rather than reaching for global state", () => {
    let target = "";
    assert.equal(
      dispatch("page anchor", {
        setPage: (name) => {
          target = name;
        },
      }),
      true,
    );
    assert.equal(target, "anchor");
  });

  test("refuses an unknown verb instead of shelling out", () => {
    assert.equal(dispatch("rm -rf /", context), false);
    assert.equal(dispatch("sudo reboot", context), false);
    assert.equal(dispatch("sh -c whatever", context), false);
  });

  test("refuses a malformed argument rather than defaulting", () => {
    assert.equal(dispatch("volume loud", context), false);
    assert.equal(dispatch("exec", context), false);
    assert.equal(dispatch("page", context), false);
    assert.equal(dispatch("workspace", context), false);
    assert.equal(dispatch("hypr", context), false);
  });

  test("the vocabulary contains no verb that can sign or spend", () => {
    // AGENTS.md invariant 1: the requester never approves. A device is the least trustworthy
    // requester in the system, so it has no word for these at all.
    for (const forbidden of ["sign", "approve", "transfer", "withdraw", "buy", "sell", "list", "offer"]) {
      assert.equal(dispatch(`${forbidden} everything`, context), false, `${forbidden} must not be a verb`);
    }
  });
});

describe("resolveActive", () => {
  test("resolves each state expression against the snapshot", () => {
    assert.equal(resolveActive("workspace:4", SNAPSHOT, "desktop"), true);
    assert.equal(resolveActive("workspace:2", SNAPSHOT, "desktop"), false);
    assert.equal(resolveActive("occupied:1", SNAPSHOT, "desktop"), true);
    assert.equal(resolveActive("occupied:3", SNAPSHOT, "desktop"), false);
    assert.equal(resolveActive("nightlight", SNAPSHOT, "desktop"), true);
    assert.equal(resolveActive("awake", SNAPSHOT, "desktop"), false);
    assert.equal(resolveActive("page:desktop", SNAPSHOT, "desktop"), true);
    assert.equal(resolveActive("page:anchor", SNAPSHOT, "desktop"), false);
  });

  test("an empty or unknown state is inactive, never active by accident", () => {
    assert.equal(resolveActive("", SNAPSHOT, "desktop"), false);
    assert.equal(resolveActive("nonsense", SNAPSHOT, "desktop"), false);
    assert.equal(resolveActive("workspace:notanumber", SNAPSHOT, "desktop"), false);
  });
});

describe("workspace actions speak Hyprland 0.56's Lua", () => {
  // Hyprland wraps the argument in `return hl.dispatch(...)`, so the old argv form
  // `dispatch("workspace", "3")` became the Lua syntax error `hl.dispatch(workspace 3)`. The fake
  // records what would have reached `hyprctl`; a real one would switch workspace or close a window.
  const context = { setPage: () => {} };
  beforeEach(() => {
    ran.length = 0;
  });

  test("`workspace N` focuses the workspace through a Lua dispatcher", () => {
    assert.equal(dispatch("workspace 3", context), true);
    assert.deepEqual(ran, [["hyprctl", "dispatch", 'hl.dsp.focus({ workspace = "3" })']]);
  });

  test("raw `hypr` passes its Lua expression through unchanged", () => {
    assert.equal(dispatch("hypr hl.dsp.window.close()", context), true);
    assert.deepEqual(ran, [["hyprctl", "dispatch", "hl.dsp.window.close()"]]);
  });
});
