import "server-only";
import { getDb } from "./index";

/**
 * A token bucket in SQLite so limits survive process restarts. Returns true when the call may
 * proceed. `ratePerMinute` refills continuously up to `burst`.
 */
export function takeToken(key: string, ratePerMinute: number, burst: number): boolean {
  const db = getDb();
  const now = Date.now();
  const run = db.transaction((): boolean => {
    const row = db.prepare("SELECT tokens, updated_at FROM rate_limits WHERE key = ?").get(key) as { tokens: number; updated_at: number } | undefined;
    const refill = row ? ((now - row.updated_at) / 60000) * ratePerMinute : burst;
    const tokens = Math.min(burst, (row?.tokens ?? 0) + refill);
    if (tokens < 1) {
      db.prepare("INSERT OR REPLACE INTO rate_limits (key, tokens, updated_at) VALUES (?, ?, ?)").run(key, tokens, now);
      return false;
    }
    db.prepare("INSERT OR REPLACE INTO rate_limits (key, tokens, updated_at) VALUES (?, ?, ?)").run(key, tokens - 1, now);
    return true;
  });
  return run();
}
