/**
 * No route forgets a wallet.
 *
 * Every wallet-scoped route once read `config.wallets[0]` and every caller presented the answer as
 * the whole picture. On the machine this was found on that meant nine wallets resolving from a
 * linked-wallet PAT, one of them read, and roughly a third of the portfolio missing from the figure
 * on screen — with nothing there to suggest it.
 *
 * The fix was easy. Keeping it fixed is what this file is for: it walks `WALLET_ROUTES` rather than
 * naming routes, so a route added next year is covered the day it is added, and a route that reads
 * one wallet has to say so out loud in `SINGLE_WALLET` below with a reason attached.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { WalletTokenProvider } from "./auth.ts";
import {
  API_KEY,
  type Call,
  jsonResponse,
  PAT,
  stubFetch,
  tempCache,
  testConfig,
  withExchange,
} from "./fixtures.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp, WALLET_ROUTES } from "./server.ts";

const WALLETS = [
  "0x1E0049783F008A0085193E00003D00cd54003c71",
  "0x2E0049783F008A0085193E00003D00cd54003c72",
  "0x3E0049783F008A0085193E00003D00cd54003c73",
];

/**
 * Routes that legitimately read one wallet, and why.
 *
 * A route belongs here only with a reason that is about the data rather than about effort. Adding
 * one is a decision; leaving one out is caught by the test below.
 */
const SINGLE_WALLET = new Map([
  [
    "/portfolio/history",
    "a merged history needs the time series summed point by point across wallets, which needs the " +
      "points to share a grid the API does not promise",
  ],
  [
    "/portfolio",
    "a merged NFT list has no single cursor: paging it would need one opaque cursor per wallet " +
      "carried through one query parameter",
  ],
]);

interface Rig {
  base: string;
  calls: Call[];
  close: () => Promise<void>;
}

const rigs: Rig[] = [];
after(async () => {
  for (const r of rigs) await r.close();
});

async function open(): Promise<Rig> {
  const { calls, restore } = stubFetch(withExchange(() => jsonResponse({ ok: true })));
  const config = testConfig({ wallets: WALLETS });
  const client = new OpenSeaClient({
    chains: config.chains,
    requestsPerSecond: 1000,
    cache: tempCache(),
    walletToken: new WalletTokenProvider({ getPat: async () => PAT }),
    getApiKey: async () => API_KEY,
  });
  const server = createApp(config, client);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rig: Rig = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: async () => {
      restore();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  rigs.push(rig);
  return rig;
}

/** Which of the configured wallets appear in the upstream URLs a request produced. */
function walletsReached(calls: readonly Call[]): string[] {
  const gets = calls.filter((c) => c.method === "GET").map((c) => c.url.toLowerCase());
  return WALLETS.filter((w) => gets.some((url) => url.includes(w.toLowerCase())));
}

describe("no route forgets a wallet", () => {
  for (const route of WALLET_ROUTES) {
    const reason = SINGLE_WALLET.get(route);

    test(`${route} reads ${reason === undefined ? "every wallet" : "one wallet, on purpose"}`, async () => {
      const r = await open();
      const res = await fetch(`${r.base}${route}`);
      assert.equal(res.status, 200, `${route} should answer`);

      const reached = walletsReached(r.calls);
      if (reason === undefined) {
        assert.deepEqual(
          reached,
          WALLETS,
          `${route} answered from ${reached.length} of ${WALLETS.length} wallets. Either fan it ` +
            "out, or add it to SINGLE_WALLET with a reason.",
        );
      } else {
        assert.equal(
          reached.length,
          1,
          `${route} is listed as single-wallet (${reason}) but read ${reached.length}. If it can ` +
            "fan out now, take it off the list.",
        );
      }
    });
  }

  test("every exception is a route that exists", () => {
    // A stale exception is worse than none: it silently excuses a route that was renamed or a
    // reason that stopped being true, and nothing fails.
    for (const route of SINGLE_WALLET.keys()) {
      assert.ok(WALLET_ROUTES.has(route), `SINGLE_WALLET names ${route}, which is not a wallet route`);
    }
  });

  test("a fanned-out route sums rather than picking one", async () => {
    const totals = new Map([
      [WALLETS[0]!.toLowerCase(), "100.10"],
      [WALLETS[1]!.toLowerCase(), "200.20"],
      [WALLETS[2]!.toLowerCase(), "300.30"],
    ]);
    const { calls, restore } = stubFetch(
      withExchange((call) => {
        const wallet = [...totals.keys()].find((w) => call.url.toLowerCase().includes(w));
        return jsonResponse(wallet === undefined ? { ok: true } : { totalValueUsd: totals.get(wallet) });
      }),
    );
    const config = testConfig({ wallets: WALLETS });
    const client = new OpenSeaClient({
      chains: config.chains,
      requestsPerSecond: 1000,
      cache: tempCache(),
      walletToken: new WalletTokenProvider({ getPat: async () => PAT }),
      getApiKey: async () => API_KEY,
    });
    const server = createApp(config, client);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const body = (await (await fetch(`${base}/portfolio/value`)).json()) as {
        data: { stats: { totalValueUsd: string }; wallets: { address: string }[]; incomplete: string[] };
      };
      // 100.10 + 200.20 + 300.30, and not through a float — 600.5999999999999 is the failure this
      // number is chosen to catch.
      assert.equal(body.data.stats.totalValueUsd, "600.60");
      assert.equal(body.data.wallets.length, 3);
      assert.deepEqual(body.data.incomplete, []);
    } finally {
      restore();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      void calls;
    }
  });
});
