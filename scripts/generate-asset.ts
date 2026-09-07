#!/usr/bin/env node
/**
 * Generate an image asset with xAI's Grok Imagine, and save it into the repo.
 *
 *   node scripts/generate-asset.ts --prompt "..." --out site/assets/og-card.jpg
 *   node scripts/generate-asset.ts --set-key          # store the key in the OS keyring
 *
 * The key lives in the OS keyring like every other credential in this project — never in a config
 * file, never in argv, never in a commit (docs/security.md). Zero dependencies: the xAI endpoint is
 * OpenAI-compatible, so `fetch` is all it takes.
 *
 * Use this for illustration, social/OG cards, and textures. Do NOT use it for the logo or icons —
 * `site/brand/` is hand-authored SVG, which themes with `currentColor`, stays crisp at any size, and
 * costs a few hundred bytes.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { readSecret } from "./read-secret.ts";

const run = promisify(execFile);
const ATTRS = ["service", "anchor", "key", "xai-api-key"] as const;
const ENDPOINT = "https://api.x.ai/v1/images/generations";
const DEFAULT_MODEL = "grok-imagine-image-2.0";

async function getKey(): Promise<string | null> {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    const { stdout } = await run("secret-tool", ["lookup", ...ATTRS]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function setKey(): Promise<void> {
  const key = await readSecret("xAI API key: ");
  if (!key) {
    console.error("Nothing entered.");
    process.exit(1);
  }
  const child = execFile("secret-tool", ["store", "--label=Anchor xAI API key", ...ATTRS]);
  child.stdin?.end(key);
  await new Promise<void>((res, rej) =>
    child.on("exit", (c) => (c === 0 ? res() : rej(new Error(`secret-tool exited ${c}`)))),
  );
  console.error("Stored in the OS keyring.");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--set-key")) return setKey();

  const prompt = arg("prompt");
  const out = arg("out");
  if (!prompt || !out) {
    console.error('usage: generate-asset.ts --prompt "..." --out site/assets/name.jpg [--model ID]');
    process.exit(1);
  }

  const key = await getKey();
  if (!key) {
    console.error("No xAI key. Run: node scripts/generate-asset.ts --set-key");
    process.exit(1);
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: arg("model") ?? DEFAULT_MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    // Status only — never echo headers or the body, which can carry the key back.
    console.error(`xAI API ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = body.data?.[0];
  if (!first) {
    console.error("No image in response.");
    process.exit(1);
  }

  const bytes = first.b64_json
    ? Buffer.from(first.b64_json, "base64")
    : Buffer.from(await (await fetch(first.url!)).arrayBuffer());

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

await main();
