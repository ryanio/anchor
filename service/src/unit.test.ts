/**
 * The line that decides whether the machine comes back after a reboot.
 *
 * `installService` shells out to systemd, so what is tested here is the part that does not: turning
 * the packaged unit into one that points at a checkout. A wrong `ExecStart` fails at boot, hours
 * later, in a journal nobody is reading — which is the same shape as the bug this whole command
 * exists to fix.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { renderUnit } from "./unit.ts";

const packaged = readFileSync(
  fileURLToPath(new URL("../../packaging/anchor-service.service", import.meta.url)),
  "utf8",
);

describe("pointing the unit at a checkout", () => {
  test("replaces ExecStart, and only ExecStart", () => {
    const out = renderUnit(packaged, "/usr/bin/node", "/home/you/anchor/service/src/index.ts");
    const execs = out.split("\n").filter((l) => l.startsWith("ExecStart="));
    assert.equal(execs.length, 1, "exactly one ExecStart, or systemd takes the last one");
    assert.equal(
      execs[0],
      "ExecStart=/usr/bin/node --experimental-strip-types /home/you/anchor/service/src/index.ts",
    );
  });

  test("keeps the hardening and the install section", () => {
    // The reason to rewrite the packaged unit rather than write one from scratch: everything else
    // in it — the sandboxing, the restart policy, `WantedBy=graphical-session.target` — is the part
    // that was thought about, and `WantedBy` is what makes `enable` mean anything.
    const out = renderUnit(packaged, "/usr/bin/node", "/x/index.ts");
    for (const line of [
      "NoNewPrivileges=yes",
      "ProtectSystem=full",
      "Restart=on-failure",
      "PartOf=graphical-session.target",
      "WantedBy=graphical-session.target",
    ]) {
      assert.ok(out.includes(line), `${line} must survive the rewrite`);
    }
  });

  test("says where it came from, so the next person can re-run it", () => {
    const out = renderUnit(packaged, "/usr/bin/node", "/x/index.ts");
    assert.match(out, /--install-service/);
    assert.ok(out.startsWith("#"), "the note belongs at the top where it is read");
  });

  test("refuses a template with nothing to repoint", () => {
    // Silently writing a unit with the packaged /usr/bin/anchor-service path would install
    // something that cannot start on a machine that has no package.
    assert.throws(() => renderUnit("[Service]\nType=simple\n", "/usr/bin/node", "/x"), /ExecStart/);
  });

  test("absolute paths, both of them", () => {
    // A unit inherits no useful PATH. `node` alone works in a shell and fails at boot.
    const out = renderUnit(packaged, "/usr/bin/node", "/x/index.ts");
    const exec = out.split("\n").find((l) => l.startsWith("ExecStart="))!;
    for (const word of exec.slice("ExecStart=".length).split(" ")) {
      if (word.startsWith("--")) continue;
      assert.ok(word.startsWith("/"), `${word} is not absolute`);
    }
  });
});
