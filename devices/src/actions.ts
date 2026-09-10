/**
 * Action dispatch.
 *
 * Actions are terse verb-first strings so a config stays readable:
 *
 *     "omarchy toggle nightlight"   run an Omarchy command
 *     "hypr workspace 3"            a Hyprland dispatcher
 *     "exec foot -e btop"           a command, argv-style, no shell
 *     "page anchor"                 switch panel page
 *     "volume mute"                 built-in audio control
 *
 * **No action here can sign, spend, or approve anything**, and that is a deliberate boundary rather
 * than an oversight. AGENTS.md invariant 1 says policy is enforced outside the requester; a device
 * is the least trustworthy requester in the system — it is a piece of plastic on a desk that anyone
 * walking past can press. So the device vocabulary contains no verb that moves value. When Anchor
 * grows a "confirm this offer" flow, the device's role is to *display* it and hand intent to the
 * executor, which decides; it is never the thing that approves.
 *
 * Commands are spawned detached with output discarded. A key press must not block the event loop,
 * and a command that fails must not take the panel down with it.
 */

import { execFile as realExecFile, spawn as realSpawn } from "node:child_process";
import * as hypr from "./state/hypr.ts";

export interface ActionContext {
  /** Switch the visible page. Provided by the panel. */
  readonly setPage: (name: string) => void;
}

// A key press must not touch the real desktop from a test. `dispatch` reaches a real browser, a
// real volume, a real theme — none of it behind a flag a test author has to remember, because the
// first time this went unmocked it opened a fake NFT's URL in a real Chromium window, repeatedly,
// every time the suite ran. `spawn` and `execFile` are the only two exits to the outside world this
// file has, so redirecting both here is what makes every test safe by construction rather than by
// each test remembering to route around them.
//
// Narrowed to the one shape each call site actually uses, rather than `typeof spawn`/`typeof
// execFile` — both are overloaded for callers this file is not, and a fake that only has to satisfy
// what `spawnDetached`/`themeStep` call is a fake a test can write in three lines.
interface FakeChild {
  on(event: "error", listener: (error: Error) => void): void;
  unref(): void;
}
type SpawnFn = (command: string, args: readonly string[]) => FakeChild;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileFn = (command: string, args: readonly string[], callback: ExecFileCallback) => FakeChild;

let spawnImpl: SpawnFn = (command, args) => realSpawn(command, args, { detached: true, stdio: "ignore" });
let execFileImpl: ExecFileFn = (command, args, callback) =>
  realExecFile(command, args, { encoding: "utf8", timeout: 5000 }, callback);

/** Test-only. Replaces both exits to the real world; returns a restorer for `after`/`afterEach`. */
export function useFakeProcesses(spawnFake: SpawnFn, execFileFake: ExecFileFn): () => void {
  const previousSpawn = spawnImpl;
  const previousExecFile = execFileImpl;
  spawnImpl = spawnFake;
  execFileImpl = execFileFake;
  return () => {
    spawnImpl = previousSpawn;
    execFileImpl = previousExecFile;
  };
}

/** Split on whitespace, honouring double quotes so a label can carry a space. */
export function tokenize(action: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match = pattern.exec(action);
  while (match !== null) {
    const token = match[1] ?? match[2];
    if (token !== undefined) out.push(token);
    match = pattern.exec(action);
  }
  return out;
}

function spawnDetached(command: string, args: readonly string[]): void {
  try {
    const child = spawnImpl(command, args);
    child.on("error", () => {
      /* a missing binary must not crash the panel */
    });
    child.unref();
  } catch {
    /* spawn can throw synchronously on a bad argv; ignore for the same reason */
  }
}

export function volumeStep(delta: number): void {
  // Routed through Omarchy rather than wpctl so the on-screen display appears, exactly as it does
  // when the volume keys on a keyboard are used.
  const sign = delta >= 0 ? "+" : "-";
  spawnDetached("omarchy", ["audio", "output", "volume", `${sign}${Math.abs(delta)}`]);
}

export function volumeMute(): void {
  spawnDetached("omarchy", ["audio", "output", "volume", "mute-toggle"]);
}

export function brightnessStep(delta: number): void {
  spawnDetached("omarchy", ["brightness", "display", delta >= 0 ? `+${delta}%` : `${Math.abs(delta)}%-`]);
}

export function workspaceStep(delta: number): void {
  // `e+1` / `e-1` move between *existing* workspaces, which is what a dial should do — stepping onto
  // empty workspace 7 because the dial was spun is not navigation.
  void hypr.focusWorkspace(delta > 0 ? "e+1" : "e-1");
}

/** Cycle themes in the order `omarchy theme list` reports. */
export function themeStep(delta: number): void {
  execFileImpl("omarchy", ["theme", "list"], (listError, listing) => {
    if (listError) return;
    execFileImpl("omarchy", ["theme", "current"], (currentError, current) => {
      if (currentError) return;
      const themes = listing
        .split("\n")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      const index = themes.indexOf(current.trim());
      if (index === -1 || themes.length === 0) return;
      const next = themes[(index + (delta > 0 ? 1 : -1) + themes.length) % themes.length];
      if (next === undefined) return;
      spawnDetached("omarchy", ["theme", "set", next]);
    });
  });
}

export const DIAL_CONTROLS: Readonly<Record<string, (delta: number) => void>> = {
  volume: volumeStep,
  brightness: brightnessStep,
  workspace: workspaceStep,
  theme: themeStep,
};

/** Run one action. Returns false when the verb is unknown, so callers can log it once. */
export function dispatch(action: string, context: ActionContext): boolean {
  const parts = tokenize(action.trim());
  if (parts.length === 0 || parts[0] === "noop") return true;
  const [verb, ...args] = parts;

  switch (verb) {
    case "omarchy":
      spawnDetached("omarchy", args);
      return true;
    case "workspace": {
      const target = args[0];
      if (target === undefined) return false;
      void hypr.focusWorkspace(target);
      return true;
    }
    case "hypr":
      // Raw Lua, for anything without a named action here. Joined rather than passed as argv:
      // hyprctl evaluates its argument as a Lua expression.
      if (args.length === 0) return false;
      void hypr.dispatch(args.join(" "));
      return true;
    case "exec": {
      const [program, ...rest] = args;
      if (program === undefined) return false;
      spawnDetached(program, rest);
      return true;
    }
    case "page": {
      const target = args[0];
      if (target === undefined) return false;
      context.setPage(target);
      return true;
    }
    case "volume": {
      const target = args[0] ?? "mute";
      if (target === "mute" || target === "mute-toggle") {
        volumeMute();
        return true;
      }
      const step = Number.parseInt(target, 10);
      if (Number.isNaN(step)) return false;
      volumeStep(step);
      return true;
    }
    case "brightness": {
      const step = Number.parseInt(args[0] ?? "5", 10);
      if (Number.isNaN(step)) return false;
      brightnessStep(step);
      return true;
    }
    case "theme":
      themeStep(args[0] === "prev" ? -1 : 1);
      return true;
    default:
      return false;
  }
}

/** Whether a key with this `state` expression should render as active. */
export function resolveActive(
  state: string,
  snapshot: {
    workspace: number | null;
    occupied: ReadonlySet<number>;
    nightlight: boolean;
    stayingAwake: boolean;
    muted: boolean;
  },
  page: string,
): boolean {
  if (state === "") return false;
  const marker = state.indexOf(":");
  const name = marker === -1 ? state : state.slice(0, marker);
  const argument = marker === -1 ? "" : state.slice(marker + 1);

  switch (name) {
    case "nightlight":
      return snapshot.nightlight;
    case "awake":
      return snapshot.stayingAwake;
    case "muted":
      return snapshot.muted;
    case "workspace":
      return snapshot.workspace === Number.parseInt(argument, 10);
    case "occupied":
      return snapshot.occupied.has(Number.parseInt(argument, 10));
    case "page":
      return page === argument;
    default:
      return false;
  }
}
