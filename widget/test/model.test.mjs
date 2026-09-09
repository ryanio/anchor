/**
 * Tests for the widget's pure logic.
 *
 * These cover the promises the widget makes at its boundary — that marketplace text cannot escape
 * a label, that money is never rounded through a float, that every degraded state has a defined
 * appearance, and that a dimmed value stays readable on the user's theme — rather than the shape
 * of any particular helper.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const Model = require("../PulseModel.js");

// -------------------------------------------------------------------------------------------
// Untrusted marketplace content
// -------------------------------------------------------------------------------------------

test("strips bidi overrides, which can reorder the text beside them", () => {
  // RIGHT-TO-LEFT OVERRIDE makes "gpu.exe" render as "exe.upg" in a naive label.
  assert.equal(Model.sanitize("Bored‮Apes"), "BoredApes");
  assert.equal(Model.sanitize("⁦⁧spoof⁩⁩"), "spoof");
  assert.equal(Model.sanitize("safe‏name"), "safename");
});

test("strips zero-width padding, so a name cannot lie about its length", () => {
  const padded = `A${"​".repeat(500)}B`;
  assert.equal(Model.sanitize(padded), "AB");
  assert.equal(Model.sanitize("soft­hyphen"), "softhyphen");
});

test("folds control characters to spaces rather than deleting them", () => {
  // Deleting the newline would join two words into a third that was never in the data.
  assert.equal(Model.sanitize("Cool\nCats"), "Cool Cats");
  // Written as escapes, not as literal bytes. A raw NUL in the source makes the whole file
  // read as binary: `file` reports "data", and grep/ripgrep skip it silently, so a search for
  // anything in this file comes back empty and looks like an answer.
  assert.equal(Model.sanitize("Cool\u0000\u0007Cats"), "Cool Cats");
  assert.equal(Model.sanitize("tab\tsep"), "tab sep");
});

test("caps stacked combining marks so a name cannot paint over the bar", () => {
  const zalgo = `h${"́".repeat(60)}i`;
  const cleaned = Model.sanitize(zalgo);
  assert.equal(cleaned, "h́́i");
  // Real accented text is untouched.
  assert.equal(Model.sanitize("Pokémon"), "Pokémon");
});

test("truncates by code point, never splitting a surrogate pair", () => {
  const long = "🐙".repeat(50);
  const out = Model.sanitize(long, 10);
  assert.equal(Array.from(out).length, 10);
  assert.ok(out.endsWith("…"));
  // Half an octopus is a replacement box. Every code point must be a whole character: after
  // `Array.from` splits on code points, a surviving lone surrogate would show up as one.
  for (const ch of Array.from(out)) {
    assert.ok(!/^[\uD800-\uDFFF]$/.test(ch), `lone surrogate in ${JSON.stringify(out)}`);
  }
});

test("markup is preserved as text, not interpreted — the renderer is PlainText", () => {
  // The defence is `textFormat: Text.PlainText` in the QML (asserted in qml.test.mjs). The model
  // must not mangle a legitimate name that happens to contain angle brackets.
  assert.equal(Model.sanitize("<b>Punks</b>"), "<b>Punks</b>");
});

test("non-strings and empty input sanitise to an empty string, never to a crash", () => {
  for (const input of [null, undefined, 42, {}, [], Number.NaN]) {
    assert.equal(Model.sanitize(input), "");
  }
});

test("a currency ticker that is not a ticker is dropped rather than rendered", () => {
  assert.equal(Model.sanitizeSymbol("WETH"), "WETH");
  assert.equal(Model.sanitizeSymbol("ETH"), "ETH");
  assert.equal(Model.sanitizeSymbol("$$ CLICK HERE $$"), "");
  assert.equal(Model.sanitizeSymbol("<script>"), "");
  assert.equal(Model.sanitizeSymbol("2SHORT"), "");
});

// -------------------------------------------------------------------------------------------
// Links
// -------------------------------------------------------------------------------------------

test("a link is built only from a slug that is definitely a slug", () => {
  assert.equal(Model.collectionUrl("boredapeyachtclub"), "https://opensea.io/collection/boredapeyachtclub");
  // Every one of these would otherwise produce a URL pointing somewhere else entirely.
  assert.equal(Model.collectionUrl("../../../evil"), null);
  assert.equal(Model.collectionUrl("a b"), null);
  assert.equal(Model.collectionUrl("javascript:alert(1)"), null);
  assert.equal(Model.collectionUrl("https://evil.example"), null);
  assert.equal(Model.collectionUrl(""), null);
  assert.equal(Model.collectionUrl(null), null);
});

test("an account link requires a real address on a chain we support", () => {
  const evm = `0x${"a".repeat(40)}`;
  assert.equal(Model.accountUrl(evm), `https://opensea.io/${evm}`);
  assert.equal(Model.accountUrl("0xdead"), null);
  assert.equal(Model.accountUrl("not-an-address"), null);
});

// -------------------------------------------------------------------------------------------
// Money
// -------------------------------------------------------------------------------------------

test("rounds decimal strings half-up with a carry, never through a float", () => {
  assert.equal(Model.roundDecimal("0.995", 2), "1.00");
  assert.equal(Model.roundDecimal("9.99", 1), "10.0");
  assert.equal(Model.roundDecimal("1.2345", 2), "1.23");
  assert.equal(Model.roundDecimal("1.005", 2), "1.01"); // the classic float failure
  assert.equal(Model.roundDecimal("-1.005", 2), "-1.01");
  assert.equal(Model.roundDecimal("12", 2), "12");
});

test("a total larger than Number.MAX_SAFE_INTEGER keeps every digit", () => {
  const huge = "123456789012345678901.55";
  assert.equal(Model.roundDecimal(huge, 1), "123456789012345678901.6");
  // Proof the naive route would have been wrong.
  assert.notEqual(String(Number(huge)), huge);
  assert.equal(Model.groupDigits("1234567.89"), "1,234,567.89");
});

test("moves a decimal point within one denomination and no further", () => {
  assert.equal(Model.formatUnits("1234500000000000000", 18), "1.234500000000000000");
  assert.equal(Model.formatUnits("1", 18), "0.000000000000000001");
  assert.equal(Model.formatUnits("500000", 6), "0.500000");
  assert.equal(Model.formatUnits("42", 0), "42");
  assert.equal(Model.formatUnits("not a number", 18), null);
  assert.equal(Model.formatUnits(null, 18), null);
});

test("compacts to about three significant digits", () => {
  assert.equal(Model.compactDecimal("12345"), "12.3K");
  assert.equal(Model.compactDecimal("1234567"), "1.23M");
  assert.equal(Model.compactDecimal("999"), "999");
  assert.equal(Model.compactDecimal("0.5"), "0.5");
  assert.equal(Model.compactDecimal("-4200"), "-4.2K");
  assert.equal(Model.compactDecimal("1000000000000000"), "1000T");
});

test("renders an amount in the denomination it arrived in and no other", () => {
  assert.equal(Model.formatMoney("12345.67", { symbol: "USD" }), "$12.3K");
  assert.equal(Model.formatMoney("1.5", { symbol: "ETH" }), "1.5 ETH");
  assert.equal(Model.formatMoney("1.5", { symbol: "WETH" }), "1.5 WETH");
  assert.equal(Model.formatMoney("-200", { symbol: "USD" }), "-$200.00");
  // No symbol means no currency is claimed, rather than a default one being assumed.
  assert.equal(Model.formatMoney("1.5", {}), "1.5");
  assert.equal(Model.formatMoney("1.5", { symbol: "🤑" }), "1.5");
});

test("a deadline says which wallet it is on", () => {
  // The service tags every merged row with the wallet it came from. With nine wallets a countdown
  // on something you cannot identify is a decision you cannot act on.
  const state = stateWith({
    health: health(),
    activity: {
      data: { assetEvents: [offerEvent({ anchorWallet: `0x${"d".repeat(40)}` })] },
      receivedAt: NOW,
    },
  });
  const [first] = Model.deadlines(state, NOW);
  assert.equal(first.wallet, `0x${"d".repeat(40)}`);
});

test("a total is the sum of every wallet, and each wallet is still readable", () => {
  // The service fans out and reports each wallet beside the sum, so this reads rather than derives:
  // every row is a figure that wallet's own portfolio page would show. Nothing divides a total.
  const state = stateWith({
    health: health({ wallets: ["0xaa", "0xbb", "0xcc"] }),
    portfolio: {
      data: {
        stats: { totalValueUsd: "300.30" },
        wallets: [
          { address: `0x${"a".repeat(40)}`, totalValueUsd: "100.10" },
          { address: `0x${"b".repeat(40)}`, totalValueUsd: "200.20" },
        ],
        incomplete: [],
      },
      receivedAt: NOW,
    },
    updatedAt: NOW,
  });

  const split = Model.portfolioBreakdown(state, Model.mergeSettings({}), "wallet");
  // Biggest first: a nine-row list in whatever order a JWT happened to list them is a list nobody
  // reads past the third row.
  // Rows are the magnitude form, as every other breakdown's rows are; the total under them is
  // exact. That is the split between "how big is each" and "what does it add to".
  assert.deepEqual(
    split.rows.map((r) => r.text),
    ["$200.00", "$100.00"],
  );
  assert.deepEqual(
    split.rows.map((r) => r.value),
    ["200.20", "100.10"],
    "the underlying figures keep their cents even where the label rounds",
  );
  assert.equal(split.totalText, "$300.30");
  assert.match(split.scope, /by wallet/);
});

test("a total missing a wallet says so, in the line that makes the claim", () => {
  // The service reports what it could not read rather than trimming it. This is the half that makes
  // reporting it worth anything — a total silently missing a wallet is the bug the fan-out fixes.
  const missing = stateWith({
    health: health({ wallets: ["0xaa", "0xbb", "0xcc"] }),
    portfolio: {
      data: { stats: { totalValueUsd: "2" }, wallets: [], incomplete: [`0x${"c".repeat(40)}`] },
      receivedAt: NOW,
    },
    updatedAt: NOW,
  });
  assert.match(Model.provenance(missing, NOW), /^2 of 3 wallets/);

  const whole = stateWith({
    health: health({ wallets: ["0xaa", "0xbb", "0xcc"] }),
    portfolio: { data: { stats: { totalValueUsd: "3" }, wallets: [], incomplete: [] }, receivedAt: NOW },
    updatedAt: NOW,
  });
  assert.match(Model.provenance(whole, NOW), /^3 wallets/);
});

test("rounding into the next magnitude takes the next magnitude with it", () => {
  // $999.99 chose "no unit" from its digits, rounded to 1000, and rendered "$1000.00" in a column
  // of "$4.44K". The tier has to be checked against the rounding, not only against the input.
  assert.equal(Model.formatMoney("999.99", { symbol: "USD" }), "$1K");
  assert.equal(Model.formatMoney("999999.9", { symbol: "USD" }), "$1M");
  assert.equal(Model.formatMoney("999999999.5", { symbol: "USD" }), "$1B");
  // Not rounding up is unchanged.
  assert.equal(Model.formatMoney("999.4", { symbol: "USD" }), "$999.00");
  assert.equal(Model.formatMoney("1234", { symbol: "USD" }), "$1.23K");
});

test("a hidden value is distinguishable from no value", () => {
  // The bug: with `showValue` off the bar drew a lone mark, which is exactly what an unconfigured
  // install draws. Measured on the two rendered strips, they were 4% apart in luminance on an 11px
  // glyph — not a signal anybody reads. `value` alone cannot tell them apart, so the label says
  // which case it is.
  const configured = stateWith({
    health: health(),
    portfolio: { data: { stats: { totalValueUsd: "1234.56" } }, receivedAt: NOW },
    activity: { data: { assetEvents: [] }, receivedAt: NOW },
    updatedAt: NOW,
  });

  const shown = Model.barLabel(configured, NOW, Model.mergeSettings({}));
  assert.equal(shown.value, "$1.23K");
  assert.equal(shown.valueHidden, false);

  const hidden = Model.barLabel(configured, NOW, Model.mergeSettings({ showValue: false }));
  assert.equal(hidden.value, "", "the figure itself must not reach the bar");
  assert.equal(hidden.valueHidden, true);

  // Nothing to hide is not hiding. An unconfigured install must not draw the placeholder.
  const fresh = stateWith({
    health: health({ wallet: "", collections: [], credentials: { apiKey: false, pat: false } }),
  });
  assert.equal(Model.barLabel(fresh, NOW, Model.mergeSettings({ showValue: false })).valueHidden, false);
});

test("an offline status line is short enough for the place it is shown", () => {
  // It is a hero subtitle and a one-line tooltip, both of which elide. The long form ran off the
  // end — "DATA SERVICE UNREACHABLE · LAST READING NOW…" — while repeating what the panel prints
  // directly underneath it.
  const warm = stateWith({ health: health(), healthError: "connection refused", updatedAt: NOW - 60_000 });
  const cold = stateWith({ healthError: "connection refused" });

  assert.equal(Model.statusDetail(warm, NOW), "data service not answering");
  assert.equal(Model.statusDetail(cold, NOW), "data service not running");
  for (const state of [warm, cold]) {
    assert.ok(Model.statusDetail(state, NOW).length <= 30, "an offline line has to fit the hero");
  }
});

test("USD is always two decimal places, and only USD", () => {
  // The bug this exists for: `$125,430.5` reached Ryan's bar. USD has exactly two decimal places
  // by definition, so a dollar figure with one is not a dollar figure.
  assert.equal(Model.formatMoney("125430.5", { symbol: "USD", exact: true }), "$125,430.50");
  assert.equal(Model.formatMoney("1234", { symbol: "USD", exact: true }), "$1,234.00");
  assert.equal(Model.formatMoney("0.5", { symbol: "USD", exact: true }), "$0.50");
  assert.equal(Model.formatMoney("-9.9", { symbol: "USD", exact: true }), "-$9.90");
  // And it rounds to the minor unit rather than showing eight places of it.
  assert.equal(Model.formatMoney("1.005", { symbol: "USD", exact: true }), "$1.01");

  // The compact form below its first unit is still an amount, so it pads too.
  assert.equal(Model.formatMoney("11.1", { symbol: "USD" }), "$11.10");
  assert.equal(Model.formatMoney("999", { symbol: "USD" }), "$999.00");
  // With a unit on it, it is a magnitude: padding "$125.00K" pads a rounding, not a cent.
  assert.equal(Model.formatMoney("125430.5", { symbol: "USD" }), "$125K");
  assert.equal(Model.formatMoney("1250", { symbol: "USD" }), "$1.25K");

  // And it must not leak. A denomination with no fixed minor unit keeps its own precision, and
  // trailing zeros there would claim a precision the response never made.
  assert.equal(Model.formatMoney("1.5", { symbol: "ETH", exact: true }), "1.5 ETH");
  assert.equal(Model.formatMoney("2", { symbol: "WETH", exact: true }), "2 WETH");
  assert.equal(Model.formatMoney("1.5", { exact: true }), "1.5");

  assert.equal(Model.padFraction("1.5", 2), "1.50");
  assert.equal(Model.padFraction("1", 2), "1.00");
  assert.equal(Model.padFraction("1.234", 2), "1.234", "padding never truncates");
});

test("there is no exchange rate anywhere in the model", () => {
  // A regression guard with teeth: an ETH amount must never come back denominated in dollars,
  // whatever else is on the object.
  const out = Model.formatMoney("2", { symbol: "ETH", usdPrice: "3000" });
  assert.equal(out, "2 ETH");
  assert.ok(!out.includes("$"));
});

test("an offer's worth is read from its own payment, in its own token", () => {
  assert.equal(
    Model.paymentAmount({ quantity: "1500000000000000000", decimals: 18, symbol: "WETH" }),
    "1.5 WETH",
  );
  // `/balances` uses the opposite convention; a missing or malformed payment yields nothing
  // rather than a wrong number.
  assert.equal(Model.paymentAmount({ quantity: "abc", decimals: 18, symbol: "WETH" }), "");
  assert.equal(Model.paymentAmount(null), "");
});

test("a percentage change reads its sign from the string, including a leading +", () => {
  // `/portfolio/value` returns pnlPercentage as "+1.01". A parser that rejects `+` drops gains.
  assert.deepEqual(Model.formatChange("+1.01"), { direction: "up", arrow: "▲", text: "1%" });
  assert.deepEqual(Model.formatChange("-0.44"), { direction: "down", arrow: "▼", text: "0.4%" });
  assert.deepEqual(Model.formatChange("0"), { direction: "flat", arrow: "", text: "0%" });
  assert.equal(Model.formatChange("nonsense"), null);
});

test("a floor price arriving as a small double is expanded, not dropped", () => {
  // collectionStats.total.floorPrice is a JS double; String(1e-7) is "1e-7".
  assert.equal(Model.numberToDecimal(1e-7), "0.0000001");
  assert.equal(Model.numberToDecimal(1.42), "1.42");
});

// -------------------------------------------------------------------------------------------
// Time
// -------------------------------------------------------------------------------------------

test("reads Unix seconds and ISO strings, and never confuses the two", () => {
  // Every timestamp in these payloads is seconds. Read as ms, 2025 lands in 1970.
  assert.equal(Model.toMillis(1777334400), 1777334400000);
  assert.equal(Model.toMillis("1777334400"), 1777334400000);
  assert.equal(Model.toMillis(1777334400000), 1777334400000);
  assert.equal(Model.toMillis("2026-05-01T00:00:00Z"), Date.parse("2026-05-01T00:00:00Z"));
  assert.equal(Model.toMillis(null), null);
  assert.equal(Model.toMillis("later"), null);
});

test("countdowns and ages read the way a person would say them", () => {
  assert.equal(Model.countdown(90 * 60 * 1000), "1h 30m");
  assert.equal(Model.countdown(8 * 60 * 1000), "8m");
  assert.equal(Model.countdown(30 * 1000), "<1m");
  assert.equal(Model.countdown(-1), "ended");
  assert.equal(Model.countdown(50 * 3600 * 1000), "2d 2h");

  assert.equal(Model.relativeAge(10), "now");
  assert.equal(Model.relativeAge(300), "5m");
  assert.equal(Model.relativeAge(7200), "2h");
});

// -------------------------------------------------------------------------------------------
// Contrast, against whatever theme the desktop is wearing
// -------------------------------------------------------------------------------------------

const WHITE = { r: 1, g: 1, b: 1 };
const BLACK = { r: 0, g: 0, b: 0 };

test("computes WCAG contrast on live theme colours", () => {
  assert.equal(Math.round(Model.contrastRatio(WHITE, BLACK)), 21);
  assert.equal(Model.contrastRatio(WHITE, WHITE), 1);
});

test("dimming is clamped so faded text stays readable on the user's theme", () => {
  // A high-contrast theme can afford the full fade.
  const roomy = Model.dimAlpha(WHITE, BLACK, 0.55, 3);
  assert.equal(roomy, 0.55);
  assert.ok(Model.contrastRatio({ r: 0.55, g: 0.55, b: 0.55 }, BLACK) >= 3);

  // A low-contrast theme cannot, so the widget refuses to fade that far.
  const tight = { r: 0.42, g: 0.45, b: 0.45 };
  const bg = { r: 0.3, g: 0.32, b: 0.32 };
  const clamped = Model.dimAlpha(tight, bg, 0.55, 3);
  assert.equal(clamped, 1, "must not dim text the theme cannot afford to dim");
});

// -------------------------------------------------------------------------------------------
// The service transport
// -------------------------------------------------------------------------------------------

test("only ever talks to loopback, and there is no setting that changes that", () => {
  const args = Model.curlArgs("/health", { port: 9999, host: "evil.example" });
  const url = args[args.length - 1];
  assert.equal(url, "http://127.0.0.1:9999/health");
  assert.ok(args.includes("--max-time"), "an unbounded request would hang the whole shell");
  assert.ok(args.includes("--noproxy"), "a proxy env var must not redirect a loopback read");

  // A nonsense port falls back rather than building a nonsense URL.
  assert.match(Model.curlArgs("/health", { port: "; rm -rf /" }).at(-1), /^http:\/\/127\.0\.0\.1:8787\//);
  assert.match(Model.curlArgs("/health", null).at(-1), /^http:\/\/127\.0\.0\.1:8787\//);
});

test("reads the status code alongside the body, because refusals explain themselves", () => {
  const ok = Model.parseResponse('{"data":{"a":1},"meta":{"stale":false,"ageSeconds":3}}\n200');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { a: 1 });
  assert.equal(ok.meta.ageSeconds, 3);

  const unauthorized = Model.parseResponse('{"error":"No OpenSea API key in the keyring."}\n401');
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.error, /API key/);

  // Connection refused: curl writes nothing at all.
  const dead = Model.parseResponse("");
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 0);

  // A truncated or non-JSON body must not throw inside the shell process.
  const torn = Model.parseResponse('{"data":{"a"\n200');
  assert.equal(torn.ok, false);
  assert.equal(torn.data, null);
});

// -------------------------------------------------------------------------------------------
// The degraded-state machine — every one of these is a normal state
// -------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-09-07T12:00:00Z");

function health(overrides = {}) {
  return {
    ok: true,
    wallet: `0x${"a".repeat(40)}`,
    chains: ["ethereum"],
    primaryChain: "ethereum",
    collections: ["cool-cats"],
    tokens: [],
    credentials: { apiKey: true, pat: true },
    ...overrides,
  };
}

function stateWith(overrides = {}) {
  return { ...Model.emptyState(), ...overrides };
}

test("a fresh install is 'setup', not an error", () => {
  const fresh = stateWith({
    health: health({ wallet: "", collections: [], credentials: { apiKey: false, pat: false } }),
  });
  assert.equal(Model.statusOf(fresh, NOW), Model.STATUS.SETUP);

  const steps = Model.setupSteps(fresh);
  assert.deepEqual(
    steps.map((s) => [s.key, s.done]),
    [
      ["service", true],
      ["apiKey", false],
      ["wallet", false],
      ["collections", false],
    ],
  );
  // Three required steps and one optional. There is no wallet-PAT step: nothing this widget reads
  // needs one (service/src/auth.ts), and a step that cannot be justified is the cheapest one to cut.
  const progress = Model.setupProgress(fresh);
  assert.equal(progress.total, 3);
  assert.equal(progress.position, 2);
  assert.equal(progress.optionalRemaining, 1);

  // The collapsed optional line is computed from the steps, not written beside them. The version
  // that was written beside them kept promising "portfolio value, incoming offers" after the steps
  // behind those two were deleted.
  assert.equal(Model.optionalSummary(fresh), "floor prices");
  for (const step of Model.setupSteps(fresh)) {
    if (step.optional) assert.ok(step.benefit, `optional step ${step.key} needs a benefit`);
  }
  // The bar shows the mark and no numbers, rather than a red box or an empty rectangle.
  const label = Model.barLabel(fresh, NOW);
  assert.equal(label.value, "");
  assert.equal(label.status, Model.STATUS.SETUP);
  assert.match(Model.statusSummary(fresh, NOW), /^Anchor —/);
});

test("a satisfied optional step stops being advertised", () => {
  const watching = stateWith({ health: health({ collections: ["doodles"] }) });
  assert.equal(Model.optionalSummary(watching), "");
  assert.equal(Model.setupProgress(watching).optionalRemaining, 0);
});

test("a missing wallet PAT is not a state at all — nothing we read needs one", () => {
  const noPat = stateWith({ health: health({ credentials: { apiKey: true, pat: false } }) });
  // Anchor used to call this "partial" and offer a step to fix it. Re-measured with a key that
  // actually authenticates, every route the service calls needs the API key and nothing else, so
  // this is simply a configured install.
  assert.equal(Model.statusOf(noPat, NOW), Model.STATUS.STARTING);
  assert.equal(
    Model.setupSteps(noPat).find((s) => s.key === "pat"),
    undefined,
  );
  assert.equal(Model.STATUS.PARTIAL, undefined);
});

test("a stored API key the service is rejecting is 'setup', not a configured install", () => {
  // `/health` says the key is present, because the keyring returned a string. The 401 is the only
  // evidence that it does not authenticate — presence and function are different claims.
  const rejected = stateWith({
    health: health({ credentials: { apiKey: true, pat: false } }),
    collections: { data: null, meta: null, receivedAt: 0, error: "unauthorised", status: 401 },
  });
  assert.equal(Model.apiKeyRejected(rejected), true);
  assert.equal(Model.statusOf(rejected, NOW), Model.STATUS.SETUP);

  // The step goes back to being the current one, and says it is being rejected rather than missing.
  const step = Model.setupSteps(rejected).find((s) => s.key === "apiKey");
  assert.equal(step.done, false);
  assert.match(step.label, /replace/i);
  assert.match(step.hint, /--check-credentials/);
  assert.match(Model.statusSummary(rejected, NOW), /rejected/i);

  // A healthy read is not mistaken for a rejection.
  const fine = stateWith({
    health: health({ credentials: { apiKey: true, pat: false } }),
    collections: { data: [], meta: null, receivedAt: NOW, error: null, status: 200 },
  });
  assert.equal(Model.apiKeyRejected(fine), false);
});

test("zero configured wallets is a normal state and never blocks the widget", () => {
  const noWallet = stateWith({ health: health({ wallet: null }) });
  assert.equal(Model.statusOf(noWallet, NOW), Model.STATUS.SETUP);
  assert.doesNotThrow(() => Model.barLabel(noWallet, NOW));
  assert.deepEqual(Model.deadlines(noWallet, NOW), []);
  assert.equal(Model.offerCount(noWallet), 0);
});

test("a service that never answered shows the mark; one that answered before shows the old number", () => {
  const cold = Model.emptyState();
  assert.equal(Model.statusOf(cold, NOW), Model.STATUS.STARTING);
  assert.match(Model.statusSummary(cold, NOW), /reading/i);

  const wasUp = stateWith({
    updatedAt: NOW - 600000,
    portfolio: { data: { totalValueUsd: "1000" }, meta: null, receivedAt: NOW - 600000 },
  });
  assert.equal(Model.statusOf(wasUp, NOW), Model.STATUS.OFFLINE);
  const label = Model.barLabel(wasUp, NOW);
  assert.equal(label.value, "$1K", "the last known value stays on screen");
  assert.equal(label.dim, true, "and is visibly faded rather than presented as live");
});

test("a failed read keeps the previous reading instead of blanking it", () => {
  let state = Model.applyRead(
    Model.emptyState(),
    "portfolio",
    {
      ok: true,
      status: 200,
      data: { totalValueUsd: "2500" },
      meta: { stale: false, ageSeconds: 0 },
    },
    NOW,
  );
  assert.equal(Model.readPortfolio(state.portfolio).total, "2500");

  state = Model.applyRead(state, "portfolio", { ok: false, status: 0, error: "offline" }, NOW + 1000);
  assert.equal(Model.readPortfolio(state.portfolio).total, "2500", "the number survives the failure");
  assert.equal(state.portfolio.error, "offline");
  assert.equal(state.updatedAt, NOW, "but the success clock does not move");
});

test("a 401 still counts as the service answering, so it reads as setup and not as offline", () => {
  const state = Model.applyRead(
    stateWith({ health: health() }),
    "health",
    { ok: false, status: 401, error: "No OpenSea API key in the keyring." },
    NOW,
  );
  assert.equal(state.reachedAt, NOW);
  assert.notEqual(state.health, null);
});

test("staleness is surfaced rather than hidden", () => {
  const base = { data: { totalValueUsd: "10" }, receivedAt: NOW };
  const fresh = stateWith({
    health: health(),
    portfolio: { ...base, meta: { stale: false, ageSeconds: 5 } },
  });
  assert.equal(Model.statusOf(fresh, NOW), Model.STATUS.READY);

  const flagged = stateWith({
    health: health(),
    portfolio: { ...base, meta: { stale: true, ageSeconds: 5 } },
  });
  assert.equal(Model.statusOf(flagged, NOW), Model.STATUS.STALE, "the service's own stale flag is honoured");

  // Ages keep counting while the widget's copy sits on disk, so a restored snapshot is honest.
  const restored = stateWith({
    health: health(),
    portfolio: { ...base, receivedAt: NOW - 3600000, meta: { stale: false, ageSeconds: 30 } },
  });
  assert.equal(Model.ageSeconds(restored.portfolio, NOW), 3630);
  assert.equal(Model.statusOf(restored, NOW), Model.STATUS.STALE);
});

// -------------------------------------------------------------------------------------------
// Readings from real response shapes
// -------------------------------------------------------------------------------------------

test("reads the portfolio endpoint's actual field names", () => {
  const read = Model.readPortfolio({
    data: {
      totalValueUsd: "125430.5",
      nftValueUsd: "100000",
      tokenValueUsd: "25430.5",
      pnlPercentage: "+1.01",
      timeframe: "DAY",
    },
  });
  assert.equal(read.total, "125430.5");
  assert.equal(read.symbol, "USD");
  assert.equal(read.timeframe, "DAY");
  assert.equal(read.change.direction, "up");
  assert.equal(Model.formatMoney(read.total, { symbol: read.symbol }), "$125K");
});

test("an empty or reshaped portfolio response renders as no value, not as a broken widget", () => {
  assert.equal(Model.readPortfolio(null).total, null);
  assert.equal(Model.readPortfolio({ data: {} }).total, null);
  assert.equal(Model.readPortfolio({ data: { somethingElse: 1 } }).change, null);
});

function offerEvent(overrides = {}) {
  return {
    eventType: "order",
    orderType: "item_offer",
    maker: `0x${"b".repeat(40)}`,
    eventTimestamp: Math.floor((NOW - 60000) / 1000),
    expirationDate: Math.floor((NOW + 3600000) / 1000),
    asset: { collection: "cool-cats", identifier: "42", name: "Cool Cat #42" },
    payment: { quantity: "1500000000000000000", decimals: 18, symbol: "WETH" },
    ...overrides,
  };
}

test("counts incoming offers and ignores the user's own", () => {
  const wallet = `0x${"a".repeat(40)}`;
  const state = stateWith({
    health: health({ wallet }),
    activity: {
      data: {
        assetEvents: [
          offerEvent(),
          offerEvent({ orderType: "collection_offer", asset: undefined }),
          offerEvent({ maker: wallet.toUpperCase() }), // the user's own bid, cased differently
          { eventType: "sale", eventTimestamp: Math.floor((NOW - 1000) / 1000) },
          { eventType: "order", orderType: "listing" },
        ],
      },
      meta: { stale: false, ageSeconds: 1 },
      receivedAt: NOW,
    },
  });

  assert.equal(Model.offerCount(state), 2);
  // Activity is every timestamped event in the window, the user's own bid included — it answers
  // "has anything happened", which is a different question from "does anything want a decision".
  // The listing event carries no timestamp, so it cannot be placed in the window and is not counted.
  assert.equal(Model.activityCount(state, NOW), 4);
});

test("deadlines are sorted, windowed, and never claim a decision that has passed", () => {
  const state = stateWith({
    health: health(),
    activity: {
      data: {
        assetEvents: [
          offerEvent({ expirationDate: Math.floor((NOW + 7200000) / 1000) }),
          offerEvent({ expirationDate: Math.floor((NOW + 600000) / 1000) }),
          offerEvent({ expirationDate: Math.floor((NOW - 600000) / 1000) }), // already gone
          offerEvent({ expirationDate: Math.floor((NOW + 40 * 86400000) / 1000) }), // far future
          offerEvent({ expirationDate: undefined }), // no clock on it at all
        ],
      },
      receivedAt: NOW,
    },
  });

  const due = Model.deadlines(state, NOW);
  assert.equal(due.length, 2);
  assert.equal(due[0].label, "10m");
  assert.equal(due[1].label, "2h");
  assert.equal(due[0].amount, "1.5 WETH");
  assert.equal(due[0].url, "https://opensea.io/collection/cool-cats");
  // Every offer is still counted, including the one with no expiry.
  assert.equal(Model.offerCount(state), 5);
});

test("a collection offer with no asset still renders", () => {
  const state = stateWith({
    health: health(),
    activity: {
      data: {
        assetEvents: [offerEvent({ asset: undefined, criteria: { collection: { slug: "cool-cats" } } })],
      },
      receivedAt: NOW,
    },
  });
  const [first] = Model.deadlines(state, NOW);
  assert.equal(first.name, "Collection offer");
  assert.equal(first.collection, "cool-cats");
});

test("collection rows keep a slug the service could not fetch, and say why", () => {
  const state = stateWith({
    collections: {
      data: [
        {
          slug: "cool-cats",
          data: { total: { floorPrice: 1.42, floorPriceSymbol: "ETH" } },
          meta: { stale: false },
        },
        { slug: "gone", error: "OpenSea API 404 Not Found" },
      ],
      receivedAt: NOW,
    },
  });

  const rows = Model.collectionRows(state);
  assert.equal(rows[0].floor, "1.42 ETH");
  assert.equal(rows[0].url, "https://opensea.io/collection/cool-cats");
  assert.equal(rows[1].floor, null);
  assert.match(rows[1].error, /404/);
  assert.equal(rows.length, 2, "a row that failed must not silently vanish");
});

test("a hostile collection name survives into the row as inert text", () => {
  const nasty = `<img src=x onerror=alert(1)>‮${"A".repeat(400)}`;
  const state = stateWith({
    activity: {
      data: {
        assetEvents: [offerEvent({ asset: { collection: "cool-cats", identifier: "1", name: nasty } })],
      },
      receivedAt: NOW,
    },
    health: health(),
  });
  const [first] = Model.deadlines(state, NOW);
  assert.ok(Array.from(first.name).length <= 28);
  assert.ok(!first.name.includes("‮"));
});

// -------------------------------------------------------------------------------------------
// Snapshot persistence — the bar must paint before any network call
// -------------------------------------------------------------------------------------------

test("a snapshot round-trips, and a corrupt one degrades to an empty state", () => {
  const state = Model.applyRead(
    Model.emptyState(),
    "portfolio",
    {
      ok: true,
      status: 200,
      data: { totalValueUsd: "77" },
      meta: { stale: false, ageSeconds: 4 },
    },
    NOW,
  );

  const restored = Model.parseSnapshot(Model.serializeSnapshot(state));
  assert.equal(Model.readPortfolio(restored.portfolio).total, "77");
  assert.equal(restored.portfolio.receivedAt, NOW);

  for (const bad of ["", "{", "null", '{"version":99}', JSON.stringify({ version: 1, portfolio: 5 })]) {
    assert.doesNotThrow(() => Model.parseSnapshot(bad));
  }
  assert.equal(Model.parseSnapshot("{").portfolio, null);
});

test("a snapshot never restores which credentials exist", () => {
  // Whether a key is in the keyring is a question about now. Answering it from disk would show a
  // configured widget to someone who has since removed the key.
  const state = stateWith({ health: health() });
  const restored = Model.parseSnapshot(Model.serializeSnapshot(state));
  assert.equal(restored.health, null);
  assert.equal(Model.statusOf(restored, NOW), Model.STATUS.STARTING);
});

// -------------------------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------------------------

test("the manifest's advertised defaults are the ones the model actually applies", () => {
  // The shell stores `barWidget.defaults` as registry metadata and never merges it into `settings`
  // — `Model.mergeSettings` is what applies defaults. That makes the manifest block documentation,
  // and documentation that disagrees with the code is the bug this test exists to prevent.
  const manifest = require("../manifest.json");
  assert.deepEqual(manifest.barWidget.defaults, Model.DEFAULT_SETTINGS);

  // Every advertised setting is also one the model will accept, and vice versa.
  const advertised = manifest.barWidget.schema.map((field) => field.key).sort();
  assert.deepEqual(advertised, Object.keys(Model.DEFAULT_SETTINGS).sort());
});

test("settings come from a hand-edited file, so every field is validated", () => {
  const merged = Model.mergeSettings({
    port: "8080",
    timeframe: "YEAR",
    showValue: "yes",
    maxNameLength: -5,
    unknownKey: "ignored",
  });
  assert.equal(merged.port, 8080, "a numeric string is accepted");
  assert.equal(merged.timeframe, "DAY", "an unsupported timeframe falls back rather than 400ing");
  assert.equal(merged.showValue, true, "a non-boolean does not flip a boolean");
  assert.equal(merged.maxNameLength, 28);
  assert.equal(merged.unknownKey, undefined);

  assert.deepEqual(Model.mergeSettings(null), Model.DEFAULT_SETTINGS);
  assert.deepEqual(Model.mergeSettings({}), Model.DEFAULT_SETTINGS);
});

test("showValue false hides the number without changing the status", () => {
  const state = stateWith({
    health: health(),
    portfolio: { data: { totalValueUsd: "1000" }, meta: { stale: false, ageSeconds: 1 }, receivedAt: NOW },
  });
  assert.equal(Model.barLabel(state, NOW, { showValue: true }).value, "$1K");
  const hidden = Model.barLabel(state, NOW, { showValue: false });
  assert.equal(hidden.value, "");
  assert.equal(hidden.status, Model.STATUS.READY);
});

// -------------------------------------------------------------------------------------------
// Actions the panel can take
//
// A bar widget that spawns processes is the part of this change worth testing hardest. The
// property being asserted is not "the right command runs" but "nothing else can": the panel hands
// over an identifier, and everything that becomes an argv is a literal in one closed table.
// -------------------------------------------------------------------------------------------

test("every action is a fixed argv, and an unknown id runs nothing", () => {
  const env = { home: "/home/someone" };

  assert.deepEqual(Model.actionArgv(Model.ACTION.START_SERVICE, env), [
    "systemctl",
    "--user",
    "start",
    "anchor-service.service",
  ]);
  assert.deepEqual(Model.actionArgv(Model.ACTION.ENABLE_SERVICE, env), [
    "systemctl",
    "--user",
    "enable",
    "--now",
    "anchor-service.service",
  ]);
  assert.deepEqual(Model.actionArgv(Model.ACTION.SET_API_KEY, env), [
    "omarchy-launch-terminal",
    "anchor-service",
    "--set-api-key",
  ]);
  assert.deepEqual(Model.actionArgv(Model.ACTION.EDIT_CONFIG, env), [
    "omarchy-launch-editor",
    "/home/someone/.config/anchor/config.json",
  ]);

  // The failure mode this exists to prevent: an id that came from anywhere but the table.
  for (const bogus of ["", "rm", "start-service ; rm -rf /", "startService", null, undefined, 0, {}, []]) {
    assert.equal(Model.actionArgv(bogus, env), null, `${String(bogus)} must not resolve to a command`);
  }
});

test("the one non-literal argument, the config path, is validated rather than trusted", () => {
  assert.equal(
    Model.configFilePath({ configHome: "/home/someone/.config" }),
    "/home/someone/.config/anchor/config.json",
    "XDG_CONFIG_HOME wins over HOME",
  );
  assert.equal(Model.configFilePath({ home: "/home/someone" }), "/home/someone/.config/anchor/config.json");

  assert.equal(Model.configFilePath({}), null, "no environment at all yields no command");
  assert.equal(Model.configFilePath({ configHome: "relative/path" }), null, "must be absolute");
  assert.equal(Model.configFilePath({ configHome: "/home/../etc" }), null, "no traversal segment");
  assert.equal(Model.configFilePath({ configHome: "/home/a\nb" }), null, "no control characters");

  // And a rejected path must take the whole action with it, not fall back to a default.
  assert.equal(Model.actionArgv(Model.ACTION.EDIT_CONFIG, {}), null);
});

test("`systemctl show` is read for both facts: a unit can load and still fail", () => {
  const loaded = Model.parseUnitState("LoadState=loaded\nActiveState=active\n");
  assert.deepEqual(loaded, { loaded: true, active: "active", failed: false });

  const broken = Model.parseUnitState("LoadState=loaded\nActiveState=failed\n");
  assert.equal(broken.loaded, true, "the unit file is there");
  assert.equal(broken.failed, true, "and starting it did not work — the step has to say so");

  const absent = Model.parseUnitState("LoadState=not-found\nActiveState=inactive\n");
  assert.deepEqual(absent, { loaded: false, active: "inactive", failed: false });

  // A `systemctl` that is missing, killed, or writes nothing must read as "no unit", never as one.
  for (const nothing of ["", "\n", null, undefined, "Description=whatever"]) {
    assert.equal(Model.parseUnitState(nothing).loaded, false);
  }
});

test("the first setup step offers a button only when the unit is actually installed", () => {
  const noUnit = Model.setupSteps(stateWith({ health: null }))[0];
  assert.equal(noUnit.action, null, "no unit, no button — a button that cannot work is worse than none");
  assert.match(noUnit.hint, /node service/, "and the command stays available as the fallback");

  const withUnit = Model.setupSteps(
    stateWith({ health: null, unit: { loaded: true, active: "inactive", failed: false } }),
  );
  assert.equal(withUnit[0].action.id, Model.ACTION.START_SERVICE);
  assert.equal(withUnit[0].secondary.id, Model.ACTION.ENABLE_SERVICE, "and one to survive a reboot");
  assert.match(withUnit[0].hint, /systemctl --user start/, "the raw command becomes the footnote");

  const failed = Model.setupSteps(
    stateWith({ health: null, unit: { loaded: true, active: "failed", failed: true } }),
  );
  assert.match(failed[0].detail, /failed to start/, "a start that did not work is not reported as success");
});

test("the credential step opens a prompt and never carries the secret", () => {
  const fresh = stateWith({ health: health({ credentials: { apiKey: false, pat: false } }) });
  const apiKey = Model.setupSteps(fresh)[1];

  assert.equal(apiKey.action.id, Model.ACTION.SET_API_KEY);
  const argv = Model.actionArgv(apiKey.action.id, { home: "/home/someone" });
  // The point of the assertion: the argv is a *prompt*, with no slot a value could be put into.
  assert.equal(argv.length, 3);
  assert.deepEqual(argv, ["omarchy-launch-terminal", "anchor-service", "--set-api-key"]);
});

test("a 401 on any data read demotes the API-key step, including the newest one", () => {
  const rejected = (key) =>
    stateWith({
      health: health(),
      [key]: { data: null, meta: null, receivedAt: 0, error: "unauthorized", status: 401 },
    });

  // `balances` is the read added for the breakdown. A route left out of this list is one whose 401
  // the panel absorbs silently while still saying the key is fine — which is the exact failure the
  // "presence is not function" rule exists for.
  for (const key of ["portfolio", "activity", "collections", "balances"]) {
    assert.equal(Model.apiKeyRejected(rejected(key)), true, `${key} 401 must be noticed`);
    const step = Model.setupProgress(rejected(key)).required[1];
    assert.equal(step.state, "current");
    assert.match(step.label, /Replace/);
  }
});

test("applyUnitState folds a probe in without disturbing a reading", () => {
  const before = stateWith({ portfolio: { data: { totalValueUsd: "5" }, meta: null, receivedAt: NOW } });
  const after = Model.applyUnitState(before, "LoadState=loaded\nActiveState=active\n");
  assert.equal(after.unit.loaded, true);
  assert.deepEqual(after.portfolio, before.portfolio, "a fact about this machine is not a reading");
});

// -------------------------------------------------------------------------------------------
// Depth, taken from the live Omarchy theme
//
// `scripts/check-contrast.ts` gates theme/tokens.css and cannot reach these colours: they belong
// to whichever Omarchy theme is applied at runtime. So the gate for them is here, against the
// palettes of the stock themes — including the two that break every rule of thumb: `white`
// (a #ffffff ground with no headroom above it) and `vantablack` (#000000, with none below).
// -------------------------------------------------------------------------------------------

/** The keys `panelSurfaces` reads, in the exact `colors.toml` spelling. */
function themeToml(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
}

const STOCK_THEMES = {
  "tokyo-night": {
    mode: "dark",
    background: "#1a1b26",
    lighter_background: "#24283b",
    dark_background: "#13141c",
    selection: "#292e42",
    foreground: "#a9b1d6",
  },
  "catppuccin-latte": {
    mode: "light",
    background: "#eff1f5",
    lighter_background: "#dce0e8",
    dark_background: "#e3e4e8",
    selection: "#ccd0da",
    foreground: "#4c4f69",
  },
  white: {
    mode: "light",
    background: "#ffffff",
    lighter_background: "#c0c0c0",
    dark_background: "#f5f5f5",
    selection: "#c0c0c0",
    foreground: "#000000",
  },
  vantablack: {
    mode: "dark",
    background: "#000000",
    lighter_background: "#1a1a1a",
    dark_background: "#090909",
    selection: "#1a1a1a",
    foreground: "#ffffff",
  },
};

test("colors.toml is parsed for the layers Color.qml drops on the floor", () => {
  const theme = Model.parseThemeColors(
    [
      "# a comment",
      'mode = "dark"',
      'accent = "#7aa2f7"',
      'background = "#1a1b26"   # with a trailing comment',
      'lighter_background = "#24283b"',
      'dark_background = "#13141c"',
      'selection = "#292e42"',
      'foreground = "#a9b1d6"',
    ].join("\n"),
  );
  assert.equal(theme.mode, "dark");
  assert.deepEqual(theme.background, Model.hexToRgb("#1a1b26"));
  assert.deepEqual(theme.raised, Model.hexToRgb("#24283b"));
  assert.deepEqual(theme.sunken, Model.hexToRgb("#13141c"));
  assert.deepEqual(theme.line, Model.hexToRgb("#292e42"));

  // A machine with no theme applied is the empty case, not an error case.
  const none = Model.parseThemeColors("");
  assert.equal(none.background, null);
  assert.equal(none.raised, null);
});

test("every stock theme yields three surfaces that are distinct and still carry text", () => {
  for (const [name, values] of Object.entries(STOCK_THEMES)) {
    const theme = Model.parseThemeColors(themeToml(values));
    const ground = theme.background;
    const s = Model.panelSurfaces(ground, theme);
    const text = theme.foreground;

    for (const layer of ["raised", "sunken", "line"]) {
      const step = Model.contrastRatio(s[layer], ground);
      assert.ok(step >= 1.03, `${name}: ${layer} is invisible against the ground (${step.toFixed(3)}:1)`);
      assert.ok(step <= 4, `${name}: ${layer} reads as a border, not a surface (${step.toFixed(3)}:1)`);
    }

    // The reason depth is worth having at all: text has to stay readable on every layer it lands
    // on. AA body text is 4.5:1, and full-strength foreground must clear it on all three.
    for (const layer of ["ground", "raised", "sunken"]) {
      const r = Model.contrastRatio(text, s[layer]);
      assert.ok(r >= 4.5, `${name}: foreground on ${layer} is ${r.toFixed(2)}:1, below AA`);
    }

    // A divider that equals the surface beside it is not a divider. `vantablack` ships exactly
    // that — `selection` and `lighter_background` are both #1a1a1a — so one has to be derived.
    const lineVsRaised = Model.contrastRatio(s.line, s.raised);
    assert.ok(lineVsRaised >= 1.02, `${name}: the hairline vanishes into the raised surface`);
  }
});

test("with no theme file at all, the layers are derived from the ground rather than guessed", () => {
  for (const ground of [Model.hexToRgb("#000000"), Model.hexToRgb("#ffffff"), Model.hexToRgb("#101315")]) {
    const s = Model.panelSurfaces(ground, {});
    for (const layer of ["raised", "sunken", "line"]) {
      assert.ok(
        Model.contrastRatio(s[layer], ground) >= 1.03,
        `a derived ${layer} still has to be a visible step`,
      );
    }
  }
});

// -------------------------------------------------------------------------------------------
// Names, not slugs
// -------------------------------------------------------------------------------------------

test("a collection is called by its name, and the slug is the fallback rather than the label", () => {
  const state = stateWith({
    health: health(),
    collections: {
      data: [
        { slug: "boredapeyachtclub", name: "Bored Ape Yacht Club", data: { floorPrice: "28.9" } },
        { slug: "cool-cats", data: { floorPrice: "1.42" } },
      ],
      meta: null,
      receivedAt: NOW,
    },
  });

  const rows = Model.collectionRows(state, {});
  assert.equal(rows[0].name, "Bored Ape Yacht Club");
  assert.equal(rows[1].name, "cool-cats", "no name from the service means the slug, not a blank");
  // The link is still built from the slug: that is the identifier, and it is what is validated.
  assert.equal(rows[0].url, "https://opensea.io/collection/boredapeyachtclub");
  assert.equal(rows[0].slug, "boredapeyachtclub");
});

test("a collection name is marketplace content, so it is sanitised and truncated like one", () => {
  const state = stateWith({
    collections: {
      data: [{ slug: "cool-cats", name: `Cool‮Cats${"​".repeat(200)} of the very longest kind` }],
      meta: null,
      receivedAt: NOW,
    },
  });
  const name = Model.collectionRows(state, { maxNameLength: 20 })[0].name;
  assert.ok(!name.includes("‮"), "a bidi override in a name would reorder the row around it");
  assert.ok(!name.includes("​"));
  assert.ok(Array.from(name).length <= 20);
});

test("the deadline rows and the floor rows agree on what a collection is called", () => {
  const state = stateWith({
    health: health(),
    collections: {
      data: [{ slug: "cool-cats", name: "Cool Cats", data: { floorPrice: "1.42" } }],
      meta: null,
      receivedAt: NOW,
    },
    activity: {
      data: {
        assetEvents: [
          {
            eventType: "order",
            orderType: "item_offer",
            maker: "0xbidder",
            asset: { collection: "cool-cats", identifier: "7", name: "Cool Cat #7" },
            expirationDate: Math.floor((NOW + 3600_000) / 1000),
            payment: { quantity: "1000000000000000000", decimals: 18, symbol: "WETH" },
          },
        ],
      },
      meta: null,
      receivedAt: NOW,
    },
  });

  const [row] = Model.deadlines(state, NOW, {});
  assert.ok(row, "the fixture has to produce a deadline or this asserts nothing");
  assert.equal(row.collection, "Cool Cats", "the same name the Floors list uses");
  // One mapping, built in one place: that is the property, not the string.
  assert.deepEqual(Model.collectionNames(state, {}), { "cool-cats": "Cool Cats" });
});

// -------------------------------------------------------------------------------------------
// Wallets, plural
// -------------------------------------------------------------------------------------------

test("every configured wallet is watched, and the old singular field still works", () => {
  assert.deepEqual(Model.walletList({ wallets: ["0xa", "0xb"] }), ["0xa", "0xb"]);
  assert.deepEqual(Model.walletList({ wallet: "0xa" }), ["0xa"], "a service that only reports the singular");
  assert.deepEqual(
    Model.walletList({ wallets: [], wallet: "0xa" }),
    ["0xa"],
    "an empty list is not an answer",
  );
  assert.deepEqual(Model.walletList({ wallets: ["0xa", 7, ""] }), ["0xa"], "hand-edited config is untrusted");

  // The state this now has to keep working, because it is the only way to reach it.
  assert.deepEqual(Model.walletList({}), []);
  assert.deepEqual(Model.walletList(null), []);
});

test("no wallets is still a designed state, not an error", () => {
  const none = stateWith({ health: health({ wallet: null, wallets: [] }) });
  assert.equal(Model.statusOf(none, NOW), Model.STATUS.SETUP);
  assert.equal(Model.statusDetail(none, NOW, {}), "no wallet configured");

  const step = Model.setupSteps(none).find((s) => s.key === "wallet");
  assert.equal(step.done, false);
  assert.equal(step.action.id, Model.ACTION.EDIT_CONFIG);
});

test("an offer to any watched wallet counts, not just the first", () => {
  const event = (recipient) => ({
    eventType: "order",
    orderType: "item_offer",
    maker: "0xbidder",
    taker: recipient,
    expirationDate: Math.floor((NOW + 3600_000) / 1000),
    payment: { quantity: "1000000000000000000", decimals: 18, symbol: "WETH" },
    asset: { collection: "cool-cats", identifier: "7" },
  });

  const state = stateWith({
    health: health({ wallet: "0xaaa", wallets: ["0xaaa", "0xbbb"] }),
    activity: { data: { assetEvents: [event("0xbbb")] }, meta: null, receivedAt: NOW },
  });
  assert.equal(Model.offerCount(state), 1, "the second wallet is watched too, or the plural means nothing");
  assert.equal(Model.deadlines(state, NOW, {}).length, 1);

  // The regression the plural introduced and this caught: testing each wallet and OR-ing the
  // results counts your own bid as incoming, because an offer made by wallet A is indeed "not made
  // by wallet B". The whole list has to be one test.
  const ownBid = stateWith({
    health: health({ wallet: "0xaaa", wallets: ["0xaaa", "0xbbb"] }),
    activity: {
      data: { assetEvents: [Object.assign(event("0xaaa"), { maker: "0xbbb" })] },
      meta: null,
      receivedAt: NOW,
    },
  });
  assert.equal(Model.offerCount(ownBid), 0, "an offer made by one of my own wallets is not incoming");
  assert.equal(Model.deadlines(ownBid, NOW, {}).length, 0);
});

// -------------------------------------------------------------------------------------------
// What the bar shows
// -------------------------------------------------------------------------------------------

test("the bar starts sparse: the value and the countdown, nothing else", () => {
  const settings = Model.mergeSettings({});
  assert.equal(settings.showValue, true);
  assert.equal(settings.showDeadline, true, "the only item with a clock running out");
  assert.equal(settings.showChange, false);
  assert.equal(settings.showOffers, false);
  assert.equal(settings.showActivity, false);

  // The toggles the panel offers and the items the bar draws come from one list, so they cannot
  // drift apart — the same argument as `optionalSummary` being derived from the steps.
  assert.deepEqual(
    Model.BAR_ITEMS.map((item) => item.key),
    ["showValue", "showChange", "showOffers", "showDeadline", "showActivity"],
  );
  for (const item of Model.BAR_ITEMS) {
    assert.equal(typeof settings[item.key], "boolean", `${item.key} has to be a real setting`);
    assert.ok(item.label !== "", "and something to call it in the panel");
  }
});

// -------------------------------------------------------------------------------------------
// The portfolio, broken down
// -------------------------------------------------------------------------------------------

test("decimal strings are summed digit by digit, never through a float", () => {
  assert.equal(Model.addDecimals("0.1", "0.2"), "0.3", "the classic float failure");
  assert.equal(Model.addDecimals("1.005", "2.995"), "4");
  assert.equal(Model.addDecimals("999", "1"), "1000");
  assert.equal(Model.addDecimals("9.99", "0.01"), "10");
  assert.equal(Model.sumDecimals(["1.1", "2.2", "3.3"]), "6.6");

  // Well past what a double can hold exactly, which is the whole reason for the string arithmetic.
  const huge = "123456789012345678901.55";
  assert.equal(Model.addDecimals(huge, "0.45"), "123456789012345678902");
  assert.notEqual(String(Number(huge) + 0.45), "123456789012345678902");
});

function portfolioState(extra = {}) {
  return stateWith(
    Object.assign(
      {
        health: health(),
        portfolio: {
          data: {
            totalValueUsd: "1000",
            nftValueUsd: "700",
            tokenValueUsd: "300",
          },
          meta: { stale: false, ageSeconds: 12 },
          receivedAt: NOW,
        },
      },
      extra,
    ),
  );
}

test("the type breakdown covers the whole portfolio and says so", () => {
  const split = Model.portfolioBreakdown(portfolioState(), {}, "type");
  assert.deepEqual(
    split.rows.map((r) => [r.label, r.text, Math.round(r.share * 100)]),
    [
      ["NFTs", "$700.00", 70],
      ["Tokens", "$300.00", 30],
    ],
  );
  assert.equal(split.totalText, "$1,000.00");
  assert.match(split.scope, /everything/);
});

test("the asset and chain breakdowns say they are the token half, because they are", () => {
  const state = portfolioState({
    balances: {
      data: [
        { symbol: "AAA", name: "Alpha", chain: "ethereum", usd_value: "200" },
        { symbol: "BBB", name: "Beta", chain: "base", usd_value: "100" },
      ],
      meta: null,
      receivedAt: NOW,
    },
  });

  const assets = Model.portfolioBreakdown(state, {}, "asset");
  assert.deepEqual(
    assets.rows.map((r) => [r.label, r.text]),
    [
      ["AAA", "$200.00"],
      ["BBB", "$100.00"],
    ],
  );
  // Its own total, not the headline's: 300, not 1000. A share of an unstated whole is the shape of
  // a number that cannot be checked — and presenting token rows as shares of the portfolio would
  // silently claim that NFT value had been distributed among them.
  assert.equal(assets.totalText, "$300.00");
  assert.match(assets.scope, /tokens only/);
  assert.match(assets.scope, /asset/);

  const chains = Model.portfolioBreakdown(state, {}, "chain");
  assert.deepEqual(
    chains.rows.map((r) => [r.label, r.text, Math.round(r.share * 100)]),
    [
      ["ethereum", "$200.00", 67],
      ["base", "$100.00", 33],
    ],
  );
  assert.match(chains.scope, /tokens only/);
  assert.match(chains.scope, /chain/);
});

test("a long tail folds into one row rather than being dropped", () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push({ symbol: `T${i}`, chain: "ethereum", usd_value: "10" });
  const split = Model.portfolioBreakdown(
    portfolioState({ balances: { data: many, meta: null, receivedAt: NOW } }),
    {},
    "asset",
  );

  assert.equal(split.rows.length, 6, "five parts and a fold");
  assert.equal(split.rows[5].label, "4 more");
  assert.equal(split.rows[5].text, "$40.00");
  // The property that matters: the parts still add up to the stated total.
  const shares = split.rows.reduce((sum, row) => sum + row.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9, `shares sum to ${shares}, not 1`);
  assert.equal(Model.sumDecimals(split.rows.map((r) => r.value)), "90");
});

test("balance rows are marketplace content and are sanitised like any other", () => {
  const state = portfolioState({
    balances: {
      data: [
        { symbol: "<script>", name: "Cool‮Token", chain: "eth\nereum", usd_value: "5" },
        { symbol: "OK", usd_value: "1" },
        { symbol: "NOVALUE" },
      ],
      meta: null,
      receivedAt: NOW,
    },
  });
  const rows = Model.balanceRows(state, {});
  assert.equal(rows.length, 2, "a row with no USD value is not a row");
  assert.equal(rows[0].label, "CoolToken", "a rejected ticker falls back to the sanitised name");
  assert.equal(rows[0].chain, "eth ereum");
  assert.ok(!rows[0].label.includes("‮"));
});

test("with nothing to break down there is nothing to draw", () => {
  const blank = stateWith({ health: health() });
  for (const mode of ["type", "asset", "chain"]) {
    const split = Model.portfolioBreakdown(blank, {}, mode);
    assert.deepEqual(split.rows, [], `${mode} must not invent a slice`);
  }
  assert.deepEqual(Model.portfolioBreakdown(blank, {}, "nonsense").rows, []);
});

// -------------------------------------------------------------------------------------------
// Provenance
// -------------------------------------------------------------------------------------------

test("the panel says which wallets a total is for, and how old it is", () => {
  // The line that would have made a fabricated total obvious: it names the addresses behind the
  // number. Two of them nobody configured is visible; a plausible dollar figure alone is not.
  const one = portfolioState({ health: health({ wallet: `0x${"a".repeat(40)}` }) });
  assert.equal(Model.provenance(one, NOW, {}), "0xaaaa…aaaa  ·  as of now");

  const two = portfolioState({ health: health({ wallets: ["0xaa", "0xbb"] }) });
  assert.match(Model.provenance(two, NOW, {}), /^2 wallets/);

  // Older readings keep saying so rather than quietly presenting as current.
  const old = portfolioState({
    health: health({ wallets: ["0xaa"] }),
    portfolio: { data: { totalValueUsd: "1" }, meta: null, receivedAt: NOW - 3_600_000 },
  });
  assert.match(Model.provenance(old, NOW, {}), /as of 1h/);

  // And with nothing to say it says nothing, rather than a line of empty separators.
  assert.equal(Model.provenance(stateWith({}), NOW, {}), "");
});
