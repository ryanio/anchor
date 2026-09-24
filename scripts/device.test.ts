import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNoLocalSecrets,
  assertSentinelBinary,
  cardputerLibraryInstallArgs,
  cardputerPlatformInstallArgs,
  concreteTargets,
  esp32CompileArgs,
  forEachTarget,
  loadToolchain,
  ProcessRunner,
  parseCli,
  pathsForRoot,
  platformioConfig,
  platformioEnvironment,
} from "./device.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI parser", () => {
  test("accepts one known command and one known target", () => {
    assert.deepEqual(parseCli(["build", "esp32"]), { command: "build", target: "esp32" });
    assert.deepEqual(parseCli(["sim", "all"]), { command: "sim", target: "all" });
  });

  test("rejects missing, extra, and unknown arguments with usage", () => {
    for (const args of [[], ["build"], ["flash", "esp32"], ["build", "cardputer", "extra"]]) {
      assert.throws(() => parseCli(args), /Usage: node scripts\/device\.ts/);
    }
  });
});

describe("tool isolation", () => {
  test("keeps PlatformIO state inside the selected checkout", () => {
    const paths = pathsForRoot("/work/anchor");
    const env = platformioEnvironment(paths);
    assert.equal(env.PLATFORMIO_CORE_DIR, "/work/anchor/.cache/device/platformio");
    assert.equal(env.PLATFORMIO_BUILD_DIR, "/work/anchor/.cache/device/build/platformio");
    assert.equal(env.PLATFORMIO_LIBDEPS_DIR, "/work/anchor/.cache/device/platformio/libdeps");
    assert.equal(env.PLATFORMIO_SETTING_ENABLE_TELEMETRY, "no");
    assert.equal(paths.arduino, "/work/anchor/.cache/device/arduino");
  });

  test("generates direct exact Cardputer constraints over flint's compatible ranges", () => {
    const manifest = loadToolchain(ROOT);
    const generated = platformioConfig(ROOT, pathsForRoot(ROOT), manifest);
    const config = readFileSync(generated, "utf8");
    for (const library of manifest.cardputer.libraries) assert.ok(config.includes(library), library);
    assert.ok(config.indexOf("m5stack/M5GFX@") < config.indexOf("m5stack/M5Unified@"));
    assert.ok(config.indexOf("m5stack/M5Unified@") < config.indexOf("m5stack/M5Cardputer@"));
    assert.equal(config.includes("project_dir ="), false, "project location comes from pio run -d");
    assert.equal(generated.endsWith("/anchor-cardputer-project/platformio.ini"), true);
  });

  test("installs the platform, then the exact Cardputer library closure without its dependencies", () => {
    const config = "/work/anchor/.cache/device/platformio/anchor-cardputer-project/platformio.ini";
    assert.deepEqual(cardputerPlatformInstallArgs(config, "cardputer-adv-anchor", "espressif32@6.12.0"), [
      "pkg",
      "install",
      "-d",
      "/work/anchor/.cache/device/platformio/anchor-cardputer-project",
      "--no-save",
      "-e",
      "cardputer-adv-anchor",
      "-p",
      "espressif32@6.12.0",
    ]);
    assert.deepEqual(
      cardputerLibraryInstallArgs(config, "cardputer-adv-anchor", [
        "m5stack/M5Cardputer@1.1.1",
        "m5stack/M5Unified@0.2.22",
      ]),
      [
        "pkg",
        "install",
        "-d",
        "/work/anchor/.cache/device/platformio/anchor-cardputer-project",
        "--no-save",
        "-e",
        "cardputer-adv-anchor",
        "--skip-dependencies",
        "-l",
        "m5stack/M5Cardputer@1.1.1",
        "-l",
        "m5stack/M5Unified@0.2.22",
      ],
    );
  });
});

describe("build command construction", () => {
  test("the ESP32 compile selects only the pinned GFX vendor library", () => {
    const manifest = loadToolchain(ROOT);
    const paths = pathsForRoot(ROOT);
    const args = esp32CompileArgs(ROOT, paths, manifest, join(paths.build, "test"), true);
    const library = args.indexOf("--library");
    assert.ok(library >= 0);
    assert.equal(args.includes("--libraries"), false);
    assert.equal(
      args[library + 1],
      join(paths.waveshare, "examples/arduino-v2/libraries/GFX_Library_for_Arduino"),
    );
    assert.ok(args.includes(manifest.esp32.fqbn));
    assert.ok(args.includes(join(ROOT, manifest.esp32.sketch)));
  });
});

describe("failure behavior", () => {
  test("all has a stable order and stops at the first failure", () => {
    assert.deepEqual(concreteTargets("all"), ["cardputer", "esp32"]);
    const visited: string[] = [];
    assert.throws(
      () =>
        forEachTarget("all", (target) => {
          visited.push(target);
          throw new Error("first target failed");
        }),
      /first target failed/,
    );
    assert.deepEqual(visited, ["cardputer"]);
  });

  test("the process boundary reports nonzero exits and missing prerequisites", () => {
    const runner = new ProcessRunner();
    assert.throws(() => runner.run(process.execPath, ["-e", "process.exit(7)"], { quiet: true }), /status 7/);
    assert.throws(
      () => runner.run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { quiet: true }),
      /terminated by SIGTERM/,
    );
    assert.throws(
      () => runner.run("anchor-device-command-that-does-not-exist", [], { quiet: true }),
      /Missing prerequisite/,
    );
  });

  test("a stalled simulator is bounded by the process timeout", () => {
    const runner = new ProcessRunner();
    assert.throws(
      () =>
        runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { quiet: true, timeoutMs: 100 }),
      /timed out after 100 ms/,
    );
  });

  test("CI sentinel refuses source-tree credential files without reading them", () => {
    const root = mkdtempSync(join(tmpdir(), "anchor-device-secrets-test-"));
    try {
      const secret = join(root, "devices/firmware/esp32/app/secrets.h");
      mkdirSync(dirname(secret), { recursive: true });
      writeFileSync(secret, "this does not need to be valid or read");
      assert.throws(() => assertNoLocalSecrets(root, "esp32"), /refuses local credential files/);
      assert.doesNotThrow(() => assertNoLocalSecrets(root, "cardputer"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CI sentinel requires the placeholder in the linked firmware", () => {
    const root = mkdtempSync(join(tmpdir(), "anchor-device-binary-test-"));
    try {
      const firmware = join(root, "firmware.bin");
      writeFileSync(firmware, Buffer.from("binary anchor-ci-compile-placeholder binary"));
      assert.doesNotThrow(() => assertSentinelBinary(firmware));
      writeFileSync(firmware, Buffer.from("network code was compiled out"));
      assert.throws(() => assertSentinelBinary(firmware), /compile sentinel is absent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
