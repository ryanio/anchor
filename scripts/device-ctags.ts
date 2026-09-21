import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

export interface ArduinoCtagsSpec {
  repository: string;
  commit: string;
  version: string;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

export interface ArduinoCtagsRunner {
  run(command: string, args: string[], options?: RunOptions): string;
}

export interface ArduinoCtagsPaths {
  source: string;
  build: string;
  install: string;
  binary: string;
}

export function needsNativeArduinoCtags(platform = process.platform, arch = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function nativeArduinoCtagsPaths(root: string): ArduinoCtagsPaths {
  const cache = join(root, ".cache", "device");
  const install = join(cache, "tools", "ctags-native");
  return {
    source: join(cache, "vendor", "ctags"),
    build: join(cache, "build", "ctags-native"),
    install,
    binary: join(install, "bin", "ctags"),
  };
}

export function nativeArduinoCtagsBuildProperty(
  root: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  if (!needsNativeArduinoCtags(platform, arch)) return [];
  const directory = join(nativeArduinoCtagsPaths(root).install, "bin");
  return ["--build-property", `runtime.tools.ctags.path=${directory}`];
}

function requireOutput(output: string, expected: string, description: string): void {
  if (!output.includes(expected)) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)} in command output`);
  }
}

function checkoutSource(paths: ArduinoCtagsPaths, spec: ArduinoCtagsSpec, runner: ArduinoCtagsRunner): void {
  mkdirSync(join(paths.source, ".."), { recursive: true });
  if (!existsSync(join(paths.source, ".git"))) {
    if (existsSync(paths.source) && readdirSync(paths.source).length > 0) {
      throw new Error(`${paths.source} exists but is not a Git checkout; move it aside and retry`);
    }
    mkdirSync(paths.source, { recursive: true });
    runner.run("git", ["init"], { cwd: paths.source });
    runner.run("git", ["remote", "add", "origin", spec.repository], { cwd: paths.source });
  }
  runner.run("git", ["fetch", "--depth=1", "origin", spec.commit], { cwd: paths.source });
  runner.run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: paths.source });
  runner.run("git", ["restore", "--source=HEAD", "--staged", "--worktree", "."], {
    cwd: paths.source,
  });
  const actual = runner.run("git", ["rev-parse", "HEAD"], { cwd: paths.source, quiet: true }).trim();
  if (actual !== spec.commit) throw new Error(`Arduino ctags is ${actual}, expected ${spec.commit}`);
}

function verifyBinary(binary: string, spec: ArduinoCtagsSpec, runner: ArduinoCtagsRunner): void {
  if (!existsSync(binary)) throw new Error(`Native Arduino ctags is missing at ${binary}`);
  requireOutput(
    runner.run("file", [binary], { quiet: true }),
    "arm64",
    "Arduino ctags architecture mismatch",
  );
  requireOutput(
    runner.run(binary, ["--version"], { quiet: true }),
    `Exuberant Ctags ${spec.version}`,
    "Arduino ctags version mismatch",
  );
}

export function bootstrapNativeArduinoCtags(
  root: string,
  spec: ArduinoCtagsSpec,
  runner: ArduinoCtagsRunner,
): void {
  if (!needsNativeArduinoCtags()) return;
  const paths = nativeArduinoCtagsPaths(root);
  checkoutSource(paths, spec, runner);

  rmSync(paths.build, { recursive: true, force: true });
  mkdirSync(paths.build, { recursive: true });
  const stage = join(paths.build, "install");
  const cflags = `-O2 -include dirent.h -DPROGRAM_VERSION=\\"${spec.version}\\"`;
  runner.run(join(paths.source, "configure"), [`--prefix=${stage}`, "--disable-etags"], {
    cwd: paths.build,
    env: { ...process.env, CFLAGS: cflags },
  });
  runner.run("make", [`-j${availableParallelism()}`], { cwd: paths.build });
  runner.run("make", ["install"], { cwd: paths.build });

  const stagedBinary = join(stage, "bin", "ctags");
  verifyBinary(stagedBinary, spec, runner);
  rmSync(paths.install, { recursive: true, force: true });
  mkdirSync(join(paths.install, ".."), { recursive: true });
  renameSync(stage, paths.install);
}

export function verifyNativeArduinoCtags(
  root: string,
  spec: ArduinoCtagsSpec,
  runner: ArduinoCtagsRunner,
): void {
  if (!needsNativeArduinoCtags()) return;
  const paths = nativeArduinoCtagsPaths(root);
  const actual = runner.run("git", ["rev-parse", "HEAD"], { cwd: paths.source, quiet: true }).trim();
  if (actual !== spec.commit) throw new Error(`Arduino ctags is ${actual}, expected ${spec.commit}`);
  verifyBinary(paths.binary, spec, runner);
}
