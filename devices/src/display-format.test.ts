import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("both handhelds format money and untrusted text with one shared, pinned implementation", () => {
  const work = mkdtempSync(join(tmpdir(), "anchor-display-format-"));
  try {
    const source = join(
      dirname(fileURLToPath(import.meta.url)),
      "../firmware/common/display_format_test.cpp",
    );
    const binary = join(work, "display-format");
    execFileSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }), "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
