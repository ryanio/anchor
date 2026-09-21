import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "firmware", "cardputer", "app");

function compilerAvailable(): boolean {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

const HAS_COMPILER = compilerAvailable();
let workdir: string | null = null;
let binary: string | null = null;

describe("Cardputer token identity", { skip: !HAS_COMPILER && process.env.CI !== "true" }, () => {
  before(() => {
    assert.equal(HAS_COMPILER, true, "c++ is required to check Cardputer firmware identity in CI");
    workdir = mkdtempSync(join(tmpdir(), "anchor-cardputer-identity-"));
    binary = join(workdir, "token-identity");
    execFileSync(
      "c++",
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${join(APP, "src")}`,
        "-o",
        binary,
        join(APP, "host", "token_identity.cpp"),
      ],
      { stdio: "pipe" },
    );
  });

  after(() => {
    if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
  });

  test("chain and address together identify a detail", () => {
    const executable = binary;
    assert.ok(executable !== null);
    const result = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
