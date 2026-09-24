import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyFirmwareChanges, classifyGitRange, firmwareTargetsForPath } from "./firmware-changes.mjs";

const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

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
      assert.equal(classifyFirmwareChanges([path]).run, true, path);
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
      assert.equal(classifyFirmwareChanges([path]).run, false, path);
    }
  });

  test("selects only the target whose private inputs changed", () => {
    const paths = [
      "devices/firmware/cardputer/app/src/anchor.cpp",
      "devices/firmware/esp32/pulse/pulse.ino",
      "docs/device-development.md",
    ];

    assert.deepEqual(classifyFirmwareChanges(paths, "cardputer"), {
      run: true,
      relevant: ["devices/firmware/cardputer/app/src/anchor.cpp"],
    });
    assert.deepEqual(classifyFirmwareChanges(paths, "esp32"), {
      run: true,
      relevant: ["devices/firmware/esp32/pulse/pulse.ino"],
    });
    assert.deepEqual(classifyFirmwareChanges([paths[0]], "esp32"), { run: false, relevant: [] });
    assert.deepEqual(classifyFirmwareChanges([]), { run: false, relevant: [] });
  });

  test("selects both targets for shared, tooling, root, and unknown inputs", () => {
    for (const path of [
      "devices/firmware/common/request_gate.h",
      "scripts/device.ts",
      "devices/toolchain.json",
      "new-build-system/config.toml",
    ]) {
      assert.deepEqual(firmwareTargetsForPath(path), ["cardputer", "esp32"], path);
      assert.equal(classifyFirmwareChanges([path], "cardputer").run, true, path);
      assert.equal(classifyFirmwareChanges([path], "esp32").run, true, path);
    }
  });

  test("rejects an unknown target so the workflow fails safe to a build", () => {
    assert.throws(() => classifyFirmwareChanges(["docs/devices.md"], "other"), /Unknown firmware target/);
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

  test("classifies target-specific git ranges independently", () => {
    inRepository(({ root, git, commit }) => {
      const base = commit("README.md", "base\n", "base");
      const cardputerHead = commit(
        "devices/firmware/cardputer/app/src/main.cpp",
        "int main() {}\n",
        "cardputer",
      );
      assert.equal(classifyGitRange(base, cardputerHead, root, "cardputer").run, true);
      assert.equal(classifyGitRange(base, cardputerHead, root, "esp32").run, false);

      git("checkout", "--quiet", "--detach", base);
      const esp32Head = commit("devices/firmware/esp32/pulse/pulse.ino", "void setup() {}\n", "esp32");
      assert.equal(classifyGitRange(base, esp32Head, root, "cardputer").run, false);
      assert.equal(classifyGitRange(base, esp32Head, root, "esp32").run, true);
    });
  });
});

describe("firmware workflow", () => {
  test("parses as YAML and runs each selected target in its own matrix job", () => {
    execFileSync("ruby", ["-e", 'require "yaml"; YAML.parse_file(ARGV.fetch(0))', workflowPath]);

    const workflow = readFileSync(workflowPath, "utf8");
    assert.match(workflow, /target: \[cardputer, esp32\]/);
    assert.ok(workflow.includes(`firmware-changes.mjs "$BASE_SHA" "$HEAD_SHA" "\${{ matrix.target }}"`));
    for (const command of ["bootstrap", "doctor", "build", "sim"]) {
      assert.ok(workflow.includes(`node scripts/device.ts ${command} \${{ matrix.target }}`), command);
      assert.ok(!workflow.includes(`node scripts/device.ts ${command} all`), command);
    }
    assert.match(workflow, /anchor-firmware-cardputer-/);
    assert.match(workflow, /anchor-firmware-esp32-/);
  });
});
