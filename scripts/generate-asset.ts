#!/usr/bin/env node
/**
 * Generate an image asset with xAI's Grok Imagine, and save it into the repo.
 *
 *   node scripts/generate-asset.ts --prompt "..." --out site/assets/og-card.jpg
 *   node scripts/generate-asset.ts --video --prompt "..." --out site/assets/loop.mp4
 *   node scripts/generate-asset.ts --video --image-url https://... --prompt "..." --out out.mp4
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
const VIDEO_ENDPOINT = "https://api.x.ai/v1/videos/generations";
const VIDEO_STATUS = "https://api.x.ai/v1/videos";
const DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5";

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

/**
 * Video generation is asynchronous: the POST returns a `request_id`, and the result is polled until
 * `status` is done. The finished video lives at a temporary URL, so it is downloaded immediately
 * rather than stored as a link that will rot.
 */
async function generateVideo(key: string, out: string): Promise<void> {
  const prompt = arg("prompt");
  const imageUrl = arg("image-url");
  if (!prompt && !imageUrl) {
    console.error("--video needs --prompt, --image-url, or both");
    process.exit(1);
  }

  const body: Record<string, unknown> = { model: arg("model") ?? DEFAULT_VIDEO_MODEL };
  if (prompt) body.prompt = prompt;
  // Image-to-video takes a URL the API can reach, not a local path.
  if (imageUrl) body.image = { url: imageUrl };
  const duration = arg("duration");
  if (duration) body.duration = Number(duration);

  const start = await fetch(VIDEO_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!start.ok) {
    console.error(`xAI API ${start.status} ${start.statusText}`);
    process.exit(1);
  }

  const { request_id: requestId } = (await start.json()) as { request_id?: string };
  if (!requestId) {
    console.error("No request_id in the response.");
    process.exit(1);
  }
  console.error(`queued ${requestId} — polling`);

  // Generation runs to minutes. Poll every 5s with a hard ceiling so this cannot hang a CI job.
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      console.error(`Timed out after 10 minutes. Check later: ${VIDEO_STATUS}/${requestId}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5000));

    const poll = await fetch(`${VIDEO_STATUS}/${requestId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!poll.ok) {
      console.error(`xAI API ${poll.status} ${poll.statusText}`);
      process.exit(1);
    }

    const job = (await poll.json()) as { status?: string; video?: { url?: string } };
    if (job.status === "failed" || job.status === "expired") {
      console.error(`Generation ${job.status}.`);
      process.exit(1);
    }
    if (job.status !== "done") {
      process.stderr.write(".");
      continue;
    }

    const url = job.video?.url;
    if (!url) {
      console.error("Job is done but carries no video URL.");
      process.exit(1);
    }
    process.stderr.write("\n");
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    console.log(`wrote ${out} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--set-key")) return setKey();

  const out = arg("out");
  if (!out) {
    console.error(
      [
        "usage:",
        '  generate-asset.ts --prompt "..." --out site/assets/name.jpg [--model ID]',
        '  generate-asset.ts --video --prompt "..." --out site/assets/loop.mp4 [--image-url URL] [--duration N]',
      ].join("\n"),
    );
    process.exit(1);
  }

  const key = await getKey();
  if (!key) {
    console.error("No xAI key. Run: node scripts/generate-asset.ts --set-key");
    process.exit(1);
  }

  if (process.argv.includes("--video")) return generateVideo(key, out);

  const prompt = arg("prompt");
  if (!prompt) {
    console.error("--prompt is required for image generation");
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
