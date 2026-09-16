/**
 * `app/wifi_setup.cpp`, driven headlessly, through the simulator in this directory.
 *
 * This is the other half of what `esp32-firmware.test.ts` does for the decoder: that file compiles
 * the firmware's C and pushes real frames through it, and this one compiles the firmware's *screen*
 * and pushes real taps through it. Both exist for the same reason — code that only ever runs on a
 * board is code whose bugs are only ever found on a board, and this module had never run anywhere
 * at all when these cases were written.
 *
 * Every assertion below failed before the fix it names. They are read off the simulator's own
 * stdout, which is its stable interface: one line per frame describing what the panel is holding,
 * one line per `WiFi.begin`, and what NVS ended up with.
 *
 * It skips where it cannot build, exactly as the conformance suite does. A green tick from a test
 * that did not run is the failure AGENTS.md names under "check the instrument, not just the
 * reading", so the skip is loud and the reason is printed.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.sh");

/** The font header the shim borrows from the installed Arduino_GFX; see `sim/src/gfx_sim.cpp`. */
function fontAvailable(): boolean {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.ANCHOR_GFX_DIR ? join(process.env.ANCHOR_GFX_DIR, "font", "glcdfont.h") : "",
    join(home, "Arduino", "libraries", "GFX_Library_for_Arduino", "src", "font", "glcdfont.h"),
    join(home, ".arduino15", "libraries", "GFX_Library_for_Arduino", "src", "font", "glcdfont.h"),
  ];
  return candidates.some((path) => path !== "" && existsSync(path));
}

function compilerAvailable(): boolean {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

const runnable = compilerAvailable() && fontAvailable();

let workdir: string | null = null;

interface Run {
  readonly out: string;
  /** Every `WiFi.begin` the firmware made, in order. */
  readonly joins: { ssid: string; pass: string }[];
  readonly nvs: { ssid: string; pass: string };
  /** Every string the panel was holding at any captured frame. */
  readonly said: string[];
}

/*
 * A fresh unit per case.
 *
 * NVS is a file that outlives the process — which is the point of it — so a second run against the
 * same one is a unit that was already provisioned, joins in the background and never draws setup at
 * all. Every case here is about first boot, so every case gets its own store.
 */
let runCount = 0;

function sim(args: string[]): Run {
  const dir = workdir;
  assert.ok(dir !== null);
  const out = execFileSync(RUN, ["--quiet", "--nvs", join(dir, `nvs-${runCount++}.txt`), ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const joins = [...out.matchAll(/^sim: WiFi\.begin\("(.*)", "(.*)"\)/gm)].map((m) => ({
    ssid: m[1] ?? "",
    pass: m[2] ?? "",
  }));
  const nvsMatch = out.match(/^sim: NVS holds ssid="(.*)" pass="(.*)"$/m);
  const said = [...out.matchAll(/^ {4}text .*"(.*)"/gm)].map((m) => m[1] ?? "");
  return {
    out,
    joins,
    nvs: { ssid: nvsMatch?.[1] ?? "", pass: nvsMatch?.[2] ?? "" },
    said,
  };
}

/*
 * The keyboard, in coordinates, derived the way `wifi_setup.cpp` derives it rather than copied off
 * a screenshot: a row is `W / keys` wide and `KB_ROW_H` tall from `KB_TOP`. A test that hard-coded
 * pixel centres would pass against a keyboard that had silently moved.
 *
 * And the two numbers are read out of the firmware rather than written down again here, which is
 * the same rule one layer up. They were copied once, and the copy went stale the first time the
 * rows were made taller: every tap in this file landed a row off, and three cases failed for a
 * reason that had nothing to do with what they were testing. `wifi_setup.cpp` keeps this geometry
 * in one place precisely so hit-testing and drawing cannot disagree — a test holding a second
 * opinion about where the keys are is that same bug wearing a different hat.
 */
const W = 368;

function firmwareConstant(name: string): number {
  const source = readFileSync(join(HERE, "..", "app", "wifi_setup.cpp"), "utf8");
  const found = new RegExp(`constexpr int ${name} = (\\d+);`).exec(source);
  if (found?.[1] === undefined) throw new Error(`wifi_setup.cpp no longer defines ${name}`);
  return Number(found[1]);
}

const KB_TOP = firmwareConstant("KB_TOP");
const KB_ROW_H = firmwareConstant("KB_ROW_H");
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function keyAt(character: string): string {
  for (let row = 0; row < ROWS.length; row++) {
    const keys = ROWS[row] ?? "";
    const column = keys.indexOf(character);
    if (column < 0) continue;
    const keyW = Math.floor(W / keys.length);
    return `${column * keyW + Math.floor(keyW / 2)},${KB_TOP + row * KB_ROW_H + Math.floor(KB_ROW_H / 2)}`;
  }
  throw new Error(`no key for ${character}`);
}

const JOIN_KEY = `${Math.floor((W / 4) * 3.5)},${KB_TOP + 3 * KB_ROW_H + Math.floor(KB_ROW_H / 2)}`;
const CANCEL_CORNER = "340,20";
const FIRST_ROW = "180,80";
const SECOND_ROW = "180,128";

function typed(text: string): string {
  return [...text].map(keyAt).join(" ");
}

describe("wifi setup, in the simulator", { skip: !runnable }, () => {
  before(() => {
    workdir = mkdtempSync(join(tmpdir(), "anchor-pulse-sim-"));
    // Build once, loudly, before any case depends on it.
    execFileSync(RUN, ["--help"], { stdio: "pipe" });
  });

  test("the result of a join is drawn, not just recorded", () => {
    const run = sim(["--networks", "HomeNet:-42", "--taps", `${FIRST_ROW} ${typed("password")} ${JOIN_KEY}`]);

    assert.deepEqual(run.joins, [{ ssid: "HomeNet", pass: "password" }]);
    assert.equal(run.nvs.ssid, "HomeNet", "the credentials were saved");
    // The bug: `tickConnecting` recorded the result without any of the three conditions `tick`
    // redraws on, so the panel kept showing "connecting" over a unit that had already joined.
    assert.ok(run.said.includes("connected"), `the connected screen was never drawn:\n${run.out}`);
  });

  test("a failed join offers its buttons on the screen it drew them on", () => {
    const run = sim([
      "--networks",
      "HomeNet:-42",
      "--join-fail",
      "--taps",
      `${FIRST_ROW} ${typed("password")} ${JOIN_KEY}`,
    ]);

    assert.equal(run.nvs.ssid, "", "nothing is saved for a join that did not happen");
    assert.ok(run.said.includes("join failed"), `the failure was never drawn:\n${run.out}`);
    assert.ok(run.said.includes("TRY AGAIN"), "and neither were the buttons that answer it");
  });

  test("an open network is saved with the passphrase it joined with, not the one in the buffer", () => {
    const run = sim([
      "--networks",
      "Secure:-40,OpenCafe:-60:open",
      // Type three characters for the secured network, back out to the list, take the open one.
      "--taps",
      `${FIRST_ROW} ${typed("qwe")} ${CANCEL_CORNER} ${SECOND_ROW}`,
    ]);

    assert.deepEqual(run.joins, [{ ssid: "OpenCafe", pass: "" }]);
    assert.equal(run.nvs.ssid, "OpenCafe");
    // The bug: `saveCredentials(connectingSsid, entry)` persisted whatever was still in the
    // keyboard buffer, so the next boot replayed a credential that had never been used.
    assert.equal(run.nvs.pass, "", `a stale passphrase was saved: "${run.nvs.pass}"`);
  });

  test("the blank panel below the keyboard is not a JOIN button", () => {
    /*
     * Below the last row, wherever that now is.
     *
     * This used to be the literal 420, chosen when the rows were 52 tall and the keyboard stopped
     * around y=304 with a third of the panel dark under it. The rows are 84 now and the control row
     * reaches 432, so 420 is the middle of the JOIN key and this case was asserting that JOIN does
     * not join. What is left below the keyboard is only the rounded corner's clearance, which is a
     * far thinner margin for error than before and therefore more worth pinning, not less: that
     * strip is not drawn on and must not be tappable either.
     */
    const belowKeyboard = KB_TOP + 4 * KB_ROW_H + 8;
    const run = sim([
      "--networks",
      "Secure:-40",
      "--taps",
      `${FIRST_ROW} ${keyAt("q")} 320,${belowKeyboard}`,
    ]);

    assert.deepEqual(run.joins, [], `a tap on blank panel started a join:\n${run.out}`);
  });

  test("a long name and a long passphrase stay inside 368px", () => {
    const run = sim([
      "--networks",
      "AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD:-40",
      "--gap",
      "80",
      "--taps",
      `${FIRST_ROW} ${typed("qwertyuiopqwertyuiopqwertyuiop")}`,
    ]);

    // Arduino_GFX wraps rather than clips, so an overflowing string lands on whatever is drawn
    // below it. The simulator flags both, and neither may appear.
    assert.ok(!run.out.includes("PAST THE RIGHT EDGE"), `something overflowed:\n${run.out}`);
    assert.ok(!run.out.includes("WRAPPED ONTO THE NEXT LINE"), `something wrapped:\n${run.out}`);
  });

  test("every network the list holds can be picked", () => {
    const run = sim([
      "--networks",
      "A1:-40,B2:-45,C3:-50,D4:-55,E5:-60,F6:-65,G7:-70,H8:-75",
      "--taps",
      "180,80",
    ]);

    // `pickScroll` is assigned zero and nothing else, so anything past the sixth row was collected
    // and then unreachable. What the scan keeps is now what the panel can show.
    const listed = run.said.filter((text) => /^\* [A-H]\d$/.test(text));
    assert.ok(listed.length > 0, `nothing was listed:\n${run.out}`);
    assert.ok(listed.length <= 6, "no more networks are kept than the panel has rows for");
    // Strongest first, and the strongest are the ones kept — not the first six the radio returned.
    assert.deepEqual(listed, ["* A1", "* B2", "* C3", "* D4", "* E5", "* F6"]);
  });
});

if (!runnable) {
  console.log(
    "wifi setup simulator: skipped — needs a C++ compiler and GFX_Library_for_Arduino's glcdfont.h",
  );
}

process.on("exit", () => {
  if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
});
