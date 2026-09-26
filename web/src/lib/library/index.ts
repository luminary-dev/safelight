import "server-only";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "@/lib/db";
import { OUTPUT_DIR } from "@/lib/safelight-files";
import { dhash } from "./dhash";
import { deleteThumb, ensureThumb } from "./thumbs";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const WATCH_DEBOUNCE_MS = 750;

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
}

/** Shape of the `<image>.json` render sidecar. Every field is optional on read. */
interface Sidecar {
  model?: { name?: unknown; folder?: unknown; provider?: unknown };
  prompt?: unknown;
  seed?: unknown;
  [key: string]: unknown;
}

async function walk(dir: string, rel = "", out = new Map<string, { mtime: number; size: number }>()): Promise<Map<string, { mtime: number; size: number }>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const key = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(full, key, out);
    } else if (IMAGE_EXT.test(entry.name)) {
      try {
        const s = await stat(full);
        out.set(key, { mtime: Math.floor(s.mtimeMs), size: s.size });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out;
}

/** Reads the render sidecar next to an image. Missing or garbage ⇒ null; the file still indexes. */
export async function readSidecar(absPath: string): Promise<Sidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(`${absPath}.json`, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Sidecar;
  } catch {
    /* tolerate anything */
  }
  return null;
}

const asStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** Indexes one file: sidecar + sharp metadata + dHash + thumbnail, then the row and its FTS entry. */
async function indexOne(root: string, rel: string, info: { mtime: number; size: number }): Promise<void> {
  const abs = path.join(root, rel);
  const sidecar = await readSidecar(abs);
  let width: number | null = null;
  let height: number | null = null;
  let phash: string | null = null;
  try {
    const meta = await sharp(abs).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    /* corrupt or non-image bytes: index what we know */
  }
  try {
    phash = await dhash(abs);
  } catch {
    /* ditto */
  }
  await ensureThumb(abs, rel, true);

  const model = asStr(sidecar?.model?.name);
  const prompt = asStr(sidecar?.prompt);
  const seed = asInt(sidecar?.seed);
  const meta = sidecar ? JSON.stringify(sidecar) : null;

  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO library_items (path, mtime, size, width, height, model, seed, prompt, meta, phash, favorite, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime = excluded.mtime, size = excluded.size, width = excluded.width, height = excluded.height,
         model = excluded.model, seed = excluded.seed, prompt = excluded.prompt, meta = excluded.meta,
         phash = excluded.phash, indexed_at = excluded.indexed_at`,
    ).run(rel, info.mtime, info.size, width, height, model, seed, prompt, meta, phash, Date.now());
    db.prepare("DELETE FROM library_fts WHERE path = ?").run(rel);
    db.prepare("INSERT INTO library_fts (path, prompt, model) VALUES (?, ?, ?)").run(rel, prompt ?? "", model ?? "");
  });
  write();
}

async function inPool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/** Watcher and sweep state lives on globalThis so dev-mode module reloads never stack watchers. */
interface IndexState {
  ready?: Promise<ScanResult | void>;
  scanning?: Promise<ScanResult> | null;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}
const state: IndexState = ((globalThis as unknown as { __safelightLibrary?: IndexState }).__safelightLibrary ??= {});

/**
 * Incremental sweep: upsert rows whose mtime/size changed, drop rows for vanished
 * files, keep FTS and thumbnails in step. Concurrent callers share one sweep.
 */
export function scanLibrary(root: string = OUTPUT_DIR): Promise<ScanResult> {
  if (state.scanning) return state.scanning;
  state.scanning = (async () => {
    const onDisk = await walk(root);
    const db = getDb();
    const existing = new Map(
      (db.prepare("SELECT path, mtime, size FROM library_items").all() as { path: string; mtime: number; size: number }[]).map((r) => [r.path, r]),
    );
    const upserts: [string, { mtime: number; size: number }][] = [];
    let added = 0;
    for (const [rel, info] of onDisk) {
      const cur = existing.get(rel);
      if (!cur) added++;
      if (!cur || cur.mtime !== info.mtime || cur.size !== info.size) upserts.push([rel, info]);
    }
    const removed = [...existing.keys()].filter((p) => !onDisk.has(p));

    await inPool(upserts, 4, ([rel, info]) => indexOne(root, rel, info));
    for (const rel of removed) {
      const drop = db.transaction(() => {
        db.prepare("DELETE FROM library_fts WHERE path = ?").run(rel);
        db.prepare("DELETE FROM library_items WHERE path = ?").run(rel);
      });
      drop();
      await deleteThumb(rel);
    }
    return { added, updated: upserts.length - added, removed: removed.length };
  })().finally(() => {
    state.scanning = null;
  });
  return state.scanning;
}

/** Removes rows + FTS entries + thumbs for paths deleted through the API (no need to wait for the watcher). */
export async function forgetPaths(rels: string[]): Promise<void> {
  const db = getDb();
  const drop = db.transaction(() => {
    for (const rel of rels) {
      db.prepare("DELETE FROM library_fts WHERE path = ?").run(rel);
      db.prepare("DELETE FROM library_items WHERE path = ?").run(rel);
    }
  });
  drop();
  for (const rel of rels) await deleteThumb(rel);
}

/**
 * First request pays for a full sweep; afterwards a debounced fs.watch keeps the
 * index warm and requests just read SQLite. Never rescans the world per request.
 */
export function ensureIndex(): Promise<ScanResult | void> {
  if (!state.ready) {
    state.ready = scanLibrary().catch((err) => {
      console.error("Library index sweep failed:", err);
      state.ready = undefined; // let the next request retry
    });
  }
  if (!state.watcher) {
    try {
      const w = watch(OUTPUT_DIR, { recursive: true }, () => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          void scanLibrary().catch((err) => console.error("Library rescan failed:", err));
        }, WATCH_DEBOUNCE_MS);
      });
      w.on("error", () => {
        state.watcher = undefined;
      });
      state.watcher = w;
    } catch {
      /* outputs/ may not exist yet; retried on the next request */
    }
  }
  return state.ready;
}
