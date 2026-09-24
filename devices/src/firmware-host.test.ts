/**
 * The firmware's host-side C++ checks, compiled with the host `c++` and run.
 *
 * Each program is its own test and fails by exiting non-zero; the quiet ones also print nothing on
 * success. CI has a compiler and must run all of them, so a missing `c++` fails there and only
 * skips on a machine without one.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const FIRMWARE = join(dirname(fileURLToPath(import.meta.url)), "..", "firmware");
const COMMON = join(FIRMWARE, "common");
const ESP32 = join(FIRMWARE, "esp32");
const CARDPUTER = join(FIRMWARE, "cardputer", "app");
const HAS_COMPILER = spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;

interface HostProgram {
  readonly name: string;
  readonly sources: readonly string[];
  readonly includes?: readonly string[];
  /** Arguments for the built program, given a scratch directory it may write to. */
  readonly args?: (work: string) => string[];
  /** Success is also silence: any output is a failed check. */
  readonly quiet?: boolean;
}

const PROGRAMS: readonly HostProgram[] = [
  {
    name: "both handhelds format money and untrusted text with one shared, pinned implementation",
    sources: [join(COMMON, "display_format_test.cpp")],
    quiet: true,
  },
  {
    name: "both handhelds describe a reading's age with one shared, wrap-safe function",
    sources: [join(COMMON, "freshness_test.cpp")],
    quiet: true,
  },
  {
    name: "firmware requests reject cancelled generations and keep their bounded slot",
    sources: [join(COMMON, "request_gate_test.cpp")],
    quiet: true,
  },
  {
    // The companion must never say a number the rest of the unit does not show.
    name: "the ESP32 companion reacts to the readings and says only what the feed formatted",
    sources: [join(ESP32, "host", "companion.cpp")],
    quiet: true,
  },
  {
    // The keypad layout decides which characters a passphrase can contain.
    name: "the ESP32 keypad reaches every printable ASCII character in three taps or fewer",
    sources: [join(ESP32, "host", "keypad.cpp")],
    quiet: true,
  },
  {
    name: "ESP32 feed requests invalidate obsolete work without freeing an active worker early",
    sources: [join(ESP32, "host", "feed_request.cpp")],
    includes: [ESP32],
  },
  {
    name: "ESP32 Preferences round-trip the largest four-profile blob and scope destructive operations",
    sources: [join(ESP32, "host", "preferences.cpp"), join(ESP32, "sim", "src", "prefs_sim.cpp")],
    includes: [join(ESP32, "sim", "include")],
    args: (work) => [join(work, "preferences.txt")],
  },
  {
    name: "Cardputer requests publish into loop-owned state only for current generations",
    sources: [join(CARDPUTER, "host", "request_publication.cpp")],
    includes: [join(CARDPUTER, "src")],
  },
  {
    name: "Cardputer chain and address together identify a detail",
    sources: [join(CARDPUTER, "host", "token_identity.cpp")],
    includes: [join(CARDPUTER, "src")],
  },
  {
    name: "Cardputer rejects identities that would change during a bounded copy",
    sources: [join(CARDPUTER, "host", "token_identity_input.cpp")],
    includes: [join(CARDPUTER, "src")],
  },
];

describe("firmware host programs", {
  concurrency: true,
  skip: !HAS_COMPILER && process.env.CI !== "true",
}, () => {
  for (const program of PROGRAMS) {
    test(program.name, async () => {
      assert.equal(HAS_COMPILER, true, "c++ is required to run the firmware host checks in CI");
      const work = mkdtempSync(join(tmpdir(), "anchor-firmware-host-"));
      try {
        const binary = join(work, "program");
        const includes = (program.includes ?? []).map((dir) => `-I${dir}`);
        await run("c++", [
          "-std=c++17",
          "-Wall",
          "-Wextra",
          "-Werror",
          ...includes,
          "-o",
          binary,
          ...program.sources,
        ]);
        const result = spawnSync(binary, program.args?.(work) ?? [], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        if (program.quiet) assert.equal(result.stdout, "");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
