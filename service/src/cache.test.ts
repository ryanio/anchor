import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tempCache } from "./fixtures.ts";

describe("Cache", () => {
  test("returns null for a key that was never written", () => {
    assert.equal(tempCache().get("missing"), null);
  });

  test("round-trips a value and reports it fresh", () => {
    const c = tempCache();
    c.put("k", { hello: "world" }, 60);
    const entry = c.get<{ hello: string }>("k");
    assert.ok(entry);
    assert.deepEqual(entry.data, { hello: "world" });
    assert.equal(entry.stale, false);
    assert.ok(entry.ageSeconds < 5);
  });

  test("marks an entry stale once past its ttl", () => {
    const c = tempCache();
    c.put("k", 1, 0); // ttl 0 => stale on the next tick
    const entry = c.get("k");
    assert.ok(entry);
    assert.equal(entry.stale, true);
    // Still readable: we serve stale rather than nothing.
    assert.deepEqual(entry.data, 1);
  });

  test("writing the same key replaces rather than duplicates", () => {
    const c = tempCache();
    c.put("k", "first", 60);
    c.put("k", "second", 60);
    assert.equal(c.get<string>("k")?.data, "second");
  });
});
