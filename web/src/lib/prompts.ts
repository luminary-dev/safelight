import "server-only";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * The prompt library: saved prompts in SQLite (migration 7) plus wildcard
 * expansion for render prompts.
 *
 * Wildcards:
 * - `{a|b|c}` picks one option uniformly, seeded by the render seed so a locked
 *   seed reproduces the exact same expansion. Options may nest: `{a|{b|c} d}`.
 * - `__title__` inserts the saved prompt with that title (case-insensitive),
 *   one level deep: references inside the inserted text are left literal, which
 *   also makes cycles harmless.
 */

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  negative: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PromptInput {
  id?: string;
  title: string;
  text: string;
  negative?: string;
  tags?: string[];
}

interface PromptRow {
  id: string;
  title: string;
  text: string;
  negative: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

function toPrompt(row: PromptRow): SavedPrompt {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags ?? "[]");
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* stray tags text stays empty */
  }
  return { id: row.id, title: row.title, text: row.text, negative: row.negative ?? "", tags, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Lists saved prompts, newest first. `search` filters by title or tag (case-insensitive substring). */
export function listPrompts(search?: string): SavedPrompt[] {
  const db = getDb();
  if (search?.trim()) {
    const like = `%${search.trim().toLowerCase().replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare("SELECT * FROM prompts WHERE LOWER(title) LIKE ? OR LOWER(COALESCE(tags,'')) LIKE ? ORDER BY updated_at DESC LIMIT 200")
      .all(like, like) as PromptRow[];
    return rows.map(toPrompt);
  }
  return (db.prepare("SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 200").all() as PromptRow[]).map(toPrompt);
}

export function getPrompt(id: string): SavedPrompt | undefined {
  const row = getDb().prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;
  return row ? toPrompt(row) : undefined;
}

/** Case-insensitive title lookup for `__title__` wildcards; the newest match wins. */
export function getPromptByTitle(title: string): SavedPrompt | undefined {
  const row = getDb().prepare("SELECT * FROM prompts WHERE LOWER(title) = ? ORDER BY updated_at DESC LIMIT 1").get(title.trim().toLowerCase()) as PromptRow | undefined;
  return row ? toPrompt(row) : undefined;
}

/** Inserts or updates one saved prompt. Title and text must be non-empty. */
export function upsertPrompt(input: PromptInput): SavedPrompt {
  const title = String(input.title ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!title) throw new Error("A saved prompt needs a title.");
  if (!text) throw new Error("A saved prompt needs its prompt text.");
  const id = input.id?.trim() || randomUUID();
  const negative = typeof input.negative === "string" ? input.negative : "";
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, 16) : [];
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO prompts (id, title, text, negative, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, text = excluded.text, negative = excluded.negative, tags = excluded.tags, updated_at = excluded.updated_at`,
    )
    .run(id, title, text, negative, JSON.stringify(tags), now, now);
  return getPrompt(id)!;
}

/** Removes one saved prompt. Returns whether a row existed. */
export function deletePrompt(id: string): boolean {
  return getDb().prepare("DELETE FROM prompts WHERE id = ?").run(id).changes > 0;
}

// ---------- wildcard expansion ----------

/**
 * Small deterministic PRNG (splitmix32-style) seeded from the render seed, so
 * every `{a|b}` pick is reproducible for a locked seed. Seeds may exceed 32
 * bits (randomSeed goes to MAX_SAFE_INTEGER), so both halves are folded in.
 */
export function seededRng(seed: number): () => number {
  const s = Math.abs(Math.floor(seed));
  let a = ((s >>> 0) ^ (Math.floor(s / 0x100000000) >>> 0) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/** Finds the `}` matching the `{` at `start`, or -1 when unbalanced. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on `|` at the top nesting level only, so `{a|{b|c}}` keeps its inner group intact. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

export type PromptResolver = (title: string) => string | null | undefined;

const MAX_REF_DEPTH = 1;

function expand(text: string, rng: () => number, resolve: PromptResolver, depth: number, visited: ReadonlySet<string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      const end = matchBrace(text, i);
      if (end !== -1) {
        const options = splitTopLevel(text.slice(i + 1, end));
        const pick = options[Math.min(options.length - 1, Math.floor(rng() * options.length))] ?? "";
        out += expand(pick, rng, resolve, depth, visited);
        i = end + 1;
        continue;
      }
    }
    if (ch === "_" && text.startsWith("__", i)) {
      const close = text.indexOf("__", i + 2);
      if (close > i + 2) {
        const name = text.slice(i + 2, close).trim();
        const key = name.toLowerCase();
        if (name && !name.includes("\n") && depth < MAX_REF_DEPTH && !visited.has(key)) {
          const sub = resolve(name);
          if (typeof sub === "string") {
            out += expand(sub, rng, resolve, depth + 1, new Set([...visited, key]));
            i = close + 2;
            continue;
          }
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Expands `{a|b|c}` picks and `__title__` references in a prompt. Deterministic
 * for a given seed; unknown titles, unbalanced braces and too-deep references
 * are left as literal text.
 */
export function expandWildcards(text: string, seed: number, resolve: PromptResolver = () => null): string {
  if (!text || !/[{_]/.test(text)) return text;
  return expand(text, seededRng(seed), resolve, 0, new Set());
}

/** Whether a prompt contains anything expandWildcards would touch. */
export function hasWildcards(text: string): boolean {
  return /\{[^}]*\}/.test(text) || /__[^_\n][^\n]*?__/.test(text);
}

/** expandWildcards wired to the prompt library: `__title__` looks up a saved prompt's text. */
export function expandPromptText(text: string, seed: number): string {
  return expandWildcards(text, seed, (title) => {
    try {
      return getPromptByTitle(title)?.text ?? null;
    } catch {
      return null; // a broken DB must never break a render
    }
  });
}
