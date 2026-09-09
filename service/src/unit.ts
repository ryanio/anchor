/**
 * Installing the service as a systemd user unit, so it survives a reboot.
 *
 * The unit itself has existed since the widget's setup step needed a button to press. Nothing
 * installed or enabled it, which is why "it works until I reboot" was the shape of every report:
 * the documented instructions ended in `systemctl --user start`, and `start` is for this session
 * only. `enable` is what makes it come back.
 *
 * Two paths, because there are two ways Anchor arrives:
 *
 *   **Packaged** — `/usr/lib/systemd/user/anchor-service.service` is already there and names
 *   `/usr/bin/anchor-service`. Nothing is written; the unit is enabled where it lies. Shadowing a
 *   packaged unit with a copy in `~/.config` is how a machine ends up running last month's service
 *   after an upgrade.
 *
 *   **From a checkout** — the packaged unit is absent, so one is written to
 *   `~/.config/systemd/user/` with `ExecStart` pointing at this file through the node that is
 *   running it. Both are absolute: a unit is not started from a shell and inherits no PATH worth
 *   relying on.
 *
 * Everything here is idempotent. Running it twice is how people check whether they ran it once.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = "anchor-service.service";
const PACKAGED = `/usr/lib/systemd/user/${UNIT}`;

function userUnitDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "systemd", "user");
}

/** The unit template that ships in this repository, or null when running from a package. */
function template(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "..", "packaging", UNIT);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function systemctl(...args: string[]): void {
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

/**
 * Whether systemd is actually running this session.
 *
 * A container, a plain SSH session, or a non-systemd distribution will all fail `systemctl --user`
 * with a message about a bus that says nothing useful. Better to say what is missing.
 */
function haveSystemd(): boolean {
  try {
    execFileSync("systemctl", ["--user", "is-system-running"], { stdio: "ignore" });
    return true;
  } catch {
    // A degraded system still answers; only an absent one throws on the bus.
    return existsSync(`/run/user/${process.getuid?.() ?? ""}/systemd/private`);
  }
}

/**
 * The packaged unit, repointed at a checkout.
 *
 * Pure, and tested, because this is the line that decides whether the machine comes back after a
 * reboot — and a wrong `ExecStart` fails at boot, hours later, in a journal nobody is reading.
 *
 * Both paths absolute: a unit is not started from a shell and inherits no PATH worth relying on.
 * `--experimental-strip-types` because the service runs its TypeScript directly from source; a
 * packaged build compiles it and the packaged unit carries no such flag.
 */
export function renderUnit(source: string, execPath: string, entry: string): string {
  const exec = `ExecStart=${execPath} --experimental-strip-types ${entry}`;
  if (!/^ExecStart=/m.test(source)) {
    throw new Error("the unit template has no ExecStart line to repoint");
  }
  return (
    "# Written by `anchor-service --install-service` from a checkout. Re-run it after moving the\n" +
    "# checkout: the paths below are absolute, because a unit inherits no useful PATH.\n" +
    source.replace(/^ExecStart=.*$/m, exec)
  );
}

export function installService(): void {
  if (!haveSystemd()) {
    console.error(
      "no systemd user session here, so there is nothing to install into.\n" +
        "  Start the service however this machine starts things, pointing at:\n" +
        `    ${process.execPath} ${fileURLToPath(new URL("index.ts", import.meta.url))}`,
    );
    process.exitCode = 1;
    return;
  }

  const userPath = join(userUnitDir(), UNIT);

  if (existsSync(PACKAGED)) {
    // Packaged wins, and a stale hand-written copy would silently outrank it.
    if (existsSync(userPath)) {
      rmSync(userPath);
      console.log(`removed ${userPath}, which was shadowing the packaged unit`);
    }
    systemctl("daemon-reload");
    systemctl("enable", "--now", UNIT);
    console.log(`enabled the packaged unit at ${PACKAGED}`);
    return;
  }

  const source = template();
  if (source === null) {
    console.error(
      `no unit to install: neither ${PACKAGED} nor packaging/${UNIT} in this checkout.\n` +
        "  Install the package, or run this from a source tree.",
    );
    process.exitCode = 1;
    return;
  }

  const entry = fileURLToPath(new URL("index.ts", import.meta.url));
  const written = renderUnit(source, process.execPath, entry);

  mkdirSync(userUnitDir(), { recursive: true });
  writeFileSync(userPath, written, { mode: 0o644 });
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  const exec = written.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "";
  console.log(`installed and enabled ${userPath}\n  ${exec.slice("ExecStart=".length)}`);
}

export function uninstallService(): void {
  if (!haveSystemd()) {
    console.error("no systemd user session here, so there is nothing to remove.");
    process.exitCode = 1;
    return;
  }
  try {
    systemctl("disable", "--now", UNIT);
  } catch {
    // Already gone, or never enabled. Removing the file below is still worth doing.
  }
  const userPath = join(userUnitDir(), UNIT);
  if (existsSync(userPath)) {
    rmSync(userPath);
    console.log(`removed ${userPath}`);
  } else {
    console.log(`nothing at ${userPath}`);
  }
  systemctl("daemon-reload");
  if (existsSync(PACKAGED)) console.log(`the packaged unit at ${PACKAGED} is left in place, disabled`);
}
