import { resetDbForTests } from "@/lib/db";
import { makeTestRoot, type TestRoot } from "./tmpdir";

/**
 * A freshly migrated SQLite database per test, inside a sandboxed root.
 *
 *   let db: TestDb;
 *   beforeEach(async () => { db = await makeTestDb(); });
 *   afterEach(() => db.cleanup());
 *
 * getDb() from "@/lib/db" then opens <sandbox>/data/safelight.db, runs every
 * migration, and never sees the user's real data/. cleanup() closes the
 * connection (resetDbForTests) before the tree is deleted, so no test leaks a
 * handle into another test's database.
 */

export interface TestDb extends TestRoot {
  cleanup(): Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
  const root = await makeTestRoot();
  // No legacy files in the sandbox — keep the import path quiet unless a test stages one.
  const prevSessions = process.env.SAFELIGHT_SESSIONS_FILE;
  const prevStudio = process.env.STUDIO_SESSIONS_FILE;
  delete process.env.SAFELIGHT_SESSIONS_FILE;
  delete process.env.STUDIO_SESSIONS_FILE;
  resetDbForTests();
  return {
    ...root,
    cleanup: async () => {
      resetDbForTests();
      if (prevSessions !== undefined) process.env.SAFELIGHT_SESSIONS_FILE = prevSessions;
      if (prevStudio !== undefined) process.env.STUDIO_SESSIONS_FILE = prevStudio;
      await root.cleanup();
    },
  };
}
