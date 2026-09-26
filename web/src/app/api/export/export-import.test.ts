import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { listSessions, saveTheme, upsertProject, upsertSession } from "@/lib/db/sessions";
import { setSetting } from "@/lib/db/settings";
import type { Session } from "@/lib/session-types";
import { aChatSession, aProject } from "@/test/factories";
import { POST as IMPORT } from "../import/route";
import { GET as EXPORT } from "./route";

/**
 * /api/export + /api/import (TEST-BRIEF §8): the data-portability round trip
 * through a sandboxed database, plus hostile import documents. The export must
 * never contain provider keys (they live in the vault, not in these tables).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-export-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function importReq(body: unknown): Promise<Response> {
  return IMPORT(
    new Request("http://localhost:3001/api/import", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

interface ExportDoc {
  format: string;
  version: number;
  sessions: Session[];
  projects: { id: string; title: string }[];
  themes: { name: string }[];
  settings: { key: string; value: unknown }[];
}

describe("GET /api/export", () => {
  it("exports everything the user made as one attachment-disposed JSON document", async () => {
    await upsertProject(aProject({ id: "p1", title: "Shoot" }));
    await upsertSession(aChatSession({ id: "s1", projectId: "p1" }));
    saveTheme("dusk", { colors: { bg: "#000" } });
    setSetting("telemetryEnabled", true);

    const res = await EXPORT();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="safelight-export-\d{4}-\d{2}-\d{2}\.json"/);
    const doc = (await res.json()) as ExportDoc;
    expect(doc.format).toBe("safelight-export");
    expect(doc.version).toBe(1);
    expect(doc.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(doc.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(doc.themes.map((t) => t.name)).toEqual(["dusk"]);
    expect(doc.settings).toContainEqual({ key: "telemetryEnabled", value: true });
  });
});

describe("POST /api/import", () => {
  it("round-trips an export into a fresh database", async () => {
    await upsertProject(aProject({ id: "p1", title: "Shoot" }));
    await upsertSession(aChatSession({ id: "s1", projectId: "p1", title: "Chat one" }));
    saveTheme("dusk", { colors: { bg: "#000" } });
    const doc = (await (await EXPORT()).json()) as ExportDoc;

    // A brand-new install: fresh sandbox, fresh database.
    resetDbForTests();
    const dir2 = await mkdtemp(path.join(tmpdir(), "sl-import-api-"));
    process.env.SAFELIGHT_DATA_DIR = dir2;
    try {
      const res = await importReq(doc);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, projects: 1, sessions: 1, themes: 1 });
      const sessions = await listSessions();
      expect(sessions.map((s) => ({ id: s.id, title: s.title, projectId: s.projectId }))).toEqual([{ id: "s1", title: "Chat one", projectId: "p1" }]);
    } finally {
      resetDbForTests();
      process.env.SAFELIGHT_DATA_DIR = dir;
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("re-importing the same document merges by id instead of duplicating", async () => {
    await upsertSession(aChatSession({ id: "s1" }));
    const doc = (await (await EXPORT()).json()) as ExportDoc;
    await importReq(doc);
    await importReq(doc);
    expect((await listSessions()).filter((s) => s.id === "s1")).toHaveLength(1);
  });

  it("refuses malformed JSON and non-export documents with 400", async () => {
    expect((await importReq("{nope")).status).toBe(400);
    expect((await importReq({ format: "other-app", version: 1 })).status).toBe(400);
    expect((await importReq({ format: "safelight-export", version: 99 })).status).toBe(400);
  });

  it("skips hostile rows (bad kind, missing ids) and counts only what it kept", async () => {
    const res = await importReq({
      format: "safelight-export",
      version: 1,
      sessions: [aChatSession({ id: "good" }), { ...aChatSession({ id: "bad" }), kind: "evil" }, { title: "no id" }],
      projects: [{ id: "p-ok", title: "kept" }, { id: "p-bad" }, null],
      themes: [{ name: "ok", data: {} }, { data: {} }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: number; sessions: number };
    expect(body.sessions).toBe(1);
    expect(body.projects).toBe(1);
    expect((await listSessions()).map((s) => s.id)).toEqual(["good"]);
  });
});
