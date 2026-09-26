import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as exportGET } from "@/app/api/export/route";
import { POST as importPOST } from "@/app/api/import/route";
import { backupNow, getDb, resetDbForTests } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/db/settings";
import { listProjects, listSessions, listThemes, saveTheme, upsertProject, upsertSession } from "@/lib/db/sessions";
import type { Session } from "@/lib/session-types";
import { freezeClock, type FrozenClock } from "@/test/determinism";
import { aChatSession, aCodeSession, aDesignSession, anImageSession, aProject, resetFactorySequence } from "@/test/factories";
import { makeTestDb, type TestDb } from "@/test/fixtures/db";

/**
 * The migration runner and everything around it (TEST-BRIEF §7): golden schema,
 * pragmas, parallel writers, backups + retention, corrupt files, the legacy
 * sessions.json importer, and the export → wipe → import round trip.
 *
 * NOT REACHABLE from outside the module (documented, not silently skipped):
 * - Mid-migration failure/rollback: the MIGRATIONS array is module-internal and
 *   const, so a bad statement cannot be injected without editing production
 *   code. What is observable — schema_migrations holding exactly the applied
 *   ids, each migration wrapped in d.transaction() — is asserted below.
 */

let db: TestDb;

beforeEach(async () => {
  db = await makeTestDb();
  resetFactorySequence();
});

afterEach(async () => {
  await db.cleanup();
});

function dbFile(): string {
  return path.join(db.dataDir, "safelight.db");
}

/** Same normalization the checked-in fixture was generated with. */
function schemaDump(d: Database.Database): string {
  const rows = d
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  return rows.map((r) => `-- ${r.type} ${r.name} (on ${r.tbl_name})\n${(r.sql ?? "").replace(/\s+/g, " ").trim()};`).join("\n\n") + "\n";
}

describe("migration runner", () => {
  it("migrates empty → head to exactly the checked-in golden schema (an edited-in-place migration fails here)", () => {
    const golden = readFileSync(path.join(__dirname, "fixtures", "golden-schema.sql"), "utf8");
    expect(schemaDump(getDb())).toBe(golden);
  });

  it("records every migration id once in schema_migrations with a timestamp", () => {
    const rows = getDb().prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all() as { id: number; applied_at: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const r of rows) expect(r.applied_at).toBeGreaterThan(0);
  });

  it("re-opening an already-migrated database applies nothing and loses nothing", () => {
    upsertProject(aProject({ id: "p1" }));
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    resetDbForTests();
    const after = getDb().prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
  });

  it("FINDING: a database stamped by a NEWER app version is opened silently, not refused", () => {
    // §7 wants a clear refusal. Today an unknown future migration id is simply
    // ignored — the open succeeds and the schema is left as-is. This test pins
    // the current behavior so a future refusal shows up as a deliberate change.
    getDb().prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (999, 1)").run();
    resetDbForTests();
    expect(() => getDb()).not.toThrow();
    const ids = (getDb().prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids).toContain(999);
  });
});

describe("connection pragmas", () => {
  it("actually turns foreign_keys ON (off by default in SQLite)", () => {
    const d = getDb();
    expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
    // And it is enforced, not just set: an event for a run that does not exist must be refused.
    d.prepare("INSERT INTO agent_runs (id, client_id, mode, provider, model, started_at) VALUES ('r1', 'c', 'chat', 'openai', 'm', 1)").run();
    expect(() => d.prepare("INSERT INTO agent_events (run_id, seq, ts, data) VALUES ('ghost', 0, 1, '{}')").run()).toThrow(/FOREIGN KEY/i);
    // ON DELETE CASCADE flows through.
    d.prepare("INSERT INTO agent_events (run_id, seq, ts, data) VALUES ('r1', 0, 1, '{}')").run();
    d.prepare("DELETE FROM agent_runs WHERE id = 'r1'").run();
    expect(d.prepare("SELECT COUNT(*) AS n FROM agent_events").get()).toEqual({ n: 0 });
  });

  it("runs in WAL mode", () => {
    expect(getDb().pragma("journal_mode", { simple: true })).toBe("wal");
  });
});

describe("WAL + busy: parallel writers", () => {
  it("20 interleaved writers over 5 connections: no SQLITE_BUSY, no lost write", async () => {
    getDb(); // create + migrate
    const extras = Array.from({ length: 4 }, () => new Database(dbFile()));
    try {
      const connections = [getDb(), ...extras];
      const WRITERS = 20;
      const PER_WRITER = 25;
      const insert = (c: Database.Database, writer: number, i: number) =>
        c
          .prepare("INSERT INTO usage_events (ts, provider, model, mode, input_tokens, output_tokens, images, duration_ms, cost) VALUES (?, 'p', ?, 'chat', 1, 1, 0, 0, 0)")
          .run(writer * 1000 + i, `writer-${writer}-row-${i}`);
      await Promise.all(
        Array.from({ length: WRITERS }, (_, w) => async () => {
          const conn = connections[w % connections.length];
          for (let i = 0; i < PER_WRITER; i++) {
            insert(conn, w, i);
            await new Promise((r) => setImmediate(r)); // yield so writers interleave
          }
        }).map((fn) => fn()),
      );
      const rows = getDb().prepare("SELECT model FROM usage_events").all() as { model: string }[];
      expect(rows).toHaveLength(WRITERS * PER_WRITER);
      expect(new Set(rows.map((r) => r.model)).size).toBe(WRITERS * PER_WRITER); // every write distinct — none lost
    } finally {
      for (const c of extras) c.close();
    }
  });
});

describe("backups", () => {
  it("backupNow writes a VACUUM'd copy that opens clean and holds the data", () => {
    upsertProject(aProject({ id: "p1", title: "Kept" }));
    const file = backupNow();
    expect(file).toContain(path.join(db.dataDir, "backups"));
    const restored = new Database(file, { readonly: true });
    try {
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(restored.prepare("SELECT title FROM projects WHERE id = 'p1'").get()).toEqual({ title: "Kept" });
    } finally {
      restored.close();
    }
  });

  it("the daily sweep keeps exactly 7 backups, dropping the oldest", async () => {
    const backups = path.join(db.dataDir, "backups");
    mkdirSync(backups, { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 1; i <= 10; i++) {
      const f = path.join(backups, `safelight-2026-01-${String(i).padStart(2, "0")}.db`);
      writeFileSync(f, "stale");
      utimesSync(f, old, old);
    }
    getDb(); // opening runs maybeBackup: newest seeded backup is >24h old, so a fresh one is written and the sweep prunes
    const kept = (await readdir(backups)).filter((f) => f.endsWith(".db")).sort();
    expect(kept).toHaveLength(7);
    // The 4 oldest seeded files are gone; the 6 newest seeded ones plus today's remain.
    for (let i = 1; i <= 4; i++) expect(kept).not.toContain(`safelight-2026-01-0${i}.db`);
    for (let i = 5; i <= 10; i++) expect(kept).toContain(`safelight-2026-01-${String(i).padStart(2, "0")}.db`);
  });
});

describe("corrupt database file", () => {
  it("FINDING: a truncated/garbage DB file throws a raw SqliteError from getDb, with no restore offer", () => {
    // §7 asks for "a clear error and a restore offer, not a stack trace". Today
    // the SqliteError propagates out of getDb() unwrapped — pinned here so any
    // future friendly handling is a visible behavior change.
    writeFileSync(dbFile(), "definitely not a sqlite file, far too short anyway");
    expect(() => getDb()).toThrow(/file is not a database/i);
  });
});

describe("legacy sessions.json importer", () => {
  const legacy = (sessions: unknown[], projects: unknown[] = []) => {
    const file = path.join(db.dataDir, "sessions.json");
    writeFileSync(file, JSON.stringify({ sessions, projects }));
    return file;
  };

  it("imports all four session kinds and projects, then renames the file .migrated", async () => {
    const sessions: Session[] = [aChatSession({ id: "s-chat" }), anImageSession({ id: "s-image" }), aCodeSession({ id: "s-code" }), aDesignSession({ id: "s-design", projectId: "p1" })];
    const file = legacy(sessions, [aProject({ id: "p1" })]);
    getDb();
    const back = await listSessions();
    expect(back.map((s) => [s.id, s.kind]).sort()).toEqual([
      ["s-chat", "chat"],
      ["s-code", "code"],
      ["s-design", "design"],
      ["s-image", "image"],
    ]);
    // Mode-specific payloads ride along in the JSON blob.
    const code = back.find((s) => s.id === "s-code")!;
    expect(code.kind === "code" && code.root).toMatch(/^\/tmp\/fake-repo/);
    const image = back.find((s) => s.id === "s-image")!;
    expect(image.kind === "image" && image.jobs).toHaveLength(1);
    const design = back.find((s) => s.id === "s-design")!;
    expect(design.projectId).toBe("p1");
    expect(await listProjects()).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.migrated`)).toBe(true);
  });

  it("is idempotent: a second open after the rename imports nothing twice", async () => {
    legacy([aChatSession({ id: "s1" })]);
    getDb();
    resetDbForTests();
    getDb();
    expect(await listSessions()).toHaveLength(1);
    expect(existsSync(path.join(db.dataDir, "sessions.json.migrated"))).toBe(true);
  });

  it("never re-imports into a store that already has sessions", async () => {
    await upsertSession(aChatSession({ id: "existing" }));
    const file = legacy([aChatSession({ id: "late-arrival" })]);
    resetDbForTests();
    getDb();
    expect((await listSessions()).map((s) => s.id)).toEqual(["existing"]);
    expect(existsSync(file)).toBe(true); // untouched, no .migrated
  });

  it("malformed JSON fails safe: the original stays in place and the DB still opens", async () => {
    const file = path.join(db.dataDir, "sessions.json");
    writeFileSync(file, "{ this is not json");
    expect(() => getDb()).not.toThrow();
    expect(await listSessions()).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.migrated`)).toBe(false);
  });

  it("a constraint-violating session rolls the whole import back and skips the rename", async () => {
    // 'weird' violates the sessions.kind CHECK — the valid sibling must not survive the failed transaction.
    const file = legacy([aChatSession({ id: "good" }), { ...aChatSession(), id: "bad", kind: "weird" }]);
    expect(() => getDb()).not.toThrow();
    expect(await listSessions()).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.migrated`)).toBe(false);
  });
});

describe("export → wipe → import", () => {
  let clock: FrozenClock;

  beforeEach(() => {
    clock = freezeClock("2026-09-26T12:00:00Z");
  });

  afterEach(() => {
    clock.restore();
  });

  async function exportDoc(): Promise<{ text: string; doc: Record<string, unknown> }> {
    const res = await exportGET();
    const text = await res.text();
    return { text, doc: JSON.parse(text) as Record<string, unknown> };
  }

  function importReq(body: unknown): NextRequest {
    return new Request("http://127.0.0.1/api/import", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as NextRequest;
  }

  it("round-trips sessions, projects, themes and settings by deep equality", async () => {
    await upsertProject(aProject({ id: "p1" }));
    await upsertSession(aChatSession({ id: "s1", projectId: "p1" }));
    await upsertSession(anImageSession({ id: "s2", jobs: 2 }));
    await upsertSession(aCodeSession({ id: "s3" }));
    await upsertSession(aDesignSession({ id: "s4" }));
    saveTheme("sea-glass", { colors: { bg: "#fff" } });
    setSetting("localOnly", true);
    setSetting("spendLimitDayHard", 5);

    const before = {
      sessions: (await listSessions()).sort((a, b) => a.id.localeCompare(b.id)),
      projects: await listProjects(),
      themes: listThemes(),
    };
    const { doc } = await exportDoc();

    await db.cleanup(); // wipe: brand-new empty data root
    db = await makeTestDb();

    const res = await importPOST(importReq(doc));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, projects: 1, sessions: 4, themes: 1 });

    expect((await listSessions()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.sessions);
    expect(await listProjects()).toEqual(before.projects);
    expect(listThemes()).toEqual(before.themes);
    expect(getSetting("localOnly", false)).toBe(true);
    expect(getSetting("spendLimitDayHard", 0)).toBe(5);
  });

  it("carries no key material and no data-root paths", async () => {
    // The vault file sits right next to the DB; nothing from it may leak into an export.
    writeFileSync(path.join(db.dataDir, "keys.enc.json"), JSON.stringify({ v: 1, blob: "sk-super-secret-key-material" }));
    await upsertSession(aChatSession({ id: "s1" }));
    setSetting("localOnly", true);
    const { text } = await exportDoc();
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("keys.enc");
    expect(text).not.toContain(db.dataDir); // the machine's data root never appears
    expect(text).not.toMatch(/gsk_|AIza|api[_-]?key/i);
  });

  it("FINDING (documented): code-session roots are absolute machine paths and DO appear in exports", async () => {
    // The root is user content (the folder they pointed the agent at), so the
    // export keeps it — but it makes an export machine-identifying. Pinned so
    // the trade-off is explicit, and flagged in the test report.
    await upsertSession(aCodeSession({ id: "c1", root: "/Users/example/projects/safelight" }));
    const { text } = await exportDoc();
    expect(text).toContain("/Users/example/projects/safelight");
  });

  it("refuses non-export documents and invalid JSON", async () => {
    expect((await importPOST(importReq({ format: "other", version: 1 }))).status).toBe(400);
    expect((await importPOST(importReq({ format: "safelight-export", version: 2 }))).status).toBe(400);
    const garbage = new Request("http://127.0.0.1/api/import", { method: "POST", body: "{not json" }) as unknown as NextRequest;
    expect((await importPOST(garbage)).status).toBe(400);
  });

  it("hostile import: duplicate ids in the payload — the last occurrence wins", async () => {
    const doc = {
      format: "safelight-export",
      version: 1,
      sessions: [aChatSession({ id: "dup", title: "first" }), aChatSession({ id: "dup", title: "second" })],
    };
    const res = await importPOST(importReq(doc));
    expect((await res.json()).sessions).toBe(2); // both counted…
    const back = await listSessions();
    expect(back).toHaveLength(1); // …but upsert-by-id means one row
    expect(back[0].title).toBe("second");
  });

  it("hostile import: ids colliding with existing rows overwrite them (merge semantics)", async () => {
    await upsertSession(aChatSession({ id: "mine", title: "original" }));
    await importPOST(importReq({ format: "safelight-export", version: 1, sessions: [aChatSession({ id: "mine", title: "imported" })] }));
    expect((await listSessions())[0].title).toBe("imported");
  });

  it("hostile import: unknown kinds, id-less rows and key-less settings are skipped, valid rows still land", async () => {
    const doc = {
      format: "safelight-export",
      version: 1,
      sessions: [{ id: "weird", kind: "malware", title: "x" }, { kind: "chat", title: "no id" }, aChatSession({ id: "ok" })],
      projects: [{ id: "p-no-title" }, aProject({ id: "p-ok" })],
      settings: [{ value: "keyless" }, { key: "kept", value: 1 }],
    };
    const res = await importPOST(importReq(doc));
    expect(await res.json()).toMatchObject({ ok: true, sessions: 1, projects: 1 });
    expect((await listSessions()).map((s) => s.id)).toEqual(["ok"]);
    expect((await listProjects()).map((p) => p.id)).toEqual(["p-ok"]);
    expect(getSetting("kept", 0)).toBe(1);
  });

  it("FINDING (documented): there is no size cap — an oversized import is accepted whole", async () => {
    const doc = {
      format: "safelight-export",
      version: 1,
      sessions: Array.from({ length: 1500 }, (_, i) => aChatSession({ id: `bulk-${i}`, messages: [] })),
    };
    const res = await importPOST(importReq(doc));
    expect((await res.json()).sessions).toBe(1500);
    expect(await listSessions()).toHaveLength(1500);
  });
});
