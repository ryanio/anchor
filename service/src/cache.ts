/**
 * SQLite response cache, using Node's built-in `node:sqlite` — no native dependency.
 *
 * Freshness is a first-class value here, not an implementation detail: every read reports how old
 * the data is and whether it is stale, so the UI can show it. A stale floor price displayed as
 * current is a bug (docs/security.md).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.ts";

export interface CacheEntry<T> {
  data: T;
  /** Unix seconds when this was fetched from the network. */
  fetchedAt: number;
  ageSeconds: number;
  /** True when past its TTL. Stale data is still served — with this flag set. */
  stale: boolean;
}

export class Cache {
  #db: DatabaseSync;

  constructor(path?: string) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    this.#db = new DatabaseSync(path ?? join(dir, "cache.sqlite"));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        key        TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        ttl        INTEGER NOT NULL
      ) STRICT;
    `);
  }

  get<T>(key: string): CacheEntry<T> | null {
    const row = this.#db
      .prepare("SELECT body, fetched_at, ttl FROM responses WHERE key = ?")
      .get(key) as { body: string; fetched_at: number; ttl: number } | undefined;
    if (!row) return null;

    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = now - row.fetched_at;
    return {
      data: JSON.parse(row.body) as T,
      fetchedAt: row.fetched_at,
      ageSeconds,
      // >= not >: a ttl of N means fresh for N seconds, and a ttl of 0 is immediately stale.
      stale: ageSeconds >= row.ttl,
    };
  }

  put(key: string, data: unknown, ttlSeconds: number): void {
    this.#db
      .prepare(
        `INSERT INTO responses (key, body, fetched_at, ttl) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET body = excluded.body,
                                        fetched_at = excluded.fetched_at,
                                        ttl = excluded.ttl`,
      )
      .run(key, JSON.stringify(data), Math.floor(Date.now() / 1000), ttlSeconds);
  }

  close(): void {
    this.#db.close();
  }
}
