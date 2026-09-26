import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { brave } from "./brave";
import { ddg } from "./ddg";
import { tavily } from "./tavily";
import type { SearchProvider, SearchResult } from "./types";

const TTL_MS = 60 * 60 * 1000;
const MAX_RESULTS = 8;

/** Keyed providers first; the ddg scrape is the last resort. */
export const DEFAULT_PROVIDERS: SearchProvider[] = [brave, tavily, ddg];

export interface SearchOutcome {
  provider: string;
  results: SearchResult[];
  cached: boolean;
}

/** Cache key: sha256 of the normalised query so trivially-different phrasings share an entry. */
export function queryHash(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex");
}

export async function searchWeb(query: string, opts?: { providers?: SearchProvider[]; signal?: AbortSignal }): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) throw new Error("Empty query.");
  const providers = opts?.providers ?? DEFAULT_PROVIDERS;
  const db = getDb();
  const hash = queryHash(q);
  const row = db.prepare("SELECT provider, results, created_at FROM search_cache WHERE query_hash = ?").get(hash) as
    | { provider: string; results: string; created_at: number }
    | undefined;
  if (row && Date.now() - row.created_at < TTL_MS) {
    return { provider: row.provider, results: JSON.parse(row.results) as SearchResult[], cached: true };
  }
  let lastError: unknown = null;
  for (const p of providers) {
    if (!p.available()) continue;
    try {
      // Each attempt gets its own timeout so a hung provider cannot eat the whole chain.
      const results = (await p.search(q, opts?.signal ?? AbortSignal.timeout(15000))).slice(0, MAX_RESULTS);
      db.prepare("INSERT OR REPLACE INTO search_cache (query_hash, provider, results, created_at) VALUES (?, ?, ?, ?)").run(hash, p.id, JSON.stringify(results), Date.now());
      return { provider: p.id, results, cached: false };
    } catch (err) {
      if (opts?.signal?.aborted) throw err; // caller cancelled — do not fail over
      lastError = err;
    }
  }
  if (lastError) throw new Error(`All search providers failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  throw new Error("No search provider is available.");
}
