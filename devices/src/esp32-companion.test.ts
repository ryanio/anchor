import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FIRMWARE = join(dirname(fileURLToPath(import.meta.url)), "..", "firmware", "esp32");
const HAS_COMPILER = spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;

// The companion must never say a number the rest of the unit does not show, so CI runs its model.
test("the ESP32 companion reacts to the readings and says only what the feed formatted", {
  skip: !HAS_COMPILER && process.env.CI !== "true",
}, () => {
  assert.equal(HAS_COMPILER, true, "c++ is required to check the ESP32 companion in CI");
  const work = mkdtempSync(join(tmpdir(), "anchor-esp32-companion-"));
  try {
    const binary = join(work, "companion");
    execFileSync("c++", [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(FIRMWARE, "host", "companion.cpp"),
      "-o",
      binary,
    ]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }), "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
