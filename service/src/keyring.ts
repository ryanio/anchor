/**
 * OS keyring access via libsecret's `secret-tool`.
 *
 * Two credentials live here, because OpenSea auth is not one credential (docs at
 * docs.opensea.io/reference/auth):
 *
 *   - **API key** — the `x-api-key` header. Public REST and quota.
 *   - **PAT** — a scoped personal access token, exchanged for a short-lived wallet JWT that
 *     account-scoped endpoints additionally require. See auth.ts.
 *
 * Neither ever lands in a config file, a theme file, an agent prompt, or a log line — see
 * docs/security.md. `execFile` is used rather than a shell so the value is never subject to
 * word-splitting or shell history.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * True when `value` could be a credential: one opaque token, no whitespace, no control characters.
 *
 * This exists because a credential reader that accepts "whatever line arrived" will cheerfully
 * store a shell command. Running `--set-pat` through a wrapper that gave it a non-TTY stdin fed the
 * reader its own command line, stored that, and reported success — and `/health` then said the
 * credential was present. The failure surfaced much later as a 401 that looked like an API problem.
 */
export function looksLikeCredential(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

/** The credentials Anchor stores, and how they are labelled in the keyring. */
const ITEMS = {
  apiKey: { attr: "opensea-api-key", label: "Anchor OpenSea API key" },
  pat: { attr: "opensea-pat", label: "Anchor OpenSea personal access token" },
} as const;

type CredentialName = keyof typeof ITEMS;

function attrs(name: CredentialName): string[] {
  return ["service", "anchor", "key", ITEMS[name].attr];
}

async function lookup(name: CredentialName): Promise<string | null> {
  try {
    const { stdout } = await run("secret-tool", ["lookup", ...attrs(name)]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    // secret-tool exits non-zero when the item is simply absent.
    return null;
  }
}

async function store(name: CredentialName, value: string): Promise<void> {
  const child = execFile("secret-tool", ["store", `--label=${ITEMS[name].label}`, ...attrs(name)]);
  child.stdin?.end(value);
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`))));
  });
}

/** Read the API key. Returns null when unset rather than throwing — callers decide how loud to be. */
export async function getApiKey(): Promise<string | null> {
  // Escape hatch for development and CI. Documented as such; the keyring is the supported path.
  const fromEnv = process.env.ANCHOR_OPENSEA_API_KEY;
  if (fromEnv) return fromEnv;
  return lookup("apiKey");
}

/** Store the API key. Reads from stdin so it never appears in argv or shell history. */
export async function setApiKey(value: string): Promise<void> {
  return store("apiKey", value);
}

/**
 * Read the OpenSea PAT.
 *
 * Deliberately has **no environment-variable fallback**, unlike the API key. A PAT carries whatever
 * scopes it was created with, which can include write scopes; the executor makes the same call for
 * the same reason. Tests inject a stub instead.
 */
export async function getPat(): Promise<string | null> {
  return lookup("pat");
}

export async function setPat(value: string): Promise<void> {
  return store("pat", value);
}

/**
 * True when libsecret's `secret-tool` is available.
 *
 * Probing with `--version` was wrong: `secret-tool` has no such flag, prints its usage and exits 2,
 * so this reported "not installed" on machines where it was installed and working. There is no
 * version or help flag to probe, so resolve the binary on PATH instead of running it — the only
 * question here is whether it exists.
 */
export async function keyringAvailable(): Promise<boolean> {
  try {
    // `command -v` is a shell builtin present in any POSIX sh, and exits non-zero when not found.
    await run("sh", ["-c", "command -v secret-tool"]);
    return true;
  } catch {
    return false;
  }
}
