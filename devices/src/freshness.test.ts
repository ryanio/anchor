import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("both handhelds describe a reading's age with one shared, wrap-safe function", () => {
  const work = mkdtempSync(join(tmpdir(), "anchor-freshness-"));
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), "../firmware/common/freshness_test.cpp");
    const binary = join(work, "freshness");
    execFileSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }), "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
