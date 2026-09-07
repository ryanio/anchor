#!/usr/bin/env node
/**
 * Anchor data service entry point.
 *
 *   anchor-service                 start the local API
 *   anchor-service --set-api-key   store the OpenSea API key in the OS keyring
 */
import { createInterface } from "node:readline/promises";
import { loadConfig, configPath } from "./config.ts";
import { Cache } from "./cache.ts";
import { OpenSeaClient } from "./opensea.ts";
import { createApp, HOST } from "./server.ts";
import { setApiKey, getApiKey, keyringAvailable } from "./keyring.ts";

async function promptForApiKey(): Promise<void> {
  if (!(await keyringAvailable())) {
    console.error("secret-tool not found. Install libsecret and try again.");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const key = (await rl.question("OpenSea API key: ")).trim();
  rl.close();
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
    server.close(() => {
      cache.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
