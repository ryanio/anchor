import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("firmware requests reject cancelled generations and keep their bounded slot", () => {
  const work = mkdtempSync(join(tmpdir(), "anchor-request-gate-"));
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), "../firmware/common/request_gate_test.cpp");
    const binary = join(work, "request-gate");
    execFileSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }), "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
