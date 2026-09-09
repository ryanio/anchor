/**
 * A snapshot of desktop state, gathered on a short TTL.
 *
 * Each reading costs a subprocess, so they are collected together and cached. Hyprland events
 * invalidate the snapshot immediately rather than waiting for the TTL, which is why a workspace
 * switch shows up at once while a volume change may take up to `ttlMs`.
 *
 * Every provider degrades to a null-ish value rather than throwing. This machine has no backlight
 * device and no default audio source, and a panel that crashed on either would be a panel that only
 * works on the developer's hardware.
 */

import { execFile } from "node:child_process";
import * as hypr from "./hypr.ts";

export interface DesktopSnapshot {
  readonly workspace: number | null;
  readonly occupied: ReadonlySet<number>;
  readonly windowTitle: string;
  readonly volume: number;
  readonly muted: boolean;
  readonly nightlight: boolean;
  readonly stayingAwake: boolean;
  readonly brightness: number | null;
  readonly cpu: string;
  readonly memory: string;
  readonly theme: string;
}

export const EMPTY_SNAPSHOT: DesktopSnapshot = {
  workspace: null,
  occupied: new Set(),
  windowTitle: "",
  volume: 0,
  muted: false,
  nightlight: false,
  stayingAwake: false,
  brightness: null,
  cpu: "",
  memory: "",
  theme: "",
};

function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

async function runJson<T>(command: string, args: readonly string[]): Promise<T | null> {
  const raw = await run(command, args);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** `wpctl` prints `Volume: 0.35 [MUTED]`. Absent sink returns silence rather than throwing. */
export function parseVolume(text: string | null): { volume: number; muted: boolean } {
  if (text === null) return { volume: 0, muted: true };
  const match = /([0-9]*\.?[0-9]+)/.exec(text);
  return {
    volume: match ? Number.parseFloat(match[1] ?? "0") : 0,
    muted: text.toUpperCase().includes("MUTED"),
  };
}

/** `omarchy system stats` prints tab-separated `key\tvalue` lines. */
export function parseStats(text: string | null): Record<string, string> {
  if (text === null) return {};
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    out[line.slice(0, tab).trim()] = line.slice(tab + 1).trim();
  }
  return out;
}

export async function collect(): Promise<DesktopSnapshot> {
  const [workspace, occupied, windowTitle, volumeText, night, idle, brightnessText, statsText, theme] =
    await Promise.all([
      hypr.activeWorkspace(),
      hypr.occupiedWorkspaces(),
      hypr.activeWindowTitle(),
      run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]),
      runJson<{ enabled?: boolean }>("omarchy", ["toggle", "nightlight", "--status"]),
      runJson<{ class?: string }>("omarchy", ["toggle", "idle", "status"]),
      run("omarchy", ["brightness", "display", "--no-osd"]),
      run("omarchy", ["system", "stats"]),
      run("omarchy", ["theme", "current"]),
    ]);

  const { volume, muted } = parseVolume(volumeText);
  const stats = parseStats(statsText);
  const brightnessMatch = brightnessText === null ? null : /(\d+)/.exec(brightnessText);

  return {
    workspace,
    occupied,
    windowTitle,
    volume,
    muted,
    nightlight: night?.enabled === true,
    stayingAwake: idle?.class === "disabled",
    brightness: brightnessMatch ? Number.parseInt(brightnessMatch[1] ?? "0", 10) : null,
    cpu: stats.cpu ?? "",
    memory: stats.memory ?? "",
    theme: theme ?? "",
  };
}

/** Caches a snapshot for `ttlMs`; `invalidate()` forces the next `get()` to re-read. */
export class DesktopState {
  #snapshot: DesktopSnapshot = EMPTY_SNAPSHOT;
  #fetchedAt = 0;
  #dirty = true;
  #inFlight: Promise<DesktopSnapshot> | null = null;
  readonly #ttlMs: number;

  constructor(ttlMs = 2000) {
    this.#ttlMs = ttlMs;
  }

  invalidate(): void {
    this.#dirty = true;
  }

  get current(): DesktopSnapshot {
    return this.#snapshot;
  }

  async get(): Promise<DesktopSnapshot> {
    const fresh = Date.now() - this.#fetchedAt < this.#ttlMs;
    if (!this.#dirty && fresh) return this.#snapshot;
    // Collapse concurrent refreshes: an event burst must not fork nine subprocesses per event.
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = collect()
      .then((snapshot) => {
        this.#snapshot = snapshot;
        this.#fetchedAt = Date.now();
        this.#dirty = false;
        return snapshot;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }
}

/**
 * Whether the session is locked, from logind's `LockedHint`.
 *
 * A device on a desk keeps showing whatever was last painted, in a room its owner has walked out
 * of. That is fine for a workspace indicator and not fine for a portfolio, so the panel needs to
 * know. logind is asked rather than looking for a lock screen process: `LockedHint` is the same
 * signal every other desktop component uses, and it does not care which locker is installed.
 *
 * Any failure reads as unlocked. Blanking a panel because a subprocess failed would be a worse bug
 * than not blanking one.
 */
export async function sessionLocked(): Promise<boolean> {
  const session = process.env.XDG_SESSION_ID;
  if (session === undefined) return false;
  const text = await run("loginctl", ["show-session", session, "-p", "LockedHint"]);
  return text?.trim() === "LockedHint=yes";
}
