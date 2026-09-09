/**
 * The Cardputer adapter, with no Cardputer.
 *
 * Every test here runs against `MemoryLink`, so the suite is exactly as valid on a CI runner as on
 * the desk the hardware will eventually sit on. What it covers is the half that hardware would not
 * tell you anyway: the wire encoding, the refusals, and — the point of the file — that a keyboard
 * cannot cause anything the panel had not already declared.
 *
 * The last two suites are the security ones. `AGENTS.md` invariant 1 says policy is enforced outside
 * the requester, and a device on a desk is the least trustworthy requester there is; these assert
 * that property as a shape rather than as a promise, by exhausting the input space and checking what
 * comes out.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseConfig } from "../config.ts";
import { keySlot, Panel, STRIP_SLOT } from "../panel.ts";
import { EMPTY_SNAPSHOT } from "../state/desktop.ts";
import { toTokens } from "../tokens.ts";
import type { DeviceInput, Frame, Surface } from "../types.ts";
import {
  backlightFor,
  CARDPUTER_V11,
  CardputerDevice,
  capabilitiesFor,
  decodeDeviceMessage,
  encodeTheme,
  type HostMessage,
  MAX_QUERY_LENGTH,
  MemoryLink,
  serialize,
  slotRects,
  tileSize,
} from "./cardputer.ts";

const TOKENS = toTokens("Test", {
  accent: "#7aa2f7",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  bright_foreground: "#c0caf5",
  dark_foreground: "#565f89",
  selection: "#292e42",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
});

const OFFLINE = { reachable: false, detail: "not running", hasWallet: false, primaryChain: "" };

function build(): { device: CardputerDevice; link: MemoryLink; inputs: DeviceInput[] } {
  const link = new MemoryLink();
  const device = new CardputerDevice(link, TOKENS);
  const inputs: DeviceInput[] = [];
  device.onInput((input) => inputs.push(input));
  return { device, link, inputs };
}

const tile = (label: string): Surface => ({ kind: "tile", emphasis: "ground", label });

function frameOf(entries: Record<string, Surface>): Frame {
  return new Map(Object.entries(entries));
}

/** Every paint op the link has been sent, flattened. */
function ops(link: MemoryLink): { id: string; sel?: true }[] {
  return link
    .sent()
    .filter((message): message is Extract<HostMessage, { t: "frame" }> => message.t === "frame")
    .flatMap((message) =>
      message.ops.map((op) => (op.sel === true ? { id: op.id, sel: op.sel } : { id: op.id })),
    );
}

describe("geometry", () => {
  test("the slots tile the screen exactly, with no overlap and nothing left over", () => {
    const rects = [...slotRects(CARDPUTER_V11).values()];
    const area = rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
    const { width, height } = tileSize(CARDPUTER_V11);
    assert.equal(width, 80, "240 across three columns");
    assert.equal(height, 37, "111 of usable height across three rows");
    assert.equal(area, 240 * 24 + 9 * 80 * 37, "status bar plus nine tiles");
    for (const rect of rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0, "no slot starts off-screen");
      assert.ok(rect.x + rect.w <= CARDPUTER_V11.width, "no slot runs past the right edge");
      assert.ok(rect.y + rect.h <= CARDPUTER_V11.height, "no slot runs past the bottom edge");
    }
  });

  test("it declares only the inputs it has", () => {
    const { inputs } = capabilitiesFor(CARDPUTER_V11);
    // No encoder and no touchscreen. A device that claimed `rotate` would get dial config it cannot
    // drive, which is the failure the `paintable` flag exists to prevent one layer down.
    assert.equal(inputs.includes("rotate"), false);
    assert.equal(inputs.includes("tap"), false);
    assert.deepEqual([...inputs].sort(), ["press", "release", "swipe"]);
  });
});

describe("the panel drives it unchanged", () => {
  // The claim the device layer makes is that a new device is a rendering problem, not a rewrite.
  // This is that claim, run against the real `Panel` rather than restated.
  const config = parseConfig({
    pages: [
      {
        name: "wallet",
        keys: [
          { index: 0, label: "Feed", action: "page watch" },
          { index: 4, label: "Queue", action: "" },
        ],
        segments: [{ source: "anchor.service" }],
      },
      { name: "watch", keys: [{ index: 0, label: "Back", action: "page wallet" }] },
    ],
  });

  test("nine tiles and a status bar come back from an unmodified Panel", () => {
    const { device } = build();
    const frame = new Panel(config, TOKENS).build(device, { desktop: EMPTY_SNAPSHOT, service: OFFLINE });
    assert.equal(frame.size, 10, "nine keys and the strip");
    const first = frame.get(keySlot(0));
    assert.equal(first?.kind === "tile" && first.label, "Feed");
    const bar = frame.get(STRIP_SLOT);
    assert.equal(bar?.kind, "bar");
    // Principle 7: the bar says what it covers, including that it covers nothing right now.
    assert.match(bar?.kind === "bar" ? (bar.segments[0]?.text ?? "") : "", /not running/);
  });

  test("Tab pages the panel, because Tab is a swipe", () => {
    const { device, inputs } = build();
    const panel = new Panel(config, TOKENS);
    device.handleKey("tab", true);
    const swipe = inputs[0];
    assert.equal(swipe?.kind, "swipe");
    assert.equal(panel.handle(swipe as DeviceInput), true);
    assert.equal(panel.pageName, "watch");
  });

  test("Enter on the cursor fires the action the config declared", () => {
    const { device, inputs } = build();
    const panel = new Panel(config, TOKENS);
    device.handleKey("enter", true);
    device.handleKey("enter", false);
    for (const input of inputs) panel.handle(input);
    assert.deepEqual(
      inputs.map((input) => input.kind),
      ["press", "release"],
    );
    assert.equal(panel.pageName, "watch", "key 0 on the wallet page is `page watch`");
  });
});

describe("the wire", () => {
  test("NDJSON framing survives a label that contains a newline", () => {
    // Collection names are untrusted text. A raw newline in one would otherwise end the message
    // early and let the remainder be read as a message of its own.
    const line = serialize({
      t: "frame",
      ops: [{ id: keySlot(0), x: 0, y: 24, w: 80, h: 37, s: tile("evil\nname") }],
    });
    assert.equal(line.split("\n").length, 2, "exactly one terminator, at the end");
    assert.equal(line.endsWith("\n"), true);
    assert.doesNotThrow(() => JSON.parse(line));
  });

  test("the theme message carries every token and invents none", () => {
    const message = encodeTheme(TOKENS);
    assert.ok(message.t === "theme");
    const values = Object.values(message.tokens);
    assert.equal(values.length, 11, "the whole token vocabulary");
    // Principle 8 is enforceable here: every colour the firmware ever draws has to be a value that
    // came out of the live theme, so a hex literal in this adapter would show up as a stranger.
    const fromTheme = new Set(
      Object.values(TOKENS).filter((value): value is string => typeof value === "string"),
    );
    for (const value of values) assert.ok(fromTheme.has(value), `${value} did not come from the theme`);
  });

  test("an unchanged frame costs nothing to repaint", () => {
    const { device, link } = build();
    const frame = frameOf({ [keySlot(0)]: tile("Feed") });
    return device
      .paint(frame)
      .then(() => device.paint(frameOf({ [keySlot(0)]: tile("Feed") })))
      .then(() => {
        // An idle panel on a battery must not be writing bytes down a cable every tick.
        assert.equal(ops(link).length, 1);
      });
  });

  test("a cursor move repaints the two tiles it touched and nothing else", async () => {
    const { device, link } = build();
    await device.paint(frameOf(Object.fromEntries([0, 1, 3].map((i) => [keySlot(i), tile(`k${i}`)]))));
    const before = ops(link).length;
    device.moveCursor(1, 0);
    const moved = ops(link).slice(before);
    assert.deepEqual(
      moved.map((op) => op.id),
      [keySlot(0), keySlot(1)],
    );
    assert.equal(moved[1]?.sel, true, "the new tile is the selected one");
  });
});

describe("decodeDeviceMessage", () => {
  test("accepts the three messages the firmware sends", () => {
    assert.deepEqual(decodeDeviceMessage('{"t":"hello","proto":1,"fw":"0.1.0","width":240,"height":135}'), {
      t: "hello",
      proto: 1,
      fw: "0.1.0",
      width: 240,
      height: 135,
    });
    assert.deepEqual(decodeDeviceMessage('{"t":"key","key":"down","down":true}'), {
      t: "key",
      key: "down",
      down: true,
      shift: false,
    });
    assert.deepEqual(decodeDeviceMessage('{"t":"power","percent":62.4,"charging":false}'), {
      t: "power",
      percent: 62,
      charging: false,
    });
  });

  test("drops anything it does not fully understand rather than half-believing it", () => {
    for (const line of [
      "",
      "not json",
      "[]",
      "null",
      '{"t":"key"}',
      '{"t":"key","key":"down"}',
      '{"t":"key","key":"pgup","down":true}',
      '{"t":"hello","proto":1,"fw":"x","width":0,"height":135}',
      '{"t":"power","percent":"lots","charging":false}',
      '{"t":"execute","request":"buy"}',
      `{"t":"key","key":"${"a".repeat(5000)}","down":true}`,
    ]) {
      assert.equal(decodeDeviceMessage(line), null, `should have refused: ${line.slice(0, 40)}`);
    }
  });

  test("refuses a control character dressed as a key", () => {
    // A rogue keyboard reporting an escape sequence would otherwise put terminal control bytes into
    // a string this process writes to its own stderr.
    assert.equal(decodeDeviceMessage('{"t":"key","key":"\\u001b","down":true}'), null);
    assert.equal(decodeDeviceMessage('{"t":"key","key":"\\u0000","down":true}'), null);
  });

  test("clamps a charge level rather than trusting it", () => {
    const high = decodeDeviceMessage('{"t":"power","percent":900,"charging":true}');
    const low = decodeDeviceMessage('{"t":"power","percent":-40,"charging":false}');
    assert.equal(high?.t === "power" && high.percent, 100);
    assert.equal(low?.t === "power" && low.percent, 0);
  });
});

describe("the keyboard in navigate mode", () => {
  test("arrows move the cursor and emit nothing", () => {
    const { device, inputs } = build();
    assert.equal(device.selectedSlot, keySlot(0));
    device.handleKey("right", true);
    device.handleKey("down", true);
    assert.equal(device.selectedSlot, keySlot(4));
    // Focus is device-local. Announcing it would put a device's cursor into shared panel logic.
    assert.deepEqual(inputs, []);
  });

  test("the cursor clamps at every edge instead of wrapping", () => {
    const { device } = build();
    device.handleKey("up", true);
    device.handleKey("left", true);
    assert.equal(device.selectedSlot, keySlot(0), "top-left stays put");
    for (let i = 0; i < 6; i++) {
      device.handleKey("right", true);
      device.handleKey("down", true);
    }
    assert.equal(device.selectedSlot, keySlot(8), "bottom-right stays put");
  });

  test("a number key selects that tile and presses it", () => {
    const { device, inputs } = build();
    device.handleKey("5", true);
    device.handleKey("5", false);
    assert.equal(device.selectedSlot, keySlot(4));
    assert.deepEqual(inputs, [
      { kind: "press", slot: keySlot(4) },
      { kind: "release", slot: keySlot(4) },
    ]);
  });

  test("shift-Tab pages backwards", () => {
    const { device, inputs } = build();
    device.handleKey("tab", true, true);
    const swipe = inputs[0];
    assert.equal(swipe?.kind === "swipe" && swipe.to < swipe.from, true);
  });

  test("a lost release still lets the key go", () => {
    // Without this a tile stays in its pressed emphasis for good, and the panel thinks a key is held.
    const { device, inputs } = build();
    device.handleKey("3", true);
    device.handleKey("esc", false);
    assert.deepEqual(
      inputs.map((input) => input.kind),
      ["press", "release"],
    );
  });
});

describe("the keyboard in filter mode", () => {
  test("typing emits no input at all", () => {
    const { device, inputs } = build();
    device.handleKey("/", true);
    assert.equal(device.mode, "filter");
    for (const char of [..."azuki 1 enter"]) device.handleKey(char, true);
    // The whole reason filtering is a mode: a filter box that can also fire a key action is a filter
    // box that dispatches an action by accident.
    assert.deepEqual(inputs, []);
    assert.equal(device.query, "azuki 1 enter");
  });

  test("arrows and Tab do nothing mid-word", () => {
    const { device, inputs } = build();
    device.handleKey("/", true);
    device.handleKey("a", true);
    for (const key of ["up", "down", "left", "right", "tab"]) device.handleKey(key, true);
    assert.deepEqual(inputs, [], "a stray arrow must not page the panel out from under the typing");
    assert.equal(device.query, "a");
  });

  test("Enter commits the text to onQuery and leaves the mode", () => {
    const { device, inputs } = build();
    const committed: string[] = [];
    device.onQuery((text) => committed.push(text));
    device.handleKey("/", true);
    for (const char of [..."azuki"]) device.handleKey(char, true);
    device.handleKey("enter", true);
    assert.deepEqual(committed, ["azuki"]);
    assert.equal(device.mode, "navigate");
    // Committing a filter is not pressing anything. Text narrows a view; it never dispatches.
    assert.deepEqual(inputs, []);
  });

  test("Esc abandons the filter", () => {
    const { device } = build();
    const committed: string[] = [];
    device.onQuery((text) => committed.push(text));
    device.handleKey("/", true);
    device.handleKey("a", true);
    device.handleKey("esc", true);
    assert.equal(device.query, "");
    assert.equal(device.mode, "navigate");
    assert.deepEqual(committed, [""]);
  });

  test("backspace deletes, and the box has a length limit", () => {
    const { device } = build();
    device.handleKey("/", true);
    for (let i = 0; i < MAX_QUERY_LENGTH + 20; i++) device.handleKey("x", true);
    assert.equal(device.query.length, MAX_QUERY_LENGTH);
    device.handleKey("backspace", true);
    assert.equal(device.query.length, MAX_QUERY_LENGTH - 1);
  });
});

describe("the boundary", () => {
  test("no keystroke, in any mode, produces anything but press, release or swipe", () => {
    // AGENTS.md invariant 1. The device may render a proposal and say "I am looking at this"; it can
    // never say "do it". This exhausts the key space to show that as a property of the mapping rather
    // than of anyone's care.
    const { device, inputs } = build();
    const keys = [
      "up",
      "down",
      "left",
      "right",
      "enter",
      "esc",
      "tab",
      "backspace",
      ...[..."0123456789abcdefyYnN/\\ !@#$%^&*()-=[]{};':\",.<>?|`~"],
    ];
    for (const mode of ["navigate", "filter"] as const) {
      if (mode === "filter") device.handleKey("/", true);
      for (const key of keys) {
        device.handleKey(key, true, true);
        device.handleKey(key, false, true);
      }
    }
    const allowed = new Set(["press", "release", "swipe"]);
    const slots = new Set(device.capabilities.slots.map((slot) => slot.id));
    for (const input of inputs) {
      assert.ok(allowed.has(input.kind), `unexpected input kind ${input.kind}`);
      assert.ok(slots.has(input.slot), `input for an undeclared slot: ${input.slot}`);
    }
    assert.ok(inputs.length > 0, "the mapping should do something, or this test proves nothing");
  });

  test("a hostile device cannot make the adapter say anything but its own protocol", () => {
    const { link, inputs } = build();
    for (const line of [
      '{"t":"execute","kind":"buy","price":"999"}',
      '{"t":"key","key":"enter","down":true,"slot":"executor"}',
      '{"t":"approve","request":"0xdeadbeef"}',
      '{"t":"power","percent":50,"charging":true,"cmd":"rm -rf /"}',
      " garbage",
    ]) {
      link.receive(line);
    }
    for (const input of inputs) {
      assert.ok(["press", "release", "swipe"].includes(input.kind));
      assert.notEqual(input.slot, "executor");
    }
    const kinds = new Set(link.sent().map((message) => message.t));
    for (const kind of kinds) {
      assert.ok(["hello", "theme", "frame", "query", "backlight", "ping", "clear"].includes(kind));
    }
  });
});

describe("power", () => {
  test("dims on battery and never all the way off", () => {
    // A dark screen and a screen showing an hour-old floor price look identical from a desk.
    assert.equal(backlightFor(70, null), 70);
    assert.equal(backlightFor(70, { percent: 8, charging: true }), 70, "charging is not battery");
    assert.ok(backlightFor(70, { percent: 25, charging: false }) < 70);
    assert.ok(backlightFor(70, { percent: 5, charging: false }) >= 15);
    assert.ok(backlightFor(100, { percent: 5, charging: false }) < backlightFor(100, null));
  });

  test("a charge report re-derives the backlight without being asked", async () => {
    const { device, link } = build();
    await device.setBrightness(80);
    link.receive({ t: "power", percent: 6, charging: false });
    const backlights = link
      .sent()
      .filter((message): message is Extract<HostMessage, { t: "backlight" }> => message.t === "backlight");
    assert.equal(backlights.at(0)?.percent, 80);
    assert.ok((backlights.at(-1)?.percent ?? 100) < 80);
    assert.equal(device.power?.percent, 6);
  });
});

describe("lifecycle", () => {
  test("greeting hands over the protocol version and the palette", async () => {
    const { device, link } = build();
    await device.greet();
    assert.deepEqual(
      link.sent().map((message) => message.t),
      ["hello", "theme"],
    );
  });

  test("a theme change reaches the device and forces a full redraw", async () => {
    const { device, link } = build();
    await device.paint(frameOf({ [keySlot(0)]: tile("Feed") }));
    const before = ops(link).length;
    device.tokens = toTokens("Nord", { accent: "#88c0d0" });
    await device.paint(frameOf({ [keySlot(0)]: tile("Feed") }));
    assert.ok(link.sent().some((message) => message.t === "theme"));
    assert.equal(ops(link).length, before + 1, "the same tile repaints under a new palette");
  });

  test("closing clears the screen and closes the link", async () => {
    const { device, link } = build();
    await device.close();
    assert.equal(link.sent().at(-1)?.t, "clear");
    assert.equal(link.closed, true);
  });
});
