/**
 * Every state the panel can be in, as fixture readings.
 *
 * The panel has more states than anything else Anchor draws, and until this file existed none of
 * them could be looked at without arranging for the condition on a live machine — which is why the
 * error and warning states had never been reviewed by anyone. `widget/gallery/Gallery.qml` mounts
 * `PanelContent` against each of these and photographs it.
 *
 * **The data is unmistakably fake, deliberately.** Addresses are `0x0000…0001`, collections are
 * `SAMPLE …`, and every figure is repeated digits. A fixture once bound to the real service port
 * and put a plausible total on the real bar; the rule that came out of that day is that fixture
 * data has to be the tell when the plumbing is not. Repeated digits keep the *width* realistic,
 * which is what a layout review needs, while being impossible to mistake for a portfolio.
 *
 * Shapes match what the service actually returns — see `widget/test/model.test.mjs`, which builds
 * the same envelopes to test the model.
 */

const NOW = Date.parse("2026-09-08T17:00:00Z");

const ADDRESS = `0x${"0".repeat(39)}1`;
const ADDRESS_2 = `0x${"0".repeat(39)}2`;
const OTHER = `0x${"0".repeat(39)}9`;

function health(overrides) {
  return Object.assign(
    {
      ok: true,
      wallet: ADDRESS,
      chains: ["ethereum"],
      primaryChain: "ethereum",
      collections: ["sample-cats"],
      tokens: [],
      credentials: { apiKey: true, pat: true },
      unit: { loaded: true, active: "active", failed: false },
    },
    overrides || {},
  );
}

/** A reading envelope, as `applyRead` builds one. */
function envelope(data, overrides) {
  return Object.assign(
    { data: data, meta: {}, receivedAt: NOW - 30000, error: null, status: 200 },
    overrides || {},
  );
}

function portfolio(overrides) {
  return envelope({
    stats: Object.assign(
      {
        totalValueUsd: "11111.11",
        nftValueUsd: "4444.44",
        tokenValueUsd: "6666.67",
        changePercent: "1.11",
        timeframe: "24h",
      },
      overrides || {},
    ),
  });
}

function offer(overrides) {
  return Object.assign(
    {
      eventType: "order",
      orderType: "item_offer",
      maker: OTHER,
      eventTimestamp: Math.floor((NOW - 60000) / 1000),
      expirationDate: Math.floor((NOW + 6 * 3600000) / 1000),
      asset: { collection: "sample-cats", identifier: "1111", name: "SAMPLE Cat #1111" },
      payment: { quantity: "1110000000000000000", decimals: 18, symbol: "WETH" },
    },
    overrides || {},
  );
}

function activity(events) {
  return envelope({ assetEvents: events });
}

function collections(rows) {
  return envelope(rows);
}

const SAMPLE_COLLECTIONS = [
  {
    slug: "sample-cats",
    data: { total: { floorPrice: 1.11, floorPriceSymbol: "ETH" } },
    meta: { stale: false },
  },
  {
    slug: "sample-apes",
    data: { total: { floorPrice: 22.22, floorPriceSymbol: "ETH" } },
    meta: { stale: false },
  },
];

function base(overrides) {
  return Object.assign(
    {
      health: null,
      healthError: null,
      reachedAt: 0,
      portfolio: null,
      activity: null,
      collections: null,
      balances: null,
      updatedAt: 0,
      unit: { loaded: true, active: "active", failed: false },
    },
    overrides || {},
  );
}

/** Everything configured and answering, as the baseline the healthy cases vary. */
function healthy(overrides) {
  return base(
    Object.assign(
      {
        health: health(),
        reachedAt: NOW - 30000,
        portfolio: portfolio(),
        activity: activity([]),
        collections: collections(SAMPLE_COLLECTIONS),
        updatedAt: NOW - 30000,
      },
      overrides || {},
    ),
  );
}

const CASES = [
  // ------------------------------------------------------------------------------ getting started
  {
    id: "starting",
    category: "Getting started",
    title: "Starting — the first read has not landed",
    looking:
      "The first frame after login, before anything has answered. It must not look like an error, " +
      "and it must not look finished either.",
    reading: base({}),
  },
  {
    id: "setup-fresh",
    category: "Getting started",
    title: "Setup — nothing configured yet",
    looking:
      "What every new user sees first. One obvious next action, and the two steps behind it out of " +
      "the way. Check that the step marker, its title and the progress bar agree about which step " +
      "is current.",
    reading: base({
      health: health({ wallet: "", collections: [], credentials: { apiKey: false, pat: false } }),
      reachedAt: NOW,
    }),
  },
  {
    id: "setup-key-stored",
    category: "Getting started",
    title: "Setup — API key stored, no wallet yet",
    looking: "One step done, one to go. Does the completed step leave the queue, or linger?",
    reading: base({
      health: health({ wallet: "", collections: [], credentials: { apiKey: true, pat: false } }),
      reachedAt: NOW,
    }),
  },
  {
    id: "setup-optional-only",
    category: "Getting started",
    title: "Setup — required path done, optional left",
    looking:
      "The optional steps expand on their own here, because now they are the only thing left. " +
      "Check that this does not read as an unfinished setup.",
    reading: base({
      health: health({ collections: [] }),
      reachedAt: NOW,
      portfolio: portfolio(),
      activity: activity([]),
      updatedAt: NOW - 30000,
    }),
  },

  // ------------------------------------------------------------------------------- things wrong
  {
    id: "offline-cold",
    category: "Something is wrong",
    title: "Offline — the service has never answered",
    looking:
      "Nothing cached, nothing to show. This is the state a stopped service produces on a fresh " +
      "boot. It should offer the fix, not a stack trace.",
    reading: base({
      healthError: "connection refused",
      unit: { loaded: true, active: "inactive", failed: false },
    }),
  },
  {
    id: "offline-warm",
    category: "Something is wrong",
    title: "Offline — last known values, marked as such",
    looking:
      "The numbers are real but old, and the panel has to say so without shouting. Is it obvious " +
      "at a glance that these are not current?",
    reading: healthy({ healthError: "connection refused" }),
  },
  {
    id: "stale",
    category: "Something is wrong",
    title: "Stale — configured, but everything has outlived its TTL",
    looking:
      "Distinct from offline: the service is up, the readings are just old. Check that the two " +
      "states do not look identical.",
    reading: healthy({
      portfolio: portfolio_stale(),
      activity: envelope({ assetEvents: [] }, { receivedAt: NOW - 3600000, meta: { stale: true } }),
      collections: envelope(SAMPLE_COLLECTIONS, { receivedAt: NOW - 3600000, meta: { stale: true } }),
      updatedAt: NOW - 3600000,
    }),
  },
  {
    id: "key-rejected",
    category: "Something is wrong",
    title: "Warning — the stored key is being rejected",
    looking:
      "A credential exists and does not work, which is not the same as missing. The 401 has to " +
      "send the user back to the key step rather than tick it.",
    reading: base({
      health: health(),
      reachedAt: NOW,
      portfolio: envelope(null, { error: "unauthorized", status: 401 }),
      updatedAt: NOW - 30000,
    }),
  },
  {
    id: "collection-error",
    category: "Something is wrong",
    title: "Warning — one collection failed, the rest are fine",
    looking:
      "A row that could not be fetched must stay visible and say why. Check that one bad row does " +
      "not make the whole list look broken.",
    reading: healthy({
      collections: collections([
        SAMPLE_COLLECTIONS[0],
        { slug: "sample-gone", error: "OpenSea API 404 Not Found" },
      ]),
    }),
    view: { detailsOpen: true },
  },

  // ----------------------------------------------------------------------------------- working
  {
    id: "ready-quiet",
    category: "Working",
    title: "Ready — nothing waiting",
    looking:
      "The common case, and the one most worth getting right. A total, where it came from, and " +
      "one row of controls. Is anything here decoration?",
    reading: healthy({}),
  },
  {
    id: "ready-offers",
    category: "Working",
    title: "Ready — offers waiting, one closing today",
    looking:
      "Two numbers competing for the same attention. Does the thing with a clock on it read as " +
      "more urgent than the thing without?",
    reading: healthy({
      activity: activity([
        offer(),
        offer({ asset: { collection: "sample-apes", identifier: "2222", name: "SAMPLE Ape #2222" } }),
        offer({ orderType: "collection_offer", asset: undefined }),
      ]),
    }),
  },
  {
    id: "ready-urgent",
    category: "Working",
    title: "Ready — a deadline inside the hour",
    looking:
      "The one place the theme's urgent colour is used. Check the contrast of that colour against " +
      "this panel's ground, not against the bar's.",
    reading: healthy({
      activity: activity([
        offer({ expirationDate: Math.floor((NOW + 11 * 60000) / 1000) }),
        offer({
          expirationDate: Math.floor((NOW + 40 * 60000) / 1000),
          asset: { collection: "sample-apes", identifier: "2222", name: "SAMPLE Ape #2222" },
        }),
      ]),
    }),
  },
  {
    id: "ready-multi-wallet",
    category: "Working",
    title: "Ready — several wallets",
    looking:
      "The hero pill becomes a count rather than an address. Check the provenance line: it is a " +
      "claim about which addresses, and it has to stay legible when there are more than one.",
    reading: healthy({
      health: health({
        wallet: [ADDRESS, ADDRESS_2, OTHER].join(","),
        collections: ["sample-cats", "sample-apes"],
      }),
    }),
  },
  {
    id: "value-hidden",
    category: "Working",
    title: "Ready — the value is hidden",
    looking:
      "Someone screen-sharing presses V. Everything else must stay useful with the number gone, " +
      "and the layout must not jump.",
    reading: healthy({}),
    settings: { showValue: false },
  },

  // ------------------------------------------------------------------------------ the second view
  {
    id: "details-open",
    category: "The second view",
    title: "Details — the whole disclosure",
    looking:
      "The longest the panel ever gets. This is where crowding shows up first: check the vertical " +
      "rhythm between blocks, and whether every row still has one thing leading it.",
    reading: healthy({
      activity: activity([offer()]),
      balances: envelope({
        balances: [
          { symbol: "SAMPLE", valueUsd: "3333.33", chain: "ethereum" },
          { symbol: "TEST", valueUsd: "1111.11", chain: "base" },
        ],
      }),
    }),
    view: { detailsOpen: true },
  },
];

function portfolio_stale() {
  const entry = portfolio();
  entry.receivedAt = NOW - 3600000;
  entry.meta = { stale: true };
  return entry;
}

if (typeof module !== "undefined") {
  module.exports = { CASES: CASES, NOW: NOW };
}
