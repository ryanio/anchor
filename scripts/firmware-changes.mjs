import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  if (path.startsWith("devices/firmware/")) return true;
  if (path.startsWith("scripts/device")) return true;
  if (FIRMWARE_INPUTS.has(path)) return true;

  if (path.endsWith(".md")) return false;
  if (UNRELATED_FILES.has(path)) return false;
  if (UNRELATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;

  // Unknown files build firmware. A new build input must not silently escape the gate merely
  // because this classifier predates it.
  return true;
}

export function classifyFirmwareChanges(paths) {
  const relevant = paths.filter(affectsFirmware);
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

export function classifyGitRange(base, head, root = process.cwd()) {
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
  return { ...classifyFirmwareChanges(paths), reason: "changed paths were classified" };
}

function main() {
  const [base = "", head = ""] = process.argv.slice(2);
  const result = classifyGitRange(base, head);
  console.error(
    result.run ? `firmware build selected: ${result.reason}` : `firmware build skipped: ${result.reason}`,
  );
  process.stdout.write(result.run ? "true" : "false");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
