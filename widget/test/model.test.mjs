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
  assert.equal(Model.formatMoney("-200", { symbol: "USD" }), "-$200");
  // No symbol means no currency is claimed, rather than a default one being assumed.
  assert.equal(Model.formatMoney("1.5", {}), "1.5");
  assert.equal(Model.formatMoney("1.5", { symbol: "🤑" }), "1.5");
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
