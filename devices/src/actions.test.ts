/**
 * Action parsing and state resolution.
 *
 * These run no commands. What they pin down is the vocabulary: which verbs exist, that an unknown
 * one is refused rather than guessed at, and — most importantly — that no verb here can move value.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dispatch, resolveActive, tokenize } from "./actions.ts";

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
