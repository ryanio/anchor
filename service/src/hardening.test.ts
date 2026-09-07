/**
 * Regression tests for the audit findings. Each of these fails without its fix.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Cache } from "./cache.ts";
import { OpenSeaClient } from "./opensea.ts";
import { validate, type Config } from "./config.ts";

const config: Config = {
  chain: "ethereum", wallet: "", collections: [], port: 0,
  ttl: { nfts: 300, events: 60, stats: 120, listings: 120, offers: 60 },
  requestsPerSecond: 2,
};

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "anchor-h-")), "c.sqlite");
}

let server: Server;
let port: number;

before(async () => {
  const cache = new Cache(tmpDb());
  const client = new OpenSeaClient({ chain: "ethereum", requestsPerSecond: 100, cache });
  server = createApp(config, client);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => { server.closeAllConnections(); server.close(); });

/** Raw socket: `fetch` would normalise the malformed target before it ever reached the server. */
function raw(requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(requestLine));
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, 1500);
  });
}

describe("malformed request URLs do not kill the process", () => {
  test("an absolute-form target with an invalid URL gets 400, and the server survives", async () => {
    const res = await raw("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    assert.match(res, /^HTTP\/1\.1 400/);
    // The real regression: the process used to exit here.
    const after = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(after.status, 200);
  });
});

describe("DNS-rebinding defence", () => {
  // `fetch` treats `host` as a forbidden header and silently replaces it, so this has to go
  // over a raw socket to send the value an attacker actually would.
  test("a non-loopback Host header is refused", async () => {
    const res = await raw("GET /health HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n");
    assert.match(res, /^HTTP\/1\.1 403/);
  });

  test("loopback hosts are accepted", async () => {
    for (const host of ["127.0.0.1", "localhost", `127.0.0.1:${port}`]) {
      const res = await raw(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.match(res, /^HTTP\/1\.1 200/, `host ${host} should be accepted`);
    }
  });
});

describe("HEAD is read-only and therefore allowed", () => {
  test("HEAD returns 200 with no body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("writes are still refused", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" })).status, 405);
  });
});

describe("cache", () => {
  test("a backwards clock marks entries stale rather than eternally fresh", (t) => {
    const c = new Cache(tmpDb());
    c.put("k", { v: 1 }, 600);
    const realNow = Date.now;
    t.after(() => { Date.now = realNow; });
    Date.now = () => realNow() - 600_000; // clock jumps back 10 minutes
    const entry = c.get<{ v: number }>("k");
    assert.equal(entry?.stale, true, "negative age must not read as fresh");
    assert.ok((entry?.ageSeconds ?? -1) >= 0, "age must never be reported negative");
  });

  test("sub-second precision: a 1s ttl is not stale after 100ms", async () => {
    const c = new Cache(tmpDb());
    c.put("k", 1, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.get("k")?.stale, false);
  });

  test("an explicit path does not create the shared data directory", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "anchor-xdg-")), "share");
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    try {
      new Cache(tmpDb());
      assert.equal(existsSync(join(dir, "anchor")), false);
    } finally {
      prev === undefined ? delete process.env.XDG_DATA_HOME : (process.env.XDG_DATA_HOME = prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config validation", () => {
  test("a non-numeric requestsPerSecond is rejected, not silently NaN", () => {
    // NaN here disabled rate limiting entirely, with no error anywhere.
    assert.throws(() => validate({ requestsPerSecond: "fast" as unknown as number }), /requestsPerSecond/);
  });

  test("collections must be an array of strings", () => {
    assert.throws(() => validate({ collections: "one" as unknown as string[] }), /collections/);
  });

  test("valid config passes through with defaults filled in", () => {
    const c = validate({ wallet: "0xabc" });
    assert.equal(c.wallet, "0xabc");
    assert.equal(c.requestsPerSecond, 2);
    assert.equal(c.ttl.nfts, 300);
  });
});
