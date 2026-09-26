import "server-only";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getLogger } from "@/lib/log";
import { isLocalProvider, lookupTokenPrice, priceCall } from "./pricing";

/**
 * The cost ledger: one usage_events row (migration 1) per provider call, plus
 * the aggregation the Usage page reads. recordUsage sits on the agent loop's
 * hot path and must never throw — a ledger hiccup must not kill a run.
 */

export interface UsageInsert {
  provider: string;
  model: string;
  mode: string;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  durationMs?: number;
  /** Exact charge reported by the provider (OpenRouter usage.cost); overrides the table. */
  providerCost?: number;
  ts?: number;
}

const stmtCache = new WeakMap<Database.Database, Database.Statement>();

function insertStmt(): Database.Statement {
  const db = getDb();
  let s = stmtCache.get(db);
  if (!s) {
    s = db.prepare(
      "INSERT INTO usage_events (ts, provider, model, mode, input_tokens, output_tokens, images, duration_ms, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    stmtCache.set(db, s);
  }
  return s;
}

/** Prices and inserts one ledger row. Returns what was billed; swallows storage errors. */
export function recordUsage(u: UsageInsert): { cost: number; unpriced: boolean } {
  const priced = priceCall(u);
  try {
    insertStmt().run(u.ts ?? Date.now(), u.provider, u.model, u.mode, Math.round(u.inputTokens ?? 0), Math.round(u.outputTokens ?? 0), Math.round(u.images ?? 0), Math.round(u.durationMs ?? 0), priced.cost);
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, "usage ledger write failed");
  }
  return priced;
}

/** Cloud spend (USD) since a timestamp; local providers never count. */
export function spentSince(ts: number, now = Date.now()): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM usage_events WHERE ts >= ? AND ts <= ? AND provider NOT IN ('ollama','local','comfy')")
    .get(ts, now) as { total: number };
  return row.total;
}

interface Bucket {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  images: number;
}

export interface UsageSummary {
  days: number;
  byDay: ({ day: string } & Bucket)[];
  byProvider: ({ provider: string } & Bucket)[];
  byMode: ({ mode: string } & Bucket)[];
  totals: Bucket;
  /** Cloud models we metered but could not price — the totals under-count these. */
  unpricedModels: string[];
}

const GROUP_SELECT =
  "COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(images), 0) AS images";

export function usageSummary(days = 30, now = Date.now()): UsageSummary {
  const d = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const since = now - d * 24 * 60 * 60 * 1000;
  const db = getDb();
  const byDay = db
    .prepare(`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, ${GROUP_SELECT} FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY day ORDER BY day ASC`)
    .all(since, now) as UsageSummary["byDay"];
  const byProvider = db
    .prepare(`SELECT provider, ${GROUP_SELECT} FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY provider ORDER BY cost DESC`)
    .all(since, now) as UsageSummary["byProvider"];
  const byMode = db
    .prepare(`SELECT mode, ${GROUP_SELECT} FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY mode ORDER BY cost DESC`)
    .all(since, now) as UsageSummary["byMode"];
  const totalsRow = db.prepare(`SELECT ${GROUP_SELECT} FROM usage_events WHERE ts >= ? AND ts <= ?`).get(since, now) as Bucket;
  const candidates = db
    .prepare(
      "SELECT DISTINCT provider, model FROM usage_events WHERE ts >= ? AND ts <= ? AND cost = 0 AND (input_tokens > 0 OR output_tokens > 0) AND provider NOT IN ('ollama','local','comfy')",
    )
    .all(since, now) as { provider: string; model: string }[];
  const unpricedModels = [...new Set(candidates.filter((c) => !isLocalProvider(c.provider) && !lookupTokenPrice(c.model)).map((c) => c.model))].sort();
  return { days: d, byDay, byProvider, byMode, totals: totalsRow, unpricedModels };
}
