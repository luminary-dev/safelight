import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { deleteSetting, getSetting, setSetting } from "@/lib/db/settings";
import { makeTestDb, type TestDb } from "@/test/fixtures/db";

/** db/settings.ts had no dedicated tests (TEST-BRIEF §7). */

let db: TestDb;

beforeEach(async () => {
  db = await makeTestDb();
});

afterEach(async () => {
  await db.cleanup();
});

describe("settings", () => {
  it("round-trips JSON values of every shape", () => {
    setSetting("bool", true);
    setSetting("num", 4.5);
    setSetting("str", "hello");
    setSetting("obj", { a: [1, 2], b: null });
    expect(getSetting("bool", false)).toBe(true);
    expect(getSetting("num", 0)).toBe(4.5);
    expect(getSetting("str", "")).toBe("hello");
    expect(getSetting("obj", {})).toEqual({ a: [1, 2], b: null });
  });

  it("answers the fallback for an absent key without creating it", () => {
    expect(getSetting("missing", "fallback")).toBe("fallback");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });

  it("overwrites in place — one row per key, last value wins", () => {
    setSetting("k", 1);
    setSetting("k", 2);
    expect(getSetting("k", 0)).toBe(2);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'k'").get()).toEqual({ n: 1 });
  });

  it("falls back when the stored value is unreadable garbage instead of throwing", () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('broken', '{not json')").run();
    expect(getSetting("broken", "safe")).toBe("safe");
  });

  it("deleteSetting removes the key and tolerates a missing one", () => {
    setSetting("gone", 1);
    deleteSetting("gone");
    expect(getSetting("gone", "fallback")).toBe("fallback");
    expect(() => deleteSetting("never-existed")).not.toThrow();
  });

  it("stores null as an explicit value, distinct from an absent key", () => {
    setSetting("nullable", null);
    expect(getSetting<null | string>("nullable", "fallback")).toBeNull();
  });
});
