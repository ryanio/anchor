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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const pinned = read(".node-version").trim();
const major = pinned.split(".")[0]!;
const problems: string[] = [];

// The running interpreter must satisfy the pin.
const runningMajor = process.versions.node.split(".")[0]!;
if (runningMajor !== major) {
  problems.push(`running Node ${process.versions.node}, but .node-version pins ${pinned} (major ${major}). ` +
                `Run \`mise install\` locally; CI reads .node-version via node-version-file.`);
}

// package.json engines
const pkg = JSON.parse(read("service/package.json")) as { engines?: { node?: string } };
const expectedEngines = `>=${major}.0.0`;
if (pkg.engines?.node !== expectedEngines) {
  problems.push(`service/package.json engines.node is ${JSON.stringify(pkg.engines?.node)}, expected "${expectedEngines}"`);
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

if (problems.length > 0) {
  console.error("Node version drift detected:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Node version consistent: ${pinned} everywhere.`);
