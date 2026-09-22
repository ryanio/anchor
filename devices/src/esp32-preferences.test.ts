import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRMWARE = join(HERE, "..", "firmware", "esp32");

function compilerAvailable(): boolean {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

const HAS_COMPILER = compilerAvailable();
let workdir: string | null = null;
let binary: string | null = null;

describe("ESP32 Preferences simulator", { skip: !HAS_COMPILER && process.env.CI !== "true" }, () => {
  before(() => {
    assert.equal(HAS_COMPILER, true, "c++ is required to check ESP32 Preferences in CI");
    workdir = mkdtempSync(join(tmpdir(), "anchor-esp32-preferences-"));
    binary = join(workdir, "preferences");
    execFileSync(
      "c++",
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${join(FIRMWARE, "sim", "include")}`,
        "-o",
        binary,
        join(FIRMWARE, "host", "preferences.cpp"),
        join(FIRMWARE, "sim", "src", "prefs_sim.cpp"),
      ],
      { stdio: "pipe" },
    );
  });

  after(() => {
    if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
  });

  test("round-trips the largest four-profile blob and scopes destructive operations", () => {
    assert.ok(binary !== null);
    assert.ok(workdir !== null);
    const result = spawnSync(binary, [join(workdir, "preferences.txt")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
