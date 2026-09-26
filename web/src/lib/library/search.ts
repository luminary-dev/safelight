import "server-only";
import { getDb } from "@/lib/db";
import { hamming } from "./dhash";

export interface LibraryRow {
  path: string;
  mtime: number;
  size: number;
  width: number | null;
  height: number | null;
  model: string | null;
  seed: number | null;
  prompt: string | null;
  meta: string | null;
  favorite: number;
  tags: string[];
}

export interface SearchParams {
  q?: string;
  model?: string;
  fav?: boolean;
  tag?: string;
  from?: string;
  to?: string;
  sort?: "newest" | "oldest" | "largest";
  offset?: number;
  limit?: number;
}

export interface Facet {
  value: string;
  count: number;
}

export interface SearchResult {
  items: LibraryRow[];
  total: number;
  facets: { models: Facet[]; tags: Facet[] };
}

/** Turns free text into an FTS5 prefix query: each token quoted, starred, ANDed. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

/** "2026-09-20" → start-of-day ms; bare numbers pass through; `end` pushes a date to 23:59:59.999. */
function parseWhen(v: string, end: boolean): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return end && /^\d{4}-\d{2}-\d{2}$/.test(v) ? t + 86_399_999 : t;
}

interface Cond {
  /** Renders the condition with a table prefix ("" or "i."). */
  sql: (p: string) => string;
  arg?: unknown;
  /** Facet dimension this condition belongs to, so that facet can drop it. */
  dim?: "model" | "tag";
}

function buildConds(p: SearchParams): Cond[] {
  const conds: Cond[] = [];
  const match = p.q ? ftsQuery(p.q) : "";
  if (match) conds.push({ sql: (t) => `${t}path IN (SELECT path FROM library_fts WHERE library_fts MATCH ?)`, arg: match });
  if (p.model) conds.push({ sql: (t) => `${t}model = ?`, arg: p.model, dim: "model" });
  if (p.fav) conds.push({ sql: (t) => `${t}favorite = 1` });
  if (p.tag) conds.push({ sql: (t) => `${t}path IN (SELECT path FROM library_tags WHERE tag = ?)`, arg: p.tag, dim: "tag" });
  const from = p.from ? parseWhen(p.from, false) : null;
  if (from !== null) conds.push({ sql: (t) => `${t}mtime >= ?`, arg: from });
  const to = p.to ? parseWhen(p.to, true) : null;
  if (to !== null) conds.push({ sql: (t) => `${t}mtime <= ?`, arg: to });
  return conds;
}

function whereOf(conds: Cond[], prefix: string, drop?: "model" | "tag"): { sql: string; args: unknown[] } {
  const kept = conds.filter((c) => !drop || c.dim !== drop);
  const sql = kept.length ? ` WHERE ${kept.map((c) => c.sql(prefix)).join(" AND ")}` : "";
  return { sql, args: kept.filter((c) => c.arg !== undefined).map((c) => c.arg) };
}

const ORDER: Record<NonNullable<SearchParams["sort"]>, string> = {
  newest: "mtime DESC, path ASC",
  oldest: "mtime ASC, path ASC",
  largest: "size DESC, path ASC",
};

/** One query per concern: page, total, and facet counts that ignore their own dimension. */
export function searchLibrary(p: SearchParams): SearchResult {
  const db = getDb();
  const conds = buildConds(p);
  const limit = Math.min(Math.max(p.limit ?? 120, 1), 500);
  const offset = Math.max(p.offset ?? 0, 0);
  const order = ORDER[p.sort ?? "newest"];

  const page = whereOf(conds, "");
  const items = db
    .prepare(`SELECT path, mtime, size, width, height, model, seed, prompt, meta, favorite FROM library_items${page.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...page.args, limit, offset) as Omit<LibraryRow, "tags">[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items${page.sql}`).get(...page.args) as { n: number }).n;

  // Tags for just this page, one query.
  const tagsByPath = new Map<string, string[]>();
  if (items.length) {
    const marks = items.map(() => "?").join(",");
    const rows = db.prepare(`SELECT path, tag FROM library_tags WHERE path IN (${marks}) ORDER BY tag`).all(...items.map((i) => i.path)) as { path: string; tag: string }[];
    for (const r of rows) (tagsByPath.get(r.path) ?? tagsByPath.set(r.path, []).get(r.path)!).push(r.tag);
  }

  const wModels = whereOf(conds, "", "model");
  const models = db
    .prepare(`SELECT model AS value, COUNT(*) AS count FROM library_items${wModels.sql}${wModels.sql ? " AND" : " WHERE"} model IS NOT NULL GROUP BY model ORDER BY count DESC, value ASC`)
    .all(...wModels.args) as Facet[];

  const wTags = whereOf(conds, "i.", "tag");
  const tags = db
    .prepare(`SELECT t.tag AS value, COUNT(*) AS count FROM library_tags t JOIN library_items i ON i.path = t.path${wTags.sql} GROUP BY t.tag ORDER BY count DESC, value ASC`)
    .all(...wTags.args) as Facet[];

  return { items: items.map((i) => ({ ...i, tags: tagsByPath.get(i.path) ?? [] })), total, facets: { models, tags } };
}

export function setFavorite(path: string, favorite: boolean): boolean {
  return getDb().prepare("UPDATE library_items SET favorite = ? WHERE path = ?").run(favorite ? 1 : 0, path).changes > 0;
}

/** Adds/removes tags for one item and returns the resulting list. Unknown paths return null. */
export function updateTags(path: string, add: string[], remove: string[]): string[] | null {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM library_items WHERE path = ?").get(path)) return null;
  const run = db.transaction(() => {
    for (const tag of add) {
      const clean = tag.trim().slice(0, 64);
      if (clean) db.prepare("INSERT OR IGNORE INTO library_tags (path, tag) VALUES (?, ?)").run(path, clean);
    }
    for (const tag of remove) db.prepare("DELETE FROM library_tags WHERE path = ? AND tag = ?").run(path, tag.trim());
  });
  run();
  return (db.prepare("SELECT tag FROM library_tags WHERE path = ? ORDER BY tag").all(path) as { tag: string }[]).map((r) => r.tag);
}

export interface DuplicateGroup {
  items: Omit<LibraryRow, "tags" | "meta">[];
  /** Largest pairwise distance inside the group (≤ threshold between neighbours). */
  spread: number;
}

/**
 * Groups near-identical images by dHash. A pair within hamming distance ≤ 7 must
 * share at least one of its 8 bytes verbatim (pigeonhole), so we bucket every hash
 * under each (byte-position, byte-value) key and only compare within buckets —
 * no all-pairs n².
 */
export function duplicateGroups(threshold = 6): DuplicateGroup[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT path, mtime, size, width, height, model, seed, prompt, favorite, phash FROM library_items WHERE phash IS NOT NULL AND length(phash) = 16")
    .all() as (Omit<LibraryRow, "tags" | "meta"> & { phash: string })[];

  const buckets = new Map<string, number[]>();
  rows.forEach((r, idx) => {
    for (let b = 0; b < 8; b++) {
      const key = `${b}:${r.phash.slice(b * 2, b * 2 + 2)}`;
      const list = buckets.get(key);
      if (list) list.push(idx);
      else buckets.set(key, [idx]);
    }
  });

  // Union-find over verified near pairs.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const checked = new Set<number>();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const pairKey = i * rows.length + j;
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);
        if (hamming(rows[i].phash, rows[j].phash) <= threshold) parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });

  const out: DuplicateGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let spread = 0;
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) spread = Math.max(spread, hamming(rows[list[a]].phash, rows[list[b]].phash));
    const items = list
      .map((i) => rows[i])
      .sort((a, b) => b.mtime - a.mtime)
      .map((row) => {
        const { phash: _phash, ...rest } = row;
        void _phash;
        return rest;
      });
    out.push({ items, spread });
  }
  return out.sort((a, b) => b.items.length - a.items.length || b.items[0].mtime - a.items[0].mtime);
}
