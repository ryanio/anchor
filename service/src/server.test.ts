/**
 * These test the promises the service makes, not its internals:
 * read-only, freshness in every envelope, and no crash when unconfigured.
 */

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { WalletTokenProvider } from "./auth.ts";
import { tempCache, testConfig } from "./fixtures.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp } from "./server.ts";

const config = testConfig({ chains: ["ethereum", "solana"] });

let server: Server;
let base: string;

/** `res.json()` is `unknown` by design; assert the shape we expect at the boundary. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

before(async () => {
  const client = new OpenSeaClient({
    chains: config.chains,
    requestsPerSecond: 100,
    cache: tempCache(),
    walletToken: new WalletTokenProvider(),
  });
  server = createApp(config, client, {
    credentials: async () => ({ apiKey: true, pat: false }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe("read-only gate", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${method} is refused with 405`, async () => {
      const res = await fetch(`${base}/health`, { method });
      assert.equal(res.status, 405);
      assert.match((await json<{ error: string }>(res)).error, /read-only/i);
    });
  }

  test("GET is allowed", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

describe("routing", () => {
  test("/health reports config without touching the network", async () => {
    const body = await json<{
      ok: boolean;
      chains: string[];
      primaryChain: string;
      credentials: { apiKey: boolean; pat: boolean };
    }>(await fetch(`${base}/health`));
    assert.equal(body.ok, true);
    assert.deepEqual(body.chains, ["ethereum", "solana"]);
    // Path-scoped endpoints take one chain; /health says which, so nobody has to guess.
    assert.equal(body.primaryChain, "ethereum");
    // Answers "why is everything 401" in one glance.
    assert.deepEqual(body.credentials, { apiKey: true, pat: false });
  });

  test("unknown routes 404 with the route list", async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.ok(Array.isArray((await json<{ routes: string[] }>(res)).routes));
  });

  test("/portfolio without a wallet is a clear 428, not a crash", async () => {
    const res = await fetch(`${base}/portfolio`);
    assert.equal(res.status, 428);
    assert.match((await json<{ error: string }>(res)).error, /wallet/i);
  });

  test("trailing slashes resolve to the same route", async () => {
    assert.equal((await fetch(`${base}/health/`)).status, 200);
  });
});
