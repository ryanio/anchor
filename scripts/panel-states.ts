#!/usr/bin/env node
/**
 * Photograph every state the panel can be in.
 *
 *   node scripts/panel-states.ts            # write review/panel/*.png
 *   node scripts/panel-states.ts --list     # what would be captured
 *
 * The panel has fifteen states and a live machine is in exactly one of them, so until this existed
 * its error and warning screens had never been reviewed by anyone. `widget/PanelContent.qml` renders
 * from a single reading and takes no action of its own, which is what lets it be mounted against a
 * fixture with no service, no bar and no desktop behind it.
 *
 * Quickshell resolves `qs.Commons` and `qs.Ui` relative to its config root, so this assembles a root
 * of symlinks in a temp directory — Omarchy's shell on one side, this checkout's widget on the other
 * — rather than committing a copy of somebody else's shell to this repository, or symlinking into
 * the working tree where it would show up in every `git status` forever.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET = join(ROOT, "widget");
const OUT = join(ROOT, "review");
const OMARCHY = "/usr/share/omarchy/shell";

const require = createRequire(import.meta.url);
type Case = { id: string; title: string; looking: string; category: string };
const { CASES, BAR_CASES } = require(join(WIDGET, "gallery/states.js")) as {
  CASES: Case[];
  BAR_CASES: Case[];
};

/** Every case the harness renders, and where each one lands. */
const ALL: Array<Case & { dir: "panel" | "bar" }> = [
  ...BAR_CASES.map((c) => ({ ...c, dir: "bar" as const })),
  ...CASES.map((c) => ({ ...c, dir: "panel" as const })),
];

export type PanelCase = {
  id: string;
  title: string;
  looking: string;
  category: string;
  file: string;
  /** A bar strip rather than a panel — a few hundred pixels wide and twenty-six tall. */
  strip: boolean;
};

/** Every state, whether or not it has been captured. The review page reads this. */
export function panelCases(): PanelCase[] {
  return ALL.map((c) => ({
    id: c.id,
    title: c.title,
    looking: c.looking,
    category: c.category,
    file: `${c.dir}/${c.id}.png`,
    // Declared rather than measured off the PNG. The review page needs to lay a bar strip out
    // differently from a panel, and aspect ratio is not the discriminator it looks like: the
    // shortest setup panel is 388×98, wider-than-tall by four, and is not a bar.
    strip: c.dir === "bar",
  }));
}

/**
 * Build the import root Quickshell needs, run the harness, and return the ids it wrote.
 *
 * Everything in the root is a symlink, so the harness reads the working tree as it is — no copy to
 * keep in sync, and nothing to clean up in the repository if the run dies.
 */
export async function capturePanelStates(): Promise<string[]> {
  if (!existsSync(OMARCHY)) throw new Error(`Omarchy's shell is not at ${OMARCHY}`);

  const root = mkdtempSync(join(tmpdir(), "anchor-gallery-"));
  try {
    for (const module of ["Commons", "Ui", "services"]) {
      if (existsSync(join(OMARCHY, module))) symlinkSync(join(OMARCHY, module), join(root, module));
    }
    // The widget's own files, flat, because `PanelContent.qml` and its parts resolve as siblings.
    for (const file of readdirSync(WIDGET)) {
      if (file.endsWith(".qml") || file.endsWith(".js")) symlinkSync(join(WIDGET, file), join(root, file));
    }
    symlinkSync(join(WIDGET, "gallery/states.js"), join(root, "states.js"));
    symlinkSync(join(WIDGET, "gallery/Gallery.qml"), join(root, "shell.qml"));

    for (const dir of ["panel", "bar"]) {
      mkdirSync(join(OUT, dir), { recursive: true });
      for (const f of readdirSync(join(OUT, dir))) rmSync(join(OUT, dir, f), { force: true });
    }

    await run("quickshell", ["-p", join(root, "shell.qml")], {
      env: { ...process.env, ANCHOR_GALLERY_OUT: OUT },
      timeout: 120_000,
    });

    // What is on disk, not what the harness said it did. Quickshell's log format is not a contract,
    // and a run that claims fifteen and wrote fourteen is exactly the failure this tool exists to
    // stop being invisible.
    const wrote = (c: (typeof ALL)[number]) => existsSync(join(OUT, c.dir, `${c.id}.png`));
    const captured = ALL.filter(wrote).map((c) => c.id);
    const failed = ALL.filter((c) => !wrote(c));
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} of ${ALL.length} states did not render: ${failed.map((c) => c.id).join(", ")}`,
      );
    }
    return captured;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    for (const c of panelCases()) console.log(`${c.id.padEnd(22)} ${c.title}`);
  } else {
    const ids = await capturePanelStates();
    console.log(`\n${ids.length}/${ALL.length} states captured into ${OUT}`);
  }
}
