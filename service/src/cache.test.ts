import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "./cache.ts";

function tempCache(): Cache {
  return new Cache(join(mkdtempSync(join(tmpdir(), "anchor-test-")), "cache.sqlite"));
}

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
  });

  test("stale entries are still readable — we serve stale rather than nothing", () => {
    const c = tempCache();
    c.put("k", { v: 42 }, 0);
    const entry = c.get<{ v: number }>("k");
    assert.deepEqual(entry?.data, { v: 42 });
  });

  test("writing the same key replaces rather than duplicates", () => {
    const c = tempCache();
    c.put("k", "first", 60);
    c.put("k", "second", 60);
    assert.equal(c.get<string>("k")?.data, "second");
  });
});
