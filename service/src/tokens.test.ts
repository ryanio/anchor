/**
 * The token half of the service, end to end through the local HTTP API.
 *
 * OpenSea is both marketplaces (docs/tokens.md), so "check my OpenSea activity" has to mean NFTs
 * *and* tokens. What is tested here is the part that is genuinely new rather than a second noun:
 * chains reaching the endpoints that take them, the primary chain reaching the ones whose path
 * carries a single chain, and the second credential these routes need.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import type { ChainIdentifier } from "@opensea/api-types";
import { WalletTokenProvider } from "./auth.ts";
import {
  API_KEY,
  type Call,
  type Handler,
  JWT,
  jsonResponse,
  PAT,
  stubFetch,
  tempCache,
  testConfig,
  withExchange,
} from "./fixtures.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp } from "./server.ts";

const WALLET = "0x1E0049783F008A0085193E00003D00cd54003c71";
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface Rig {
  base: string;
  calls: Call[];
  close: () => Promise<void>;
}

/**
 * A live loopback server wired to a stubbed `fetch`. Real HTTP, because the routing and the
 * status codes are the thing under test; no real network, because nothing here has credentials.
 */
async function rig(
  opts: {
    handler?: Handler;
    chains?: ChainIdentifier[];
    pat?: string | null;
    tokens?: string[];
    wallet?: string;
  } = {},
): Promise<Rig> {
  const { calls, restore } = stubFetch(withExchange(opts.handler ?? (() => jsonResponse({ ok: true }))));
  const config = testConfig({
    chains: opts.chains ?? ["ethereum"],
    wallet: opts.wallet ?? WALLET,
    tokens: opts.tokens ?? [],
  });
  const client = new OpenSeaClient({
    chains: config.chains,
    requestsPerSecond: 1000,
    cache: tempCache(),
    walletToken: new WalletTokenProvider({ getPat: async () => (opts.pat === undefined ? PAT : opts.pat) }),
    getApiKey: async () => API_KEY,
  });
  const server = createApp(config, client, {
    credentials: async () => ({ apiKey: true, pat: opts.pat !== null }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    calls,
    close: async () => {
      restore();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const rigs: Rig[] = [];
async function open(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(opts);
  rigs.push(r);
  return r;
}
after(async () => {
  for (const r of rigs) await r.close();
});

function upstream(calls: Call[]): URL {
  const call = calls.find((c) => c.method === "GET");
  assert.ok(call, "expected an upstream GET");
  return new URL(call.url);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("token routes", () => {
  const routes: Array<[string, string]> = [
    ["/balances", `/api/v2/account/${WALLET}/tokens`],
    ["/portfolio/value", `/api/v2/account/${WALLET}/portfolio`],
    ["/tokens/trending", "/api/v2/tokens/trending"],
    ["/tokens/top", "/api/v2/tokens/top"],
    [`/tokens/${SOL_MINT}`, `/api/v2/chain/ethereum/token/${SOL_MINT}`],
    [`/tokens/${SOL_MINT}/price_history`, `/api/v2/chain/ethereum/token/${SOL_MINT}/price_history`],
  ];

  for (const [route, expected] of routes) {
    test(`GET ${route} reaches ${expected}`, async () => {
      const r = await open();
      const res = await fetch(`${r.base}${route}`);
      const body = await json<{ meta: { stale: boolean; fetchedAt: string } }>(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(upstream(r.calls).pathname, expected);
      // Every response carries freshness, tokens included.
      assert.equal(body.meta.stale, false);
      assert.ok(Date.parse(body.meta.fetchedAt) > 0);
    });
  }

  test("price history defaults to the last day rather than failing on a required param", async () => {
    const r = await open();
    await fetch(`${r.base}/tokens/${SOL_MINT}/price_history`);
    const start = upstream(r.calls).searchParams.get("start_time");
    assert.ok(start, "start_time is required by the endpoint and must be defaulted");
    const age = Date.now() - Date.parse(start);
    assert.ok(age > 23 * 3600_000 && age < 25 * 3600_000, `unexpected window: ${start}`);
  });

  test("/tokens returns one entry per watched token", async () => {
    const r = await open({ tokens: [WALLET, "0x0000000000000000000000000000000000000001"] });
    const body = await json<{ data: unknown[]; meta: { count: number; chain: string } }>(
      await fetch(`${r.base}/tokens`),
    );
    assert.equal(body.meta.count, 2);
    assert.equal(body.meta.chain, "ethereum");
  });
});

describe("chains reach the endpoints that take them", () => {
  test("chains-aware endpoints get every configured chain", async () => {
    for (const route of ["/balances", "/portfolio/value", "/tokens/trending", "/tokens/top"]) {
      const r = await open({ chains: ["ethereum", "solana", "base"] });
      await fetch(`${r.base}${route}`);
      assert.deepEqual(
        upstream(r.calls).searchParams.getAll("chains"),
        ["ethereum", "solana", "base"],
        `${route} must forward every configured chain`,
      );
    }
  });

  test("path-scoped endpoints use the first configured chain", async () => {
    const r = await open({ chains: ["solana", "ethereum"] });
    await fetch(`${r.base}/tokens/${SOL_MINT}`, { headers: {} });
    assert.equal(upstream(r.calls).pathname, `/api/v2/chain/solana/token/${SOL_MINT}`);
  });

  test("/health reports the configured chains and which one is path-scoped", async () => {
    const r = await open({ chains: ["solana", "base"] });
    const body = await json<{ chains: string[]; primaryChain: string; credentials: unknown }>(
      await fetch(`${r.base}/health`),
    );
    assert.deepEqual(body.chains, ["solana", "base"]);
    assert.equal(body.primaryChain, "solana");
    assert.deepEqual(body.credentials, { apiKey: true, pat: true });
  });

  test("a Solana-only setup answers the same routes", async () => {
    const r = await open({ chains: ["solana"], wallet: SOL_MINT });
    for (const route of ["/balances", "/portfolio/value", "/tokens/trending"]) {
      assert.equal((await fetch(`${r.base}${route}`)).status, 200, route);
    }
    const health = await json<{ wallet: string }>(await fetch(`${r.base}/health`));
    assert.equal(health.wallet, SOL_MINT);
  });
});

describe("the second credential", () => {
  test("a wallet-scoped route without a PAT is a 401 naming the fix, with no upstream call", async () => {
    const r = await open({ pat: null });
    const res = await fetch(`${r.base}/balances`);
    assert.equal(res.status, 401);
    const { error } = await json<{ error: string }>(res);
    assert.match(error, /--set-pat/);
    assert.match(error, /\/balances/);
    assert.equal(r.calls.length, 0, "a missing credential must be caught before the network");
  });

  test("the JWT is minted once and reused across calls", async () => {
    const r = await open();
    await fetch(`${r.base}/balances`);
    await fetch(`${r.base}/portfolio/value`);
    await fetch(`${r.base}/tokens/trending`);

    const exchanges = r.calls.filter((c) => c.url.includes("/auth/tokens/exchange"));
    assert.equal(exchanges.length, 1, "one exchange, not one per request");
    assert.equal(exchanges[0]!.method, "POST");
    assert.deepEqual(JSON.parse(exchanges[0]!.body ?? "{}"), {
      subjectToken: PAT,
      subjectTokenType: "ACCESS_TOKEN",
    });

    for (const call of r.calls.filter((c) => c.method === "GET")) {
      assert.equal(call.headers["x-api-key"], API_KEY, "the API key is still required");
      assert.equal(call.headers.authorization, `Bearer ${JWT}`);
    }
  });

  test("public routes do not mint a wallet token at all", async () => {
    const r = await open();
    await fetch(`${r.base}/collections/cool-cats/stats`);
    assert.equal(r.calls.filter((c) => c.url.includes("/auth/tokens/exchange")).length, 0);
    assert.equal(r.calls[0]!.headers.authorization, undefined);
  });

  test("a rejected PAT is a 401 that says the PAT is the problem, not a bare passthrough", async () => {
    const { calls, restore } = stubFetch((call) =>
      call.url.includes("/auth/tokens/exchange")
        ? jsonResponse({ errors: ["nope"] }, { status: 401 })
        : jsonResponse({ ok: true }),
    );
    try {
      const config = testConfig({ wallet: WALLET });
      const client = new OpenSeaClient({
        chains: config.chains,
        requestsPerSecond: 1000,
        cache: tempCache(),
        walletToken: new WalletTokenProvider({ getPat: async () => PAT }),
        getApiKey: async () => API_KEY,
      });
      const server = createApp(config, client);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/balances`);
      assert.equal(res.status, 401);
      const { error } = await json<{ error: string }>(res);
      assert.match(error, /PAT/);
      assert.match(error, /--set-pat/);
      assert.ok(!error.includes(PAT), "the credential must never appear in the error");
      assert.equal(calls.filter((c) => c.method === "GET").length, 0);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      restore();
    }
  });
});
