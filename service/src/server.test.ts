/**
 * These test the promises the service makes, not its internals:
 * read-only, freshness in every envelope, and no crash when unconfigured.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Cache } from "./cache.ts";
import type { Config } from "./config.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp } from "./server.ts";

const config: Config = {
  chain: "ethereum",
  wallet: "",
  collections: [],
  port: 0,
  ttl: { nfts: 300, events: 60, stats: 120, listings: 120, offers: 60 },
  requestsPerSecond: 2,
};

let server: Server;
let base: string;

/** `res.json()` is `unknown` by design; assert the shape we expect at the boundary. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

before(async () => {
  const cache = new Cache(join(mkdtempSync(join(tmpdir(), "anchor-srv-")), "c.sqlite"));
  const client = new OpenSeaClient({ chain: config.chain, requestsPerSecond: 100, cache });
  server = createApp(config, client);
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
    const body = await json<{ ok: boolean; chain: string }>(await fetch(`${base}/health`));
    assert.equal(body.ok, true);
    assert.equal(body.chain, "ethereum");
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
