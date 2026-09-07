#!/usr/bin/env node
/**
 * Anchor data service entry point.
 *
 *   anchor-service                 start the local API
 *   anchor-service --set-api-key   store the OpenSea API key in the OS keyring
 */
import { readSecret } from "../../scripts/read-secret.ts";
import { Cache } from "./cache.ts";
import { configPath, loadConfig } from "./config.ts";
import { getApiKey, keyringAvailable, setApiKey } from "./keyring.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp, HOST } from "./server.ts";

async function promptForApiKey(): Promise<void> {
  if (!(await keyringAvailable())) {
    console.error("secret-tool not found. Install libsecret and try again.");
    process.exit(1);
  }
  const key = await readSecret("OpenSea API key: ");
  if (!key) {
    console.error("Nothing entered; no change made.");
    process.exit(1);
  }
  await setApiKey(key);
  console.error("Stored in the OS keyring.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--set-api-key")) {
    await promptForApiKey();
    return;
  }

  const config = loadConfig();
  const cache = new Cache();
  const client = new OpenSeaClient({
    chain: config.chain,
    requestsPerSecond: config.requestsPerSecond,
    cache,
  });

  if (!(await getApiKey())) {
    console.error("Warning: no OpenSea API key found. Run `anchor-service --set-api-key`.");
  }
  if (!config.wallet) {
    console.error(`Warning: no wallet set. Edit ${configPath()}`);
  }

  const server = createApp(config, client);
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
