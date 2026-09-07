#!/usr/bin/env node
/**
 * Anchor data service entry point.
 *
 *   anchor-service                 start the local API
 *   anchor-service --set-api-key   store the OpenSea API key in the OS keyring
 *   anchor-service --set-pat       store the OpenSea PAT, used to mint wallet tokens (auth.ts)
 */
import { readSecret } from "../../scripts/read-secret.ts";
import { WalletTokenProvider } from "./auth.ts";
import { Cache } from "./cache.ts";
import { configPath, loadConfig } from "./config.ts";
import { getApiKey, getPat, keyringAvailable, looksLikeCredential, setApiKey, setPat } from "./keyring.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp, HOST } from "./server.ts";

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

  const config = loadConfig();
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
  if (!config.wallet) {
    console.error(`Warning: no wallet set. Edit ${configPath()}`);
  }

  const server = createApp(config, client, { credentials });
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
