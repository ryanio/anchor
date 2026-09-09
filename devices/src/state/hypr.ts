/**
 * Hyprland IPC: `hyprctl` for queries, `.socket2.sock` for live events.
 *
 * Polling would work but trails the desktop by up to a tick; socket2 pushes a workspace change the
 * moment it happens, which is what makes the panel feel attached to the desktop rather than behind
 * it. The listener reconnects on its own so a Hyprland restart does not require restarting Anchor.
 */

import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

export interface Workspace {
  readonly id: number;
  readonly windows: number;
}

function runtimeDir(): string | null {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!signature) return null;
  const base = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(base, "hypr", signature);
}

export function available(): boolean {
  return runtimeDir() !== null;
}

function ctl(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("hyprctl", args, { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

async function ctlJson<T>(args: readonly string[]): Promise<T | null> {
  const raw = await ctl(["-j", ...args]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Run a dispatcher, as a Lua expression.
 *
 * Hyprland 0.56 moved `hyprctl dispatch` to Lua: the argument is wrapped in `return hl.dispatch(…)`,
 * so the old `dispatch("workspace", "3")` form now parses as `hl.dispatch(workspace 3)` and fails
 * with a syntax error — silently, from a panel's point of view, because nothing is printed to a key.
 *
 * Callers pass a dispatcher expression such as `hl.dsp.focus({ workspace = "3" })`. The spellings
 * come from Omarchy's own `bindings/tiling.lua`, which is the authority for this machine, not from
 * memory: `hl.dsp.focus` switches workspace, `hl.dsp.window.move` moves a window to one.
 */
export async function dispatch(lua: string): Promise<boolean> {
  const result = await ctl(["dispatch", lua]);
  // hyprctl prints `ok` on success and an `error: …` line on failure, but exits 0 either way, so
  // the exit code alone would report a Lua syntax error as a successful dispatch.
  return result !== null && !result.toLowerCase().startsWith("error");
}

/** Quote a value for a Lua string literal. Workspace targets are `"3"`, `"e+1"`, `"previous"`. */
function luaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Switch to a workspace: an id, or a relative target such as `e+1`. */
export async function focusWorkspace(target: string): Promise<boolean> {
  return dispatch(`hl.dsp.focus({ workspace = ${luaString(target)} })`);
}

export async function activeWorkspace(): Promise<number | null> {
  const data = await ctlJson<{ id?: number }>(["activeworkspace"]);
  return typeof data?.id === "number" ? data.id : null;
}

export async function occupiedWorkspaces(): Promise<ReadonlySet<number>> {
  const data = await ctlJson<Workspace[]>(["workspaces"]);
  if (!Array.isArray(data)) return new Set();
  return new Set(data.filter((w) => typeof w.id === "number" && w.windows > 0).map((w) => w.id));
}

export async function activeWindowTitle(): Promise<string> {
  const data = await ctlJson<{ title?: string }>(["activewindow"]);
  return typeof data?.title === "string" ? data.title : "";
}

/**
 * Subscribe to Hyprland events. Returns a stop function.
 *
 * Events arrive as `name>>payload` lines. Only the name is surfaced: the panel re-reads state on any
 * relevant event rather than trying to apply a payload incrementally, which keeps one source of
 * truth and makes a missed event self-correcting.
 */
export function subscribe(onEvent: (name: string) => void): () => void {
  let socket: Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const connect = (): void => {
    const dir = runtimeDir();
    if (stopped || dir === null) {
      if (!stopped) timer = setTimeout(connect, 2000);
      return;
    }
    let buffer = "";
    socket = createConnection(join(dir, ".socket2.sock"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const marker = line.indexOf(">>");
        if (marker !== -1) onEvent(line.slice(0, marker));
        newline = buffer.indexOf("\n");
      }
    });
    const retry = (): void => {
      socket?.destroy();
      socket = null;
      if (!stopped) timer = setTimeout(connect, 2000);
    };
    socket.on("error", retry);
    socket.on("close", retry);
  };

  connect();
  return (): void => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.destroy();
    socket = null;
  };
}
