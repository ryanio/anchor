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
    // Only create the shared data dir when we are actually using it. Tests pass an explicit path
    // and should not touch the developer's ~/.local/share/anchor.
    let file = path;
    if (file === undefined) {
      const dir = dataDir();
      mkdirSync(dir, { recursive: true });
      file = join(dir, "cache.sqlite");
    }
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        key        TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,  -- milliseconds; seconds lost up to 1s of precision
        ttl        INTEGER NOT NULL   -- milliseconds
      ) STRICT;
    `);
  }

  get<T>(key: string): CacheEntry<T> | null {
    const row = this.#db
      .prepare("SELECT body, fetched_at, ttl FROM responses WHERE key = ?")
      .get(key) as { body: string; fetched_at: number; ttl: number } | undefined;
    if (!row) return null;

    // Stored in milliseconds. With second precision a put at t=100.9 read at t=101.0 reported an
    // age of 1s after 100ms of real time, so a "60s" ttl was really somewhere in [59, 60).
    const ageMs = Date.now() - row.fetched_at;

    // A backwards clock (NTP correction, suspend/resume) produced a negative age, which pinned
    // every entry as fresh for as long as the jump. Treat it as unknown-age and therefore stale —
    // "a stale floor price shown as current is a bug" (docs/security.md).
    if (ageMs < 0) {
      return {
        data: JSON.parse(row.body) as T,
        fetchedAt: Math.floor(row.fetched_at / 1000),
        ageSeconds: 0,
        stale: true,
      };
    }

    return {
      data: JSON.parse(row.body) as T,
      fetchedAt: Math.floor(row.fetched_at / 1000),
      ageSeconds: Math.floor(ageMs / 1000),
      // >= not >: a ttl of N means fresh for N seconds, and a ttl of 0 is immediately stale.
      stale: ageMs >= row.ttl,
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
      .run(key, JSON.stringify(data), Date.now(), Math.round(ttlSeconds * 1000));
  }

  close(): void {
    this.#db.close();
  }
}
