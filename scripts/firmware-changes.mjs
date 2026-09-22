import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const FIRMWARE_TARGETS = ["cardputer", "esp32"];

const FIRMWARE_INPUTS = new Set([
  ".github/workflows/ci.yml",
  ".gitmodules",
  ".node-version",
  "devices/toolchain.json",
  "package-lock.json",
  "package.json",
]);

const UNRELATED_PREFIXES = [
  "devices/config/",
  "devices/src/",
  "docs/",
  "executor/",
  "packaging/",
  "service/",
  "site/",
  "theme/",
  "themes/",
  "widget/",
];

const UNRELATED_FILES = new Set([
  ".github/workflows/deploy.yml",
  ".gitignore",
  "biome.json",
  "devices/.gitignore",
  "devices/package-lock.json",
  "devices/package.json",
  "devices/tsconfig.json",
  "LICENSE",
]);

export function affectsFirmware(path) {
  return firmwareTargetsForPath(path).length > 0;
}

export function firmwareTargetsForPath(path) {
  if (path.startsWith("devices/firmware/cardputer/")) return ["cardputer"];
  if (path.startsWith("devices/firmware/esp32/")) return ["esp32"];
  if (path.startsWith("devices/firmware/")) return FIRMWARE_TARGETS;
  if (path.startsWith("scripts/device")) return FIRMWARE_TARGETS;
  if (FIRMWARE_INPUTS.has(path)) return FIRMWARE_TARGETS;

  if (path.endsWith(".md")) return [];
  if (UNRELATED_FILES.has(path)) return [];
  if (UNRELATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return [];

  // Unknown files build both targets. A new build input must not silently escape either gate merely
  // because this classifier predates it.
  return FIRMWARE_TARGETS;
}

function validateTarget(target) {
  if (target !== undefined && !FIRMWARE_TARGETS.includes(target)) {
    throw new Error(`Unknown firmware target ${JSON.stringify(target)}`);
  }
}

export function classifyFirmwareChanges(paths, target) {
  validateTarget(target);
  const relevant = paths.filter((path) => {
    const targets = firmwareTargetsForPath(path);
    return target === undefined ? targets.length > 0 : targets.includes(target);
  });
  return {
    run: relevant.length > 0,
    relevant,
  };
}

function validCommitSha(value) {
  return /^[0-9a-f]{40,64}$/i.test(value) && !/^0+$/.test(value);
}

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function classifyGitRange(base, head, root = process.cwd(), target) {
  validateTarget(target);
  if (!validCommitSha(base) || !validCommitSha(head)) {
    return { run: true, relevant: [], reason: "the event did not provide two commit SHAs" };
  }

  for (const sha of [base, head]) {
    const exists = git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    if (exists.error || exists.status !== 0) {
      return { run: true, relevant: [], reason: `commit ${sha} is unavailable in the checkout` };
    }
  }

  // Disabling rename detection reports both sides of a rename. Moving a firmware file out of its
  // directory must still run the build, and NUL delimiters preserve every valid Git filename.
  const diff = git(root, ["diff", "--name-only", "-z", "--no-renames", base, head, "--"]);
  if (diff.error || diff.status !== 0 || !Buffer.isBuffer(diff.stdout)) {
    return { run: true, relevant: [], reason: "git could not classify the changed paths" };
  }

  const paths = diff.stdout.toString("utf8").split("\0");
  paths.pop();
  return { ...classifyFirmwareChanges(paths, target), reason: "changed paths were classified" };
}

function main() {
  const [base = "", head = "", target] = process.argv.slice(2);
  const result = classifyGitRange(base, head, process.cwd(), target);
  const label = target ? `${target} firmware build` : "firmware build";
  console.error(result.run ? `${label} selected: ${result.reason}` : `${label} skipped: ${result.reason}`);
  process.stdout.write(result.run ? "true" : "false");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
