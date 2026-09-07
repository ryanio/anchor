#!/usr/bin/env node
/**
 * `.node-version` is the single source of truth for the Node version.
 *
 * mise reads it locally, `actions/setup-node` reads it in CI via `node-version-file`. The two places
 * that can't read it directly — package.json `engines` and the PKGBUILD's `depends` — are checked
 * here so they cannot drift silently.
 *
 * This exists because drift actually bit us: local Node 26 vs CI Node 24 produced two green-locally,
 * red-in-CI failures in a single day.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const pinned = read(".node-version").trim();
const major = pinned.split(".")[0]!;
const problems: string[] = [];

// The running interpreter must satisfy the pin.
const runningMajor = process.versions.node.split(".")[0]!;
if (runningMajor !== major) {
  problems.push(
    `running Node ${process.versions.node}, but .node-version pins ${pinned} (major ${major}). ` +
      `Run \`mise install\` locally; CI reads .node-version via node-version-file.`,
  );
}

// Every workspace's package.json engines. Adding a workspace must not create a new drift hole.
const expectedEngines = `>=${major}.0.0`;
for (const ws of ["service", "executor", "widget"]) {
  let pkg: { engines?: { node?: string } };
  try {
    pkg = JSON.parse(read(`${ws}/package.json`)) as { engines?: { node?: string } };
  } catch {
    continue; // workspace not present on this branch
  }
  if (pkg.engines?.node !== expectedEngines) {
    problems.push(
      `${ws}/package.json engines.node is ${JSON.stringify(pkg.engines?.node)}, expected "${expectedEngines}"`,
    );
  }
}

// PKGBUILD runtime dependency
const pkgbuild = read("packaging/PKGBUILD");
const expectedDep = `'nodejs>=${major}'`;
if (!pkgbuild.includes(expectedDep)) {
  problems.push(`packaging/PKGBUILD depends does not contain ${expectedDep}`);
}

// Every workflow must read the file rather than hardcode a version.
for (const wf of ["ci.yml", "deploy.yml"]) {
  const text = read(join(".github/workflows", wf));
  if (/node-version:\s*['"]?\d/.test(text)) {
    problems.push(`.github/workflows/${wf} hardcodes node-version; use node-version-file: .node-version`);
  }
}

// Every third-party action must be pinned to a commit, with the human-readable version in a
// comment. A mutable tag can be repointed by anyone with push access to that action's repo, and
// the deploy action holds our Cloudflare token.
for (const wf of ["ci.yml", "deploy.yml"]) {
  const text = read(join(".github/workflows", wf));
  for (const line of text.split("\n")) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
    if (!m) continue;
    const ref = m[1]!;
    const [, version] = ref.split("@");
    if (version === undefined || !/^[0-9a-f]{40}$/.test(version)) {
      problems.push(`.github/workflows/${wf}: ${ref} is not pinned to a 40-character commit SHA`);
    } else if (!/#\s*v\d/.test(line)) {
      problems.push(`.github/workflows/${wf}: ${ref} is pinned but has no "# vX.Y.Z" comment`);
    }
  }
}

// The tools have to be the tools we think they are.
//
// `npx biome ci .` silently ran an unrelated package called `biome` (version 0.3.3) for a full day,
// because the repo root's node_modules had never been installed and npx fell through to the
// registry. Every local "lint passed" in that window was a different program reporting success,
// while CI — which does install — kept failing on things that had supposedly been cleared.
//
// So: assert the binary exists locally and identifies itself as the pinned @biomejs/biome. Use
// `npm run lint`, never `npx biome`; an npm script puts node_modules/.bin first on PATH.
const biomePin = JSON.parse(read("package.json")).devDependencies?.["@biomejs/biome"];
if (typeof biomePin !== "string") {
  problems.push("package.json does not pin @biomejs/biome");
} else {
  const wanted = biomePin.replace(/^[^0-9]*/, "");
  try {
    const out = execFileSync(join(root, "node_modules/.bin/biome"), ["--version"], {
      encoding: "utf8",
    }).trim();
    const found = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
    if (found !== wanted) {
      problems.push(`node_modules/.bin/biome reports ${found ?? out}, but package.json pins ${wanted}`);
    }
  } catch {
    problems.push(
      "node_modules/.bin/biome is missing — run `npm ci` at the repo root. " +
        "Without it `npx biome` resolves to an unrelated package on the registry.",
    );
  }
}

if (problems.length > 0) {
  console.error(`Toolchain drift detected:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Node ${pinned} everywhere; biome ${biomePin} is the local binary.`);
