#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/**
 * Anchor data service entry point.
 *
 *   anchor-service                 start the local API
 *   anchor-service --set-api-key   store the OpenSea API key in the OS keyring
 *   anchor-service --set-pat       store the OpenSea PAT, used to mint wallet tokens (auth.ts)
 *   anchor-service --check-credentials  prove the stored credentials actually authenticate
 */
import { readSecret } from "../../scripts/read-secret.ts";
import { WalletTokenProvider } from "./auth.ts";
import { Cache } from "./cache.ts";
import { configPath, loadConfig } from "./config.ts";
import { getApiKey, getPat, keyringAvailable, looksLikeCredential, setApiKey, setPat } from "./keyring.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp, HOST } from "./server.ts";
import { installService, uninstallService } from "./unit.ts";
import { describeTokenShape, resolveWallets, walletsFromToken } from "./wallet-token.ts";

/** `/health` may be polled once a second; spawning secret-tool that often is not free. */
const CREDENTIAL_CACHE_MS = 30_000;

async function promptForSecret(which: "apiKey" | "pat"): Promise<void> {
  if (!(await keyringAvailable())) {
    console.error("secret-tool not found. Install libsecret and try again.");
    process.exit(1);
  }
  const prompt = which === "apiKey" ? "OpenSea API key: " : "OpenSea personal access token: ";
  const value = await readSecret(prompt);
  if (!value) {
    console.error("Nothing entered; no change made.");
    process.exit(1);
  }
  // A credential is one opaque token: no spaces, no control characters. Anything else is not a
  // secret that arrived, it is a line that arrived — and storing it would report success while
  // leaving the real credential unset. This has happened: running the command through a wrapper
  // that gives it a non-TTY stdin fed the reader its own command line, which was then stored,
  // and `/health` reported the PAT present until the first 401 said otherwise.
  if (!looksLikeCredential(value)) {
    console.error(
      "That does not look like a credential — it contains whitespace or control characters.\n" +
        "Nothing was stored. If you piped the value in, check that only the token reached stdin:\n" +
        `  read -rs -p "token: " T && printf '%s' "$T" | anchor-service ${which === "apiKey" ? "--set-api-key" : "--set-pat"} && unset T`,
    );
    process.exit(1);
  }
  await (which === "apiKey" ? setApiKey(value) : setPat(value));
  console.error("Stored in the OS keyring.");
}

/**
 * Prove the stored credentials actually authenticate, rather than merely existing.
 *
 * `/health` reports a credential "present" when the keyring returns a non-empty string, which is how
 * a shell command once passed as an API key for a day. This makes a real request against a route
 * that is **known to 401 without a key** — verified by removing the key and watching it fail, which
 * is the only thing that makes it a control. Deliberately not `/collections/{slug}/stats`: that
 * endpoint is public and returns 200 for anyone, so it proves nothing.
 */
async function checkCredentials(): Promise<void> {
  const apiKey = await getApiKey();
  if (apiKey === null) {
    console.error("No API key stored. Run: anchor-service --set-api-key");
    process.exit(1);
  }

  // Vitalik's address: a large public account that is guaranteed to exist.
  //
  // The cache-busting parameter is the whole point. Cloudflare fronts api.opensea.io with a cache
  // key that does not include the API key, so a warmed GET is served to anyone — which is exactly
  // how a shell command passed as a valid credential here for a day. A unique parameter forces a
  // miss, so the origin is the thing judging the key. `cf-cache-status` is then checked rather than
  // assumed: a HIT means this probe proved nothing and must not be reported as success.
  const probe =
    "https://api.opensea.io/api/v2/account/0xd8da6bf26964af9d7eed9e03e53415d37aa96045/tokens" +
    `?limit=1&_cb=${randomUUID()}`;
  let status: number;
  let cacheStatus: string | null;
  try {
    const res = await fetch(probe, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    cacheStatus = res.headers.get("cf-cache-status");
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error(`Could not reach the OpenSea API (${name}). Check your connection.`);
    process.exit(1);
  }

  if (status === 401 || status === 403) {
    console.error(
      `API key rejected (${status}). The key is stored but does not authenticate — it may be ` +
        "revoked, or the wrong value. Re-run: anchor-service --set-api-key",
    );
    process.exit(1);
  }
  if (status >= 500) {
    console.error(`OpenSea returned ${status}. The key looks fine; the API is having trouble.`);
    process.exit(1);
  }
  if (cacheStatus !== null && cacheStatus.toUpperCase() === "HIT") {
    console.error(
      `Inconclusive: the response was served from cache (cf-cache-status: ${cacheStatus}), so the ` +
        "API never judged the key. Try again in a moment.",
    );
    process.exit(1);
  }
  console.error(
    `API key authenticates (${status}${cacheStatus === null ? "" : `, cf-cache-status: ${cacheStatus}`}).`,
  );

  const pat = await getPat();
  if (pat === null) {
    console.error("No wallet PAT stored. Nothing Anchor reads needs one; see the header of auth.ts.");
    return;
  }
  // The API key gets a live probe above; the PAT gets a shape line. Neither settles for "present",
  // which is the claim that let a shell command pass as a credential for a day.
  console.error("Wallet PAT stored. Unused by current reads, kept for writes and wallet-scoped routes.");
  console.error(`  shape: ${describeTokenShape(pat).summary}`);
}

function memoize<T>(fn: () => Promise<T>, ms: number): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    if (value === null || Date.now() - at > ms) {
      at = Date.now();
      value = fn();
    }
    return value;
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--set-api-key")) {
    await promptForSecret("apiKey");
    return;
  }
  if (process.argv.includes("--set-pat")) {
    await promptForSecret("pat");
    return;
  }
  if (process.argv.includes("--check-credentials")) {
    await checkCredentials();
    return;
  }
  // Installing beats documenting. The instructions this replaces ended in `systemctl --user start`,
  // which is this session only — so every setup worked until the first reboot and then quietly did
  // not, with nothing to suggest why.
  if (process.argv.includes("--install-service")) {
    installService();
    return;
  }
  if (process.argv.includes("--uninstall-service")) {
    uninstallService();
    return;
  }

  const configured = loadConfig();
  // A wallet PAT is issued *to* a wallet and carries the address as a claim, so the empty case has
  // an answer that needs no network call and no scope. Config still wins: see `wallet-token.ts`.
  let resolvedWallets = resolveWallets(configured.wallets, await getPat(), configured.chains);
  if (resolvedWallets.wallets.length === 0) {
    // The stored PAT is usually opaque, so it carries no claims — but exchanging it yields a JWT
    // that carries both the authenticated `wallet` and a `linked_wallets` list. This is one network
    // call at startup, only on the path where nothing else supplied a wallet, and every failure
    // leaves the service exactly as it was.
    try {
      const accessToken = await new WalletTokenProvider({ getPat }).token();
      if (accessToken !== null) {
        const wallets = walletsFromToken(accessToken, configured.chains);
        if (wallets.length > 0) {
          resolvedWallets = { wallets, source: "token", detail: "" };
        }
      }
    } catch {
      // Keep the reason from `resolveWallets`; an exchange failure is not more informative than
      // "no wallet configured", and auth.ts has already refused to quote the response body.
    }
  }
  const config = { ...configured, wallets: [...resolvedWallets.wallets] };
  const cache = new Cache();
  const walletToken = new WalletTokenProvider({ getPat });
  const client = new OpenSeaClient({
    chains: config.chains,
    requestsPerSecond: config.requestsPerSecond,
    cache,
    walletToken,
  });

  const credentials = memoize(
    async () => ({ apiKey: (await getApiKey()) !== null, pat: (await getPat()) !== null }),
    CREDENTIAL_CACHE_MS,
  );

  // One line answering "why is everything 401" without reading any code.
  const present = await credentials();
  console.error(
    `anchor-service credentials: api key ${present.apiKey ? "present" : "MISSING (--set-api-key)"}, ` +
      `wallet PAT ${present.pat ? "present" : "MISSING (--set-pat; account routes will refuse)"}`,
  );
  console.error(`anchor-service chains: ${config.chains.join(", ")} (path-scoped reads use the first)`);
  if (config.wallets.length === 0) {
    console.error(`Warning: no wallet set (${resolvedWallets.detail}). Edit ${configPath()}`);
  } else if (resolvedWallets.source === "token") {
    // Say where it came from. A wallet nobody typed into the config is exactly the kind of number
    // that should name its source rather than simply appear.
    console.error(`anchor-service wallet: ${config.wallets[0]} (from the wallet PAT, not ${configPath()})`);
  }

  const server = createApp(config, client, {
    credentials,
    walletSource: resolvedWallets.source,
    walletDetail: resolvedWallets.detail,
  });
  server.listen(config.port, HOST, () => {
    console.error(`anchor-service listening on http://${HOST}:${config.port}`);
  });

  const shutdown = () => {
    // close() alone waits for idle sockets; a polling widget holding keep-alive means the callback
    // never fires and systemd eventually SIGKILLs us with the cache unclosed.
    server.close(() => {
      cache.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      cache.close();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
