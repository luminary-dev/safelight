import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { makeTestDb, type TestDb } from "./db";

let db: TestDb | null = null;

afterEach(async () => {
  await db?.cleanup();
  db = null;
  vi.restoreAllMocks();
});

describe("db fixture", () => {
  it("opens a freshly migrated database inside the sandbox", async () => {
    db = await makeTestDb();
    const d = getDb();
    expect(existsSync(path.join(db.dataDir, "safelight.db"))).toBe(true);
    // Every numbered migration applied.
    const applied = d.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[];
    expect(applied.length).toBeGreaterThanOrEqual(7);
    expect(applied.map((r) => r.id)).toEqual(Array.from({ length: applied.length }, (_, i) => i + 1));
    // The core tables exist and are empty.
    for (const table of ["projects", "sessions", "themes", "settings", "usage_events", "rate_limits", "agent_runs", "library_items", "prompts"]) {
      expect((d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    // The classic silent corruptor is actually on.
    expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("gives each test an isolated database", async () => {
    db = await makeTestDb();
    getDb().prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p1', 't', 1, 1)").run();
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
    await db.cleanup();

    db = await makeTestDb();
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(0);
  });

  it("keeps every database file inside the sandbox", async () => {
    db = await makeTestDb();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    db.assertNoStrayWrites();
  });
});
