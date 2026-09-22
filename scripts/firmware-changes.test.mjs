import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { affectsFirmware, classifyFirmwareChanges, classifyGitRange } from "./firmware-changes.mjs";

function inRepository(run) {
  const root = mkdtempSync(join(tmpdir(), "anchor-firmware-changes-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (path, contents, message) => {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
    git("add", "--", path);
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci@example.invalid");
    run({ root, git, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("firmware path classification", () => {
  test("selects source, shared headers, submodules, toolchains, and build inputs", () => {
    for (const path of [
      "devices/firmware/cardputer/app/src/anchor.cpp",
      "devices/firmware/common/feed.h",
      "devices/firmware/cardputer/flint",
      "devices/toolchain.json",
      "scripts/device.ts",
      "scripts/device-new-helper.ts",
      "package.json",
      "package-lock.json",
      ".node-version",
      ".gitmodules",
      ".github/workflows/ci.yml",
    ]) {
      assert.equal(affectsFirmware(path), true, path);
    }
  });

  test("skips documentation and known independent workspaces", () => {
    for (const path of [
      "CHANGELOG.md",
      "docs/devices.md",
      "service/src/index.ts",
      "executor/src/index.ts",
      "widget/Pulse.qml",
      "site/build.ts",
      "devices/src/panel.ts",
      "devices/package-lock.json",
    ]) {
      assert.equal(affectsFirmware(path), false, path);
    }
  });

  test("builds for unknown files instead of creating a silent coverage hole", () => {
    assert.equal(affectsFirmware("new-build-system/config.toml"), true);
    assert.deepEqual(classifyFirmwareChanges([]), { run: false, relevant: [] });
  });
});

describe("git range classification", () => {
  test("uses the supplied commits and preserves unusual filenames", () => {
    inRepository(({ root, git, commit }) => {
      const base = commit("README.md", "base\n", "base");
      const docsHead = commit("docs/name with spaces\nand newline.md", "docs\n", "docs");
      assert.equal(classifyGitRange(base, docsHead, root).run, false);

      git("checkout", "--quiet", "--detach", base);
      const firmwareHead = commit("devices/firmware/common/shared header.h", "#pragma once\n", "firmware");
      const result = classifyGitRange(base, firmwareHead, root);
      assert.equal(result.run, true);
      assert.deepEqual(result.relevant, ["devices/firmware/common/shared header.h"]);

      // Classification is tied to the supplied event SHAs, not the currently checked-out branch.
      assert.equal(classifyGitRange(base, docsHead, root).run, false);
    });
  });

  test("builds when a new-branch base or commit is unavailable", () => {
    const zero = "0".repeat(40);
    const missing = "1".repeat(40);
    assert.equal(classifyGitRange(zero, missing).run, true);
    assert.equal(classifyGitRange(missing, "2".repeat(40)).run, true);
  });

  test("a rename out of firmware still selects the build", () => {
    inRepository(({ root, git, commit }) => {
      const base = commit("devices/firmware/common/old.h", "#pragma once\n", "base");
      mkdirSync(join(root, "docs"), { recursive: true });
      git("mv", "devices/firmware/common/old.h", "docs/old.md");
      git("commit", "-m", "move documentation");
      const head = git("rev-parse", "HEAD");
      assert.equal(classifyGitRange(base, head, root).run, true);
    });
  });
});
