#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapNativeArduinoCtags,
  nativeArduinoCtagsBuildProperty,
  needsNativeArduinoCtags,
  verifyNativeArduinoCtags,
} from "./device-ctags.ts";

export const COMMANDS = ["doctor", "bootstrap", "build", "sim"] as const;
export const TARGETS = ["cardputer", "esp32", "all"] as const;

export type DeviceCommand = (typeof COMMANDS)[number];
export type DeviceTarget = (typeof TARGETS)[number];
type ConcreteTarget = Exclude<DeviceTarget, "all">;

export interface Toolchain {
  schemaVersion: number;
  tools: {
    nodeMajor: number;
    arduinoCli: { version: string; linuxX64Sha256: string };
    platformioCore: string;
    nativeArduinoCtags: { repository: string; commit: string; version: string };
  };
  cardputer: {
    submodule: { path: string; commit: string };
    project: string;
    boardEnvironment: string;
    simEnvironment: string;
    platforms: { board: string; sim: string };
    libraries: string[];
  };
  esp32: {
    sketch: string;
    fqbn: string;
    boardManagerUrl: string;
    core: string;
    libraries: string[];
    gfxVendor: { repository: string; commit: string; path: string; version: string };
  };
}

export interface DevicePaths {
  root: string;
  cache: string;
  build: string;
  sim: string;
  platformio: string;
  platformioLibdeps: string;
  arduino: string;
  arduinoConfig: string;
  arduinoData: string;
  arduinoDownloads: string;
  arduinoUser: string;
  vendor: string;
  waveshare: string;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): string;
}

const sourceFile = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(sourceFile), "..");
const SENTINEL_API_KEY = "anchor-ci-compile-placeholder";

function usage(): string {
  return [
    "Usage: node scripts/device.ts <doctor|bootstrap|build|sim> <cardputer|esp32|all>",
    "",
    "Examples:",
    "  node scripts/device.ts bootstrap all",
    "  node scripts/device.ts build esp32",
    "  CI=true node scripts/device.ts build all  # also compile-checks active API paths",
  ].join("\n");
}

export function parseCli(args: string[]): { command: DeviceCommand; target: DeviceTarget } {
  if (
    args.length !== 2 ||
    !COMMANDS.includes(args[0] as DeviceCommand) ||
    !TARGETS.includes(args[1] as DeviceTarget)
  ) {
    throw new Error(usage());
  }
  return { command: args[0] as DeviceCommand, target: args[1] as DeviceTarget };
}

export function pathsForRoot(root: string): DevicePaths {
  const cache = join(root, ".cache", "device");
  const arduino = join(cache, "arduino");
  const platformio = join(cache, "platformio");
  const vendor = join(cache, "vendor");
  return {
    root,
    cache,
    build: join(cache, "build"),
    sim: join(cache, "sim"),
    platformio,
    platformioLibdeps: join(platformio, "libdeps"),
    arduino,
    arduinoConfig: join(arduino, "arduino-cli.yaml"),
    arduinoData: join(arduino, "data"),
    arduinoDownloads: join(arduino, "downloads"),
    arduinoUser: join(arduino, "user"),
    vendor,
    waveshare: join(vendor, "waveshare"),
  };
}

export function platformioEnvironment(
  paths: DevicePaths,
  buildDir = join(paths.build, "platformio"),
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLATFORMIO_CORE_DIR: paths.platformio,
    PLATFORMIO_BUILD_DIR: buildDir,
    PLATFORMIO_LIBDEPS_DIR: paths.platformioLibdeps,
    PLATFORMIO_SETTING_ENABLE_TELEMETRY: "no",
  };
}

export function loadToolchain(root: string): Toolchain {
  const parsed = JSON.parse(readFileSync(join(root, "devices", "toolchain.json"), "utf8")) as Toolchain;
  if (parsed.schemaVersion !== 1)
    throw new Error(`Unsupported devices/toolchain.json schema ${parsed.schemaVersion}`);
  return parsed;
}

function quoted(command: string, args: string[]): string {
  const quote = (part: string) => (/^[A-Za-z0-9_./:=@,+-]+$/.test(part) ? part : JSON.stringify(part));
  return [command, ...args].map(quote).join(" ");
}

export class ProcessRunner implements CommandRunner {
  run(command: string, args: string[], options: RunOptions = {}): string {
    if (!options.quiet) console.log(`$ ${quoted(command, args)}`);
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!options.quiet && output) process.stdout.write(output);
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Missing prerequisite: ${command}. Run 'node scripts/device.ts doctor all' for setup guidance.`,
        );
      }
      if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw new Error(`${command} timed out after ${options.timeoutMs} ms`);
      }
      throw result.error;
    }
    if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
    if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
    return output;
  }
}

function executable(root: string, envName: string, localCandidates: string[], fallback: string): string {
  const override = process.env[envName];
  if (override) return override;
  for (const candidate of localCandidates) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  return fallback;
}

function tools(root: string): { arduino: string; pio: string } {
  return {
    arduino: executable(
      root,
      "ANCHOR_ARDUINO_CLI",
      [".cache/device/bin/arduino-cli", ".cache/tools/bin/arduino-cli"],
      "arduino-cli",
    ),
    pio: executable(
      root,
      "ANCHOR_PIO",
      [".cache/device/platformio/venv/bin/pio", ".cache/tools/pio-venv/bin/pio"],
      "pio",
    ),
  };
}

function requireOutput(output: string, expected: string, description: string): void {
  if (!output.includes(expected))
    throw new Error(`${description}: expected ${JSON.stringify(expected)} in command output`);
}

function versionOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  if (at < 0) throw new Error(`Expected a pinned package, got ${spec}`);
  return spec.slice(at + 1);
}

function configureArduino(paths: DevicePaths, manifest: Toolchain): void {
  for (const path of [paths.arduino, paths.arduinoData, paths.arduinoDownloads, paths.arduinoUser])
    mkdirSync(path, { recursive: true });
  const config = {
    board_manager: { additional_urls: [manifest.esp32.boardManagerUrl] },
    directories: { data: paths.arduinoData, downloads: paths.arduinoDownloads, user: paths.arduinoUser },
  };
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (!existsSync(paths.arduinoConfig) || readFileSync(paths.arduinoConfig, "utf8") !== text) {
    writeFileSync(paths.arduinoConfig, text, { mode: 0o600 });
  }
}

function arduinoArgs(paths: DevicePaths, args: string[]): string[] {
  return ["--config-file", paths.arduinoConfig, "--no-color", ...args];
}

function verifyNode(manifest: Toolchain, runner: CommandRunner): void {
  const node = runner.run(process.execPath, ["--version"], { quiet: true });
  requireOutput(node, `v${manifest.tools.nodeMajor}.`, "Node version mismatch");
}

function verifyArduinoTool(root: string, manifest: Toolchain, runner: CommandRunner): void {
  verifyNode(manifest, runner);
  const output = runner.run(tools(root).arduino, ["version"], { quiet: true });
  requireOutput(output, manifest.tools.arduinoCli.version, "arduino-cli version mismatch");
}

function verifyPlatformioTool(
  root: string,
  paths: DevicePaths,
  manifest: Toolchain,
  runner: CommandRunner,
): void {
  verifyNode(manifest, runner);
  const output = runner.run(tools(root).pio, ["--version"], {
    env: platformioEnvironment(paths),
    quiet: true,
  });
  requireOutput(output, manifest.tools.platformioCore, "PlatformIO Core version mismatch");
}

export function platformioConfig(root: string, paths: DevicePaths, manifest: Toolchain): string {
  mkdirSync(paths.platformio, { recursive: true });
  const project = join(root, manifest.cardputer.project);
  const sourceConfig = join(project, "platformio.ini");
  const flintConfig = join(project, "flint", "flint.ini");
  let config = readFileSync(sourceConfig, "utf8");
  config = config.replace("extra_configs = flint/flint.ini", `extra_configs = ${flintConfig}`);
  if (!config.includes(`extra_configs = ${flintConfig}`)) {
    throw new Error("Could not generate the pinned Cardputer PlatformIO configuration");
  }
  // Resolve the pinned dependency closure before M5Cardputer. Its broad transitive ranges otherwise
  // make PlatformIO install newer M5Unified and M5GFX copies before it reaches our direct pins.
  const dependencyOrder = ["M5GFX", "M5Unified", "IRremote", "M5Cardputer"];
  const boardLibraries = manifest.cardputer.libraries
    .map((library, originalIndex) => ({
      library,
      order: dependencyOrder.findIndex((name) => library.includes(`/${name}@`)),
      originalIndex,
    }))
    .sort((left, right) => {
      const leftOrder = left.order < 0 ? dependencyOrder.length : left.order;
      const rightOrder = right.order < 0 ? dependencyOrder.length : right.order;
      return leftOrder - rightOrder || left.originalIndex - right.originalIndex;
    })
    .map(({ library }) => library)
    .join("\n\t");
  const simLibraries = manifest.cardputer.libraries
    .filter((lib) => lib.includes("M5GFX") || lib.includes("ArduinoJson"))
    .join("\n\t");
  config = config.replace(
    `[env:${manifest.cardputer.boardEnvironment}]\n`,
    [
      `[env:${manifest.cardputer.boardEnvironment}]`,
      `platform = ${manifest.cardputer.platforms.board}`,
      "lib_deps =",
      `\t${boardLibraries}`,
      "",
    ].join("\n"),
  );
  config = config.replace(
    `[env:${manifest.cardputer.simEnvironment}]\n`,
    [
      `[env:${manifest.cardputer.simEnvironment}]`,
      `platform = ${manifest.cardputer.platforms.sim}`,
      "lib_deps =",
      `\t${simLibraries}`,
      "",
    ].join("\n"),
  );
  if (
    !config.includes(`platform = ${manifest.cardputer.platforms.board}`) ||
    !config.includes(`platform = ${manifest.cardputer.platforms.sim}`)
  ) {
    throw new Error("Could not add exact packages to the Cardputer PlatformIO environments");
  }
  const generated = join(paths.platformio, "anchor-cardputer-project", "platformio.ini");
  mkdirSync(dirname(generated), { recursive: true });
  if (!existsSync(generated) || readFileSync(generated, "utf8") !== config) writeFileSync(generated, config);
  return generated;
}

export function cardputerPlatformInstallArgs(
  config: string,
  environment: string,
  platform: string,
): string[] {
  return ["pkg", "install", "-d", dirname(config), "--no-save", "-e", environment, "-p", platform];
}

export function cardputerLibraryInstallArgs(
  config: string,
  environment: string,
  libraries: string[],
): string[] {
  return [
    "pkg",
    "install",
    "-d",
    dirname(config),
    "--no-save",
    "-e",
    environment,
    "--skip-dependencies",
    ...libraries.flatMap((library) => ["-l", library]),
  ];
}

function bootstrapFlint(root: string, manifest: Toolchain, runner: CommandRunner): void {
  runner.run(
    "git",
    ["submodule", "update", "--init", "--recursive", "--checkout", manifest.cardputer.submodule.path],
    { cwd: root },
  );
  const actual = runner
    .run("git", ["-C", join(root, manifest.cardputer.submodule.path), "rev-parse", "HEAD"], { quiet: true })
    .trim();
  if (actual !== manifest.cardputer.submodule.commit) {
    throw new Error(`flint is ${actual}, expected ${manifest.cardputer.submodule.commit}`);
  }
}

function verifyFlint(root: string, manifest: Toolchain, runner: CommandRunner): void {
  const path = join(root, manifest.cardputer.submodule.path);
  if (!existsSync(join(path, ".git")))
    throw new Error("flint submodule is missing; run device bootstrap cardputer");
  const actual = runner.run("git", ["-C", path, "rev-parse", "HEAD"], { quiet: true }).trim();
  if (actual !== manifest.cardputer.submodule.commit) {
    throw new Error(
      `flint is ${actual}, expected ${manifest.cardputer.submodule.commit}; run device bootstrap cardputer`,
    );
  }
}

function bootstrapWaveshare(paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  const vendor = manifest.esp32.gfxVendor;
  mkdirSync(paths.vendor, { recursive: true });
  if (!existsSync(join(paths.waveshare, ".git"))) {
    if (existsSync(paths.waveshare) && readdirSync(paths.waveshare).length > 0) {
      throw new Error(`${paths.waveshare} exists but is not a Git checkout; move it aside and retry`);
    }
    mkdirSync(paths.waveshare, { recursive: true });
    runner.run("git", ["init"], { cwd: paths.waveshare });
    runner.run("git", ["remote", "add", "origin", vendor.repository], { cwd: paths.waveshare });
    runner.run("git", ["sparse-checkout", "init", "--cone"], { cwd: paths.waveshare });
    runner.run("git", ["sparse-checkout", "set", vendor.path], { cwd: paths.waveshare });
  }
  runner.run("git", ["fetch", "--depth=1", "origin", vendor.commit], { cwd: paths.waveshare });
  runner.run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: paths.waveshare });
  verifyWaveshare(paths, manifest, runner);
}

function verifyWaveshare(paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  const vendor = manifest.esp32.gfxVendor;
  const actual = runner.run("git", ["rev-parse", "HEAD"], { cwd: paths.waveshare, quiet: true }).trim();
  if (actual !== vendor.commit)
    throw new Error(`Waveshare vendor checkout is ${actual}, expected ${vendor.commit}`);
  const properties = readFileSync(join(paths.waveshare, vendor.path, "library.properties"), "utf8");
  requireOutput(properties, `version=${vendor.version}`, "Waveshare GFX version mismatch");
}

function bootstrapCardputer(
  root: string,
  paths: DevicePaths,
  manifest: Toolchain,
  runner: CommandRunner,
): void {
  bootstrapFlint(root, manifest, runner);
  const config = platformioConfig(root, paths, manifest);
  const { pio } = tools(root);
  runner.run(
    pio,
    cardputerPlatformInstallArgs(
      config,
      manifest.cardputer.boardEnvironment,
      manifest.cardputer.platforms.board,
    ),
    { env: platformioEnvironment(paths) },
  );
  runner.run(
    pio,
    cardputerLibraryInstallArgs(config, manifest.cardputer.boardEnvironment, manifest.cardputer.libraries),
    { env: platformioEnvironment(paths) },
  );
  const simLibraries = manifest.cardputer.libraries.filter(
    (library) => library.includes("M5GFX") || library.includes("ArduinoJson"),
  );
  runner.run(
    pio,
    cardputerPlatformInstallArgs(config, manifest.cardputer.simEnvironment, manifest.cardputer.platforms.sim),
    { env: platformioEnvironment(paths) },
  );
  runner.run(pio, cardputerLibraryInstallArgs(config, manifest.cardputer.simEnvironment, simLibraries), {
    env: platformioEnvironment(paths),
  });
}

function bootstrapEsp32(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  configureArduino(paths, manifest);
  const { arduino } = tools(root);
  runner.run(arduino, arduinoArgs(paths, ["core", "update-index"]));
  runner.run(arduino, arduinoArgs(paths, ["core", "install", manifest.esp32.core]));
  runner.run(arduino, arduinoArgs(paths, ["lib", "update-index"]));
  runner.run(arduino, arduinoArgs(paths, ["lib", "install", ...manifest.esp32.libraries]));
  bootstrapNativeArduinoCtags(root, manifest.tools.nativeArduinoCtags, runner);
  bootstrapWaveshare(paths, manifest, runner);
}

function propertyVersion(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = /^version=(.+)$/m.exec(text);
  if (!match?.[1]) throw new Error(`${path} has no version property`);
  return match[1].trim();
}

function jsonVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  if (!parsed.version) throw new Error(`${path} has no version`);
  return parsed.version;
}

function verifyPlatformioPackages(paths: DevicePaths, manifest: Toolchain): void {
  const platform = (spec: string) => spec.slice(0, spec.lastIndexOf("@"));
  for (const spec of [manifest.cardputer.platforms.board, manifest.cardputer.platforms.sim]) {
    const name = platform(spec);
    const actual = jsonVersion(join(paths.platformio, "platforms", name, "platform.json"));
    if (actual !== versionOf(spec))
      throw new Error(`PlatformIO ${name} is ${actual}, expected ${versionOf(spec)}`);
  }
  for (const spec of manifest.cardputer.libraries) {
    const name = platform(spec).split("/").at(-1) as string;
    const actual = propertyVersion(
      join(paths.platformioLibdeps, manifest.cardputer.boardEnvironment, name, "library.properties"),
    );
    if (actual !== versionOf(spec)) throw new Error(`${name} is ${actual}, expected ${versionOf(spec)}`);
  }
  for (const spec of manifest.cardputer.libraries.filter(
    (lib) => lib.includes("M5GFX") || lib.includes("ArduinoJson"),
  )) {
    const name = platform(spec).split("/").at(-1) as string;
    const actual = propertyVersion(
      join(paths.platformioLibdeps, manifest.cardputer.simEnvironment, name, "library.properties"),
    );
    if (actual !== versionOf(spec))
      throw new Error(`${name} simulator library is ${actual}, expected ${versionOf(spec)}`);
  }
}

function doctorCardputer(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  verifyFlint(root, manifest, runner);
  platformioConfig(root, paths, manifest);
  verifyPlatformioPackages(paths, manifest);
  const sdl = runner.run("sdl2-config", ["--version"], { quiet: true }).trim();
  console.log(
    `cardputer: PlatformIO ${manifest.tools.platformioCore}; ${manifest.cardputer.platforms.board}; ${manifest.cardputer.platforms.sim}; SDL ${sdl}; ${manifest.cardputer.boardEnvironment} + ${manifest.cardputer.simEnvironment}`,
  );
}

function doctorEsp32(paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  configureArduino(paths, manifest);
  const coreVersion = versionOf(manifest.esp32.core);
  const platform = join(
    paths.arduinoData,
    "packages",
    "esp32",
    "hardware",
    "esp32",
    coreVersion,
    "platform.txt",
  );
  if (!existsSync(platform))
    throw new Error(`Arduino core ${manifest.esp32.core} is not installed at ${platform}`);
  for (const spec of manifest.esp32.libraries) {
    const name = spec.slice(0, spec.lastIndexOf("@"));
    const actual = propertyVersion(join(paths.arduinoUser, "libraries", name, "library.properties"));
    if (actual !== versionOf(spec)) throw new Error(`${name} is ${actual}, expected ${versionOf(spec)}`);
  }
  verifyWaveshare(paths, manifest, runner);
  verifyNativeArduinoCtags(paths.root, manifest.tools.nativeArduinoCtags, runner);
  for (const compiler of ["cc", "c++"]) runner.run(compiler, ["--version"], { quiet: true });
  const doctorBuild = join(paths.build, "doctor");
  const source = join(doctorBuild, "archive-probe.c");
  const object = join(doctorBuild, "archive-probe.o");
  const archive = join(doctorBuild, "libanchor-device-doctor.a");
  mkdirSync(doctorBuild, { recursive: true });
  writeFileSync(source, "int anchor_device_archive_probe(void) { return 0; }\n");
  try {
    runner.run("cc", ["-c", source, "-o", object], { quiet: true });
    runner.run("ar", ["rcs", archive, object], { quiet: true });
    if (!existsSync(archive)) throw new Error("ar reported success without creating an archive");
  } finally {
    for (const path of [source, object, archive]) rmSync(path, { force: true });
  }
  const ctags = needsNativeArduinoCtags()
    ? `; native ctags ${manifest.tools.nativeArduinoCtags.version}`
    : "";
  console.log(
    `esp32: Arduino CLI ${manifest.tools.arduinoCli.version}; ${manifest.esp32.core}; GFX ${manifest.esp32.gfxVendor.version}; C/C++/ar ready${ctags}; ${manifest.esp32.fqbn}`,
  );
}

function sentinelHeader(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const header = join(directory, "secrets.h");
  writeFileSync(
    header,
    [
      "#pragma once",
      '#pragma message("ANCHOR_DEVICE_NETWORK_SENTINEL")',
      `#define OPENSEA_API_KEY "${SENTINEL_API_KEY}"`,
      '#define WIFI_SSID "anchor-ci-placeholder"',
      '#define WIFI_PASSWORD "anchor-ci-placeholder"',
      '#define ANCHOR_WALLETS "0x0000000000000000000000000000000000000000"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return directory;
}

export function assertSentinelBinary(path: string): void {
  const firmware = readFileSync(path);
  if (!firmware.includes(Buffer.from(SENTINEL_API_KEY))) {
    throw new Error(`Active-network compile sentinel is absent from ${path}`);
  }
}

function withIncludePath(env: NodeJS.ProcessEnv, include: string): NodeJS.ProcessEnv {
  return { ...env, CPATH: env.CPATH ? `${include}:${env.CPATH}` : include };
}

export function assertNoLocalSecrets(root: string, target: ConcreteTarget): void {
  const candidates =
    target === "cardputer"
      ? [
          "devices/firmware/cardputer/app/src/secrets.h",
          "devices/firmware/cardputer/flint/include/secrets.h",
          "devices/firmware/cardputer/flint/src/secrets.h",
        ]
      : ["devices/firmware/esp32/app/secrets.h", "devices/firmware/esp32/pulse/secrets.h"];
  const found = candidates.filter((candidate) => existsSync(join(root, candidate)));
  if (found.length > 0) {
    throw new Error(
      `CI compile sentinel refuses local credential files: ${found.join(", ")}. Move them aside before running CI=true.`,
    );
  }
}

function buildCardputer(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  if (process.env.CI === "true") assertNoLocalSecrets(root, "cardputer");
  const { pio } = tools(root);
  verifyFlint(root, manifest, runner);
  verifyPlatformioPackages(paths, manifest);
  const config = platformioConfig(root, paths, manifest);
  runner.run(
    pio,
    [
      "run",
      "-d",
      join(root, manifest.cardputer.project),
      "-c",
      config,
      "-e",
      manifest.cardputer.boardEnvironment,
    ],
    { env: platformioEnvironment(paths) },
  );
  if (process.env.CI !== "true") return;

  const sentinel = join(paths.build, "cardputer-sentinel");
  rmSync(sentinel, { recursive: true, force: true });
  try {
    const include = sentinelHeader(join(sentinel, "include"));
    const output = runner.run(
      pio,
      [
        "run",
        "-d",
        join(root, manifest.cardputer.project),
        "-c",
        config,
        "-e",
        manifest.cardputer.boardEnvironment,
      ],
      {
        env: withIncludePath(platformioEnvironment(paths, join(sentinel, "out")), include),
      },
    );
    requireOutput(
      output,
      "ANCHOR_DEVICE_NETWORK_SENTINEL",
      "Cardputer active-network compile sentinel was not included",
    );
    requireOutput(output, "standalone.cpp", "Cardputer active-network source was not compiled");
    assertSentinelBinary(join(sentinel, "out", manifest.cardputer.boardEnvironment, "firmware.bin"));
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
}

export function esp32CompileArgs(
  root: string,
  paths: DevicePaths,
  manifest: Toolchain,
  build: string,
  verbose = false,
): string[] {
  const vendorLibraries = join(paths.waveshare, dirname(manifest.esp32.gfxVendor.path));
  return arduinoArgs(paths, [
    "compile",
    ...(verbose ? ["--verbose"] : []),
    ...nativeArduinoCtagsBuildProperty(root),
    "--fqbn",
    manifest.esp32.fqbn,
    "--library",
    join(vendorLibraries, "GFX_Library_for_Arduino"),
    "--build-path",
    build,
    join(root, manifest.esp32.sketch),
  ]);
}

function buildEsp32(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  if (process.env.CI === "true") assertNoLocalSecrets(root, "esp32");
  const { arduino } = tools(root);
  doctorEsp32(paths, manifest, runner);
  const build = join(paths.build, "esp32");
  runner.run(arduino, esp32CompileArgs(root, paths, manifest, build));
  if (process.env.CI !== "true") return;

  const sentinel = join(paths.build, "esp32-sentinel");
  rmSync(sentinel, { recursive: true, force: true });
  try {
    const include = sentinelHeader(join(sentinel, "include"));
    const output = runner.run(arduino, esp32CompileArgs(root, paths, manifest, join(sentinel, "out"), true), {
      env: withIncludePath(process.env, include),
    });
    requireOutput(
      output,
      "ANCHOR_DEVICE_NETWORK_SENTINEL",
      "ESP32 active-network compile sentinel was not included",
    );
    requireOutput(output, "feed_link.cpp", "ESP32 active-network source was not compiled");
    requireOutput(output, "ArduinoJson", "ESP32 active-network parser dependency was not compiled");
    assertSentinelBinary(join(sentinel, "out", "pulse.ino.bin"));
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
}

function assertShot(directory: string): void {
  const shot = readdirSync(directory).find((name) => name.endsWith(".ppm") || name.endsWith(".png"));
  if (!shot || statSync(join(directory, shot)).size === 0)
    throw new Error(`Simulator wrote no frame under ${directory}`);
}

function simCardputer(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  const output = join(paths.sim, "cardputer");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const env = { ...platformioEnvironment(paths), SDL_VIDEODRIVER: process.env.SDL_VIDEODRIVER ?? "dummy" };
  verifyFlint(root, manifest, runner);
  verifyPlatformioPackages(paths, manifest);
  const config = platformioConfig(root, paths, manifest);
  runner.run(
    tools(root).pio,
    [
      "run",
      "-d",
      join(root, manifest.cardputer.project),
      "-c",
      config,
      "-e",
      manifest.cardputer.simEnvironment,
    ],
    { env },
  );
  const binary = join(env.PLATFORMIO_BUILD_DIR as string, manifest.cardputer.simEnvironment, "program");
  runner.run(binary, ["--shot", join(output, "anchor"), "--quit-after", "1000"], {
    cwd: output,
    env,
    timeoutMs: 30_000,
  });
  assertShot(output);
}

function keypadTaps(points: string[]): string[] {
  return points.flatMap((point) => ["--tap", point]);
}

function simEsp32(root: string, paths: DevicePaths, manifest: Toolchain, runner: CommandRunner): void {
  doctorEsp32(paths, manifest, runner);
  const output = join(paths.sim, "esp32");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const gfx = join(paths.waveshare, manifest.esp32.gfxVendor.path, "src");
  const lvgl = join(paths.arduinoUser, "libraries", "lvgl");
  runner.run(
    "bash",
    [
      join(root, "devices", "firmware", "esp32", "sim", "lvgl.sh"),
      "--shot",
      join(output, "pulse"),
      "--quit-after",
      "1000",
    ],
    { env: { ...process.env, ANCHOR_GFX_DIR: gfx, ANCHOR_LVGL_DIR: lvgl } },
  );
  assertShot(output);
  // The trending reader both firmwares share, over a captured live response. It needs ArduinoJson,
  // which bootstrap installs and the plain unit-test job does not have, so it runs here.
  const trendingTest = join(output, "trending-rows");
  runner.run("c++", [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(paths.arduinoUser, "libraries", "ArduinoJson", "src")}`,
    join(root, "devices", "firmware", "common", "trending_rows_test.cpp"),
    "-o",
    trendingTest,
  ]);
  runner.run(trendingTest, [
    join(root, "devices", "firmware", "common", "fixtures", "trending-2026-09-23.json"),
  ]);
  // Exercise the real LVGL screens with scripted input. Fixture data and credentials only.
  const binary = join(root, "devices", "firmware", "esp32", "sim", "build", "pulse-lvgl-sim");
  const cases = [
    { name: "explore", taps: "295,46", labels: ["Explore", "STONK  $0.2400", "solana | -4.58%"] },
    { name: "token", taps: "295,46 135,148", labels: ["STONK", "Price", "$0.2400"] },
    {
      name: "lost-detail",
      thenFeed: "lost",
      taps: "295,46 135,148",
      labels: ["STONK", "Price", "$0.2400"],
      extra: ["--expect-visible-prefix", "Saved / stale |"],
    },
    { name: "back", taps: "295,46 135,148 70,398", labels: ["Explore"] },
    { name: "portfolio", taps: "295,46 180,398", labels: ["Portfolio", "Total | 6 of 6 wallets", "$3,125"] },
    {
      name: "partial",
      feed: "portfolio-partial",
      taps: "295,46 180,398",
      labels: ["Portfolio", "Total | 4 of 6 wallets", "$3,033"],
    },
    { name: "wifi", taps: "295,46 295,398", labels: ["Wi-Fi", "Rescan", "Hidden"] },
    // Network names must be readable whole. At the larger row font the signal and security text
    // once shared the name's line and cut "Skylark Cafe" to "Skylar...".
    {
      name: "wifi-names",
      networks: "HomeNet:-42,Skylark Cafe:-58:open",
      taps: "295,46 295,398",
      labels: ["HomeNet", "Skylark Cafe", "-58 dBm  open"],
    },
    {
      name: "forget-cancel",
      taps: "295,46 295,398",
      extra: ["--wait", "--tap", "130,185", "--tap", "270,320"],
      labels: ["Wi-Fi", "Forget saved networks..."],
      savedAfter: true,
    },
    {
      name: "forget-confirm",
      taps: "295,46 295,398",
      extra: ["--wait", "--tap", "130,185", "--tap", "90,320"],
      labels: ["Wi-Fi"],
      savedAfter: false,
    },
    // The keypad, end to end: a hidden network's name and then its passphrase, typed through
    // groups, both cases, a symbol, and digits. The saved profile must hold exactly what was typed.
    {
      name: "keypad-chooser",
      taps: "295,46 295,398",
      extra: ["--wait", "--tap", "180,398", "--tap", "304,254"],
      labels: ["Hidden network"],
    },
    {
      name: "keypad-join",
      taps: "295,46 295,398",
      extra: [
        "--wait",
        "--tap",
        "180,398",
        // "Demo": D from def's upper row, then e, m, o. Next.
        ...keypadTaps([
          "184,183",
          "49,290",
          "184,183",
          "184,195",
          "184,254",
          "64,195",
          "184,254",
          "304,195",
          "319,396",
        ]),
        // "Pass-123": P, a, s, s; the symbol page's ". , - _" for "-"; letters, digits, 1 2 3. Join.
        ...keypadTaps([
          "304,254",
          "49,290",
          "64,183",
          "64,195",
          "304,254",
          "319,195",
          "304,254",
          "319,195",
          "139,396",
          "64,183",
          "229,219",
          "49,396",
          "49,396",
          "64,183",
          "184,183",
          "304,183",
          "319,396",
        ]),
        "--wait",
        "--wait",
      ],
      labels: [],
      nvsIncludes: "506173732d313233",
    },
    // The periodic health line an endurance run on the glass is read from. It first prints a
    // minute after boot, so this run lasts just past that.
    {
      name: "health",
      taps: "295,46",
      extra: ["--quit-after", "61500", "--expect-serial", "anchor-pulse-lvgl: health up=6"],
      labels: ["Explore"],
    },
    // A unit with nothing saved, which is how the first Waveshare unit arrived: the first tap opens
    // Wi-Fi, a listed network is picked, "password" is typed on the keypad, and the join is saved.
    {
      name: "first-join",
      unprovisioned: true,
      networks: "HomeNet:-42,Skylark Cafe:-58:open",
      feed: "no-credentials",
      taps: "180,300",
      extra: [
        "--wait",
        "--wait",
        ...keypadTaps([
          "180,136",
          "304,254",
          "49,195",
          "64,183",
          "64,195",
          "304,254",
          "319,195",
          "304,254",
          "319,195",
          "184,325",
          "49,195",
          "184,254",
          "304,195",
          "304,254",
          "229,195",
          "184,183",
          "64,195",
          "319,396",
        ]),
        "--wait",
        "--wait",
        "--wait",
      ],
      labels: ["Connected", "HomeNet"],
      nvsIncludes: "70617373776f7264",
    },
    {
      name: "wifi-crowded",
      networks: Array.from(
        { length: 32 },
        (_, i) => `Conference-${i.toString().padStart(2, "0")}-long-network-name:-${35 + i}`,
      ).join(","),
      taps: "295,46 295,398",
      extra: ["--wait", "--tap", "180,398"],
      labels: ["Hidden network"],
    },
  ];
  for (const scenario of cases) {
    runner.run(
      binary,
      [
        "--nvs",
        join(output, `${scenario.name}.nvs`),
        ...(scenario.unprovisioned ? [] : ["--saved", "Demo:fixturepass"]),
        "--networks",
        scenario.networks ?? "Demo:-40",
        "--feed",
        scenario.feed ?? "portfolio",
        "--taps",
        scenario.taps,
        ...(scenario.thenFeed ? ["--then-feed", scenario.thenFeed] : []),
        ...(scenario.extra ?? []),
        "--shot",
        join(output, scenario.name),
        ...scenario.labels.flatMap((label) => ["--expect-visible", label]),
      ],
      { cwd: output, timeoutMs: 30_000 },
    );
    if (scenario.nvsIncludes !== undefined) {
      if (!readFileSync(join(output, `${scenario.name}.nvs`), "utf8").includes(scenario.nvsIncludes)) {
        throw new Error(`${scenario.name}: the saved profile does not hold what was typed on the keypad`);
      }
    }
    if (scenario.savedAfter !== undefined) {
      const saved = readFileSync(join(output, `${scenario.name}.nvs`), "utf8").includes("44656d6f");
      if (saved !== scenario.savedAfter) {
        throw new Error(`${scenario.name}: saved Demo profile did not match the confirmation choice`);
      }
    }
  }
}

export function concreteTargets(target: DeviceTarget): ConcreteTarget[] {
  return target === "all" ? ["cardputer", "esp32"] : [target];
}

export function forEachTarget(target: DeviceTarget, action: (target: ConcreteTarget) => void): void {
  for (const selected of concreteTargets(target)) action(selected);
}

export function execute(
  command: DeviceCommand,
  target: DeviceTarget,
  root = defaultRoot,
  runner: CommandRunner = new ProcessRunner(),
): void {
  const paths = pathsForRoot(root);
  const manifest = loadToolchain(root);
  mkdirSync(paths.cache, { recursive: true });

  forEachTarget(target, (selected) => {
    if (selected === "cardputer") verifyPlatformioTool(root, paths, manifest, runner);
    else verifyArduinoTool(root, manifest, runner);
    if (command === "bootstrap") {
      if (selected === "cardputer") bootstrapCardputer(root, paths, manifest, runner);
      else bootstrapEsp32(root, paths, manifest, runner);
    } else if (command === "doctor") {
      if (selected === "cardputer") doctorCardputer(root, paths, manifest, runner);
      else doctorEsp32(paths, manifest, runner);
    } else if (command === "build") {
      if (selected === "cardputer") buildCardputer(root, paths, manifest, runner);
      else buildEsp32(root, paths, manifest, runner);
    } else if (selected === "cardputer") {
      simCardputer(root, paths, manifest, runner);
    } else {
      simEsp32(root, paths, manifest, runner);
    }
  });
}

function main(): void {
  try {
    const { command, target } = parseCli(process.argv.slice(2));
    execute(command, target);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === sourceFile) main();
