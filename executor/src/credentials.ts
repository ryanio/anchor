/**
 * Privy credentials, read from the OS keyring via libsecret's `secret-tool`.
 *
 * Same shape as `service/src/keyring.ts`, and for the same reason (docs/security.md): a credential
 * that can sign for a wallet must never land in a config file, in `argv`, in a shell history, in an
 * agent prompt, or in a log line. `execFile` is used rather than a shell so the value is never
 * subject to word-splitting, and `secret-tool store` reads the value from stdin so it never appears
 * in a process listing.
 *
 * Note what is *not* here: there is no private key. Privy's app secret authenticates Anchor to
 * Privy's API; the wallet's signing key is reconstituted only inside Privy's enclave and never
 * exists on this machine (AGENTS.md invariant: keys never touch this codebase).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The credential names this workspace knows about.
 *
 * A closed union rather than free text: `secret-tool` will happily store under any attribute, and a
 * typo'd name would silently produce a credential nothing ever reads and a "missing key" error
 * nobody can explain.
 */
export const CREDENTIAL_NAMES = ["app-id", "app-secret", "authorization-key"] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export function isCredentialName(value: string): value is CredentialName {
  return (CREDENTIAL_NAMES as readonly string[]).includes(value);
}

/** Keyring lookup attributes for one credential. Matches the service's `service=anchor` namespace. */
function attributes(name: CredentialName): string[] {
  return ["service", "anchor", "key", `privy-${name}`];
}

/**
 * Read one credential. `null` when unset rather than a throw — callers decide how loud to be, and a
 * missing credential is a configuration state, not an exception.
 *
 * There is deliberately no environment-variable fallback. The data service has one, documented as a
 * concession to CI (docs/security.md), and it is strictly weaker: a process environment is readable
 * at `/proc/<pid>/environ` and is inherited by every child process. A credential that can move
 * funds does not get that concession — the test suite injects a stub instead.
 */
export async function readCredential(name: CredentialName): Promise<string | null> {
  try {
    const { stdout } = await run("secret-tool", ["lookup", ...attributes(name)]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    // secret-tool exits non-zero when the item is simply absent.
    return null;
  }
}

/** Store one credential. The value goes over stdin, never argv. */
export async function writeCredential(name: CredentialName, value: string): Promise<void> {
  const child = execFile("secret-tool", ["store", `--label=Anchor Privy ${name}`, ...attributes(name)]);
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

/** What a Privy-backed executor needs in order to authenticate. */
export interface PrivyCredentials {
  readonly appId: string;
  readonly appSecret: string;
  /**
   * PEM-encoded P-256 private key for request authorization signatures, when the wallet or its
   * policy is owned by an authorization key. Absent when the app secret alone is sufficient.
   */
  readonly authorizationKey?: string;
}

export class MissingCredentialError extends Error {
  constructor(name: CredentialName) {
    super(`No Privy ${name} in the keyring. Run: anchor-executor --set-key ${name}`);
    this.name = "MissingCredentialError";
  }
}

/**
 * Load the credential set from the keyring.
 *
 * Throws {@link MissingCredentialError} naming the missing credential — the *name*, never a value,
 * and never a partial value: "your key starts with sk_" is still a leak of key material.
 */
export async function loadCredentials(): Promise<PrivyCredentials> {
  const [appId, appSecret, authorizationKey] = await Promise.all([
    readCredential("app-id"),
    readCredential("app-secret"),
    readCredential("authorization-key"),
  ]);
  if (!appId) throw new MissingCredentialError("app-id");
  if (!appSecret) throw new MissingCredentialError("app-secret");
  return {
    appId,
    appSecret,
    ...(authorizationKey === null ? {} : { authorizationKey }),
  };
}
