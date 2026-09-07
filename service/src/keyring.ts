/**
 * OS keyring access via libsecret's `secret-tool`.
 *
 * The API key never lands in a config file, a theme file, an agent prompt, or a log line —
 * see docs/security.md. `execFile` is used rather than a shell so the value is never subject
 * to word-splitting or shell history.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ATTRS = ["service", "anchor", "key", "opensea-api-key"] as const;

/** Read the API key. Returns null when unset rather than throwing — callers decide how loud to be. */
export async function getApiKey(): Promise<string | null> {
  // Escape hatch for development and CI. Documented as such; the keyring is the supported path.
  const fromEnv = process.env.ANCHOR_OPENSEA_API_KEY;
  if (fromEnv) return fromEnv;

  try {
    const { stdout } = await run("secret-tool", ["lookup", ...ATTRS]);
    const key = stdout.trim();
    return key.length > 0 ? key : null;
  } catch {
    // secret-tool exits non-zero when the item is simply absent.
    return null;
  }
}

/** Store the API key. Reads from stdin so it never appears in argv or shell history. */
export async function setApiKey(value: string): Promise<void> {
  const child = execFile("secret-tool", ["store", "--label=Anchor OpenSea API key", ...ATTRS]);
  child.stdin?.end(value);
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`))));
  });
}

/** True when libsecret is available at all. */
export async function keyringAvailable(): Promise<boolean> {
  try {
    await run("secret-tool", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
