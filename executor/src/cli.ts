#!/usr/bin/env node
/**
 * `anchor-executor` — the administrative surface for the Privy backend.
 *
 *   anchor-executor --set-key app-secret    store a credential in the OS keyring
 *   anchor-executor --list-keys             report which credentials are present
 *
 * Note what this CLI cannot do. There is no `--execute`, no `--approve`, and no `--set-limit`:
 * limits live in the Privy policy, which is edited in Privy's dashboard or through their API by a
 * human, not by anything in this repository (docs/autonomy.md — the agent must never decide its own
 * limits). This tool moves credentials into the keyring and reports what it can see. That is all.
 */
import { readSecret } from "../../scripts/read-secret.ts";
import {
  CREDENTIAL_NAMES,
  type CredentialName,
  isCredentialName,
  keyringAvailable,
  readCredential,
  writeCredential,
} from "./credentials.ts";

const USAGE = `anchor-executor — Privy backend credentials

  anchor-executor --set-key <name>   store a credential in the OS keyring
  anchor-executor --list-keys        report which credentials are present

  <name> is one of: ${CREDENTIAL_NAMES.join(", ")}
`;

async function requireKeyring(): Promise<void> {
  if (await keyringAvailable()) return;
  console.error("secret-tool not found. Install libsecret and try again.");
  process.exit(1);
}

async function setKey(name: CredentialName): Promise<void> {
  await requireKeyring();
  const value = await readSecret(`Privy ${name}: `);
  if (!value) {
    console.error("Nothing entered; no change made.");
    process.exit(1);
  }
  await writeCredential(name, value);
  console.error(`Stored ${name} in the OS keyring.`);
}

/** Presence only. A tool that prints a credential is a tool that puts it in a scrollback buffer. */
async function listKeys(): Promise<void> {
  await requireKeyring();
  for (const name of CREDENTIAL_NAMES) {
    const present = (await readCredential(name)) !== null;
    console.error(`${present ? "set    " : "not set"}  ${name}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const setKeyAt = argv.indexOf("--set-key");
  if (setKeyAt !== -1) {
    const name = argv[setKeyAt + 1];
    if (name === undefined || !isCredentialName(name)) {
      console.error(`--set-key needs one of: ${CREDENTIAL_NAMES.join(", ")}`);
      process.exit(1);
    }
    await setKey(name);
    return;
  }
  if (argv.includes("--list-keys")) {
    await listKeys();
    return;
  }
  console.error(USAGE);
  process.exit(argv.includes("--help") ? 0 : 1);
}

await main(process.argv.slice(2));
