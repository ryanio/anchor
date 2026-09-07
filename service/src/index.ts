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
  // Do not echo: setApiKey goes to lengths to keep the key out of argv, and echoing it into
  // scrollback (and any terminal recording) would undo that.
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const onKeypress = () => { /* suppressed while typing the secret */ };
  const prompt = "OpenSea API key: ";
  process.stderr.write(prompt);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = onKeypress;
  const key = (await rl.question("")).trim();
  rl.close();
  process.stderr.write("\n");
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
