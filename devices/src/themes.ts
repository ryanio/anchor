/**
 * Every Omarchy palette a device could end up wearing, read from disk.
 *
 * Deliberately *not* through `omarchy theme dir`. That resolver falls back to Tokyo Night for a
 * name it cannot resolve, which is right at paint time — a device must draw something — and wrong
 * everywhere else. In `contrast.test.ts` it meant a theme whose `colors.toml` was missing got
 * measured as Tokyo Night and passed; in the review renderer it would mean a card captioned
 * "catppuccin-latte" showing Tokyo Night, which is the same class of lie and harder to notice
 * because it looks fine.
 *
 * This lived inside `contrast.test.ts` until the review renderer needed the same lookup. One reader
 * for both, so the palette a gate measures and the palette a review looks at cannot be different
 * palettes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlatToml } from "./tokens.ts";

export interface ThemeOnDisk {
  readonly name: string;
  readonly colors: Record<string, string>;
}

/** Every directory under `root` that actually carries a palette. */
export function themesIn(root: string): ThemeOnDisk[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    try {
      const colors = parseFlatToml(readFileSync(join(root, name, "colors.toml"), "utf8"));
      return Object.keys(colors).length === 0 ? [] : [{ name, colors }];
    } catch {
      return [];
    }
  });
}

/**
 * Every theme that can end up on a key: the ones this repo ships, the ones the user installed, and
 * the packaged set — in that precedence, which is the order Omarchy itself resolves them in.
 *
 * The repo's own themes are in here because CI has no Omarchy install and no
 * `~/.config/omarchy/themes`, so a theme this project authors would be the one set nothing ever
 * measured. That is exactly backwards: it is the set we are answerable for.
 */
export function installedThemes(): ThemeOnDisk[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(here, "../../themes"),
    join(homedir(), ".config/omarchy/themes"),
    "/usr/share/omarchy/themes",
  ];
  const byName = new Map<string, ThemeOnDisk>();
  for (const root of roots) {
    for (const theme of themesIn(root)) {
      if (!byName.has(theme.name)) byName.set(theme.name, theme);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One theme by its directory name, or null when it is not installed on this machine. */
export function themeOnDisk(name: string): ThemeOnDisk | null {
  return installedThemes().find((theme) => theme.name === name) ?? null;
}
