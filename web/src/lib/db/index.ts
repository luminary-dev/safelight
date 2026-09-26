import "server-only";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** One data root for everything on disk; resolved once so standalone builds do not trace the world. */
export function dataDir(): string {
  return process.env.SAFELIGHT_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");
}

/** Numbered, append-only migrations. Never edit an applied entry — add the next number. */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('chat','image','code','design')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        titled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX sessions_kind_updated ON sessions (kind, updated_at DESC);
      CREATE INDEX sessions_project ON sessions (project_id);
      CREATE TABLE themes (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        images INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0
      );
    `,
  },
];

let db: Database.Database | null = null;
let dbPath: string | null = null;

function migrate(d: Database.Database) {
  d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(d.prepare("SELECT id FROM schema_migrations").all().map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const run = d.transaction(() => {
      d.exec(m.sql);
      d.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    });
    run();
  }
}

/** One-shot import of the pre-SQLite JSON files; the originals are kept, renamed *.migrated. */
function importLegacyJson(d: Database.Database, dir: string) {
  const sessionsFile = process.env.SAFELIGHT_SESSIONS_FILE ?? process.env.STUDIO_SESSIONS_FILE ?? path.join(dir, "sessions.json");
  if (existsSync(sessionsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(sessionsFile, "utf8")) as {
        sessions?: { id: string; kind: string; projectId?: string | null; title: string; titled?: boolean; createdAt: number; updatedAt: number }[];
        projects?: { id: string; title: string; createdAt: number; updatedAt: number }[];
      };
      const insertProject = d.prepare("INSERT OR REPLACE INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)");
      const insertSession = d.prepare("INSERT OR REPLACE INTO sessions (id, kind, project_id, title, titled, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const run = d.transaction(() => {
        for (const p of parsed.projects ?? []) insertProject.run(p.id, p.title, p.createdAt, p.updatedAt);
        for (const s of parsed.sessions ?? []) {
          insertSession.run(s.id, s.kind, s.projectId ?? null, s.title, s.titled ? 1 : 0, s.createdAt, s.updatedAt, JSON.stringify(s));
        }
      });
      run();
      renameSync(sessionsFile, `${sessionsFile}.migrated`);
    } catch (err) {
      console.error("Legacy sessions.json import failed; leaving the file in place:", err);
    }
  }
  const themesDir = path.join(dir, "themes");
  if (existsSync(themesDir)) {
    const insertTheme = d.prepare("INSERT OR REPLACE INTO themes (name, data, saved_at) VALUES (?, ?, ?)");
    for (const f of readdirSync(themesDir).filter((f) => f.endsWith(".json"))) {
      const full = path.join(themesDir, f);
      try {
        const theme = JSON.parse(readFileSync(full, "utf8")) as { name?: string; savedAt?: number };
        insertTheme.run(theme.name ?? f.replace(/\.json$/, ""), JSON.stringify(theme), theme.savedAt ?? statSync(full).mtimeMs);
        renameSync(full, `${full}.migrated`);
      } catch (err) {
        console.error(`Theme import failed for ${f}; leaving it in place:`, err);
      }
    }
  }
}

/** Nightly-ish local backup: a VACUUM'd copy in data/backups, newest 7 kept. */
function maybeBackup(d: Database.Database, dir: string) {
  try {
    const backups = path.join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    const existing = readdirSync(backups)
      .filter((f) => f.endsWith(".db"))
      .sort();
    const newest = existing[existing.length - 1];
    const dayMs = 24 * 60 * 60 * 1000;
    if (newest && Date.now() - statSync(path.join(backups, newest)).mtimeMs < dayMs) return;
    const stamp = new Date().toISOString().slice(0, 10);
    d.exec(`VACUUM INTO '${path.join(backups, `safelight-${stamp}.db`).replace(/'/g, "''")}'`);
    for (const f of existing.slice(0, Math.max(0, existing.length - 6))) rmSync(path.join(backups, f), { force: true });
  } catch (err) {
    console.error("Backup failed:", err);
  }
}

export function getDb(): Database.Database {
  const dir = dataDir();
  const wanted = path.join(dir, "safelight.db");
  if (db && dbPath === wanted) return db;
  db?.close();
  mkdirSync(dir, { recursive: true });
  const fresh = !existsSync(wanted);
  db = new Database(wanted);
  dbPath = wanted;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  if (fresh || (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n === 0) importLegacyJson(db, dir);
  maybeBackup(db, dir);
  return db;
}

/** Tests point SAFELIGHT_DATA_DIR at a temp folder and reset between cases. */
export function resetDbForTests() {
  db?.close();
  db = null;
  dbPath = null;
}

export function backupNow(): string {
  const d = getDb();
  const backups = path.join(dataDir(), "backups");
  mkdirSync(backups, { recursive: true });
  const file = path.join(backups, `safelight-${Date.now()}.db`);
  d.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

export function copyDatabaseTo(target: string) {
  const d = getDb();
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath!, target);
}
