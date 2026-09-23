import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FIRMWARE = join(dirname(fileURLToPath(import.meta.url)), "..", "firmware", "esp32");
const HAS_COMPILER = spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;

// The keypad layout decides which characters a passphrase can contain, so CI must run it.
test("the ESP32 keypad reaches every printable ASCII character in three taps or fewer", {
  skip: !HAS_COMPILER && process.env.CI !== "true",
}, () => {
  assert.equal(HAS_COMPILER, true, "c++ is required to check the ESP32 keypad in CI");
  const work = mkdtempSync(join(tmpdir(), "anchor-esp32-keypad-"));
  try {
    const binary = join(work, "keypad");
    execFileSync("c++", [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(FIRMWARE, "host", "keypad.cpp"),
      "-o",
      binary,
    ]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }), "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
