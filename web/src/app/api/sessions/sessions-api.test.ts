import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import type { Session } from "@/lib/session-types";
import { aChatSession, aProject } from "@/test/factories";
import { DELETE as PROJECT_DELETE, PATCH as PROJECT_PATCH } from "../projects/[id]/route";
import { GET as PROJECTS_GET, POST as PROJECTS_POST } from "../projects/route";
import { DELETE as SESSION_DELETE, GET as SESSION_GET, PATCH as SESSION_PATCH } from "./[id]/route";
import { GET as SESSIONS_GET, POST as SESSIONS_POST } from "./route";

/**
 * /api/sessions, /api/sessions/[id], /api/projects, /api/projects/[id]
 * (TEST-BRIEF §8): a PATCH cannot change id or kind, unknown ids 404, an
 * invalid kind 400, and deleting a project unfiles its sessions rather than
 * deleting them. All against a sandboxed database.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-sessions-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(`http://localhost:3001${url}`, init) as unknown as NextRequest;
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) };
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("sessions", () => {
  it("POST creates a session and GET lists it alongside projects", async () => {
    const session = aChatSession({ id: "s1", title: "Hello" });
    const created = await SESSIONS_POST(req("/api/sessions", jsonInit(session)));
    expect(created.status).toBe(200);
    const list = (await (await SESSIONS_GET()).json()) as { sessions: Session[]; projects: unknown[] };
    expect(list.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(Array.isArray(list.projects)).toBe(true);
  });

  it("rejects malformed JSON, a missing id, and an invalid kind with 400", async () => {
    expect((await SESSIONS_POST(req("/api/sessions", jsonInit("{nope")))).status).toBe(400);
    expect((await SESSIONS_POST(req("/api/sessions", jsonInit({ kind: "chat" })))).status).toBe(400);
    expect((await SESSIONS_POST(req("/api/sessions", jsonInit({ ...aChatSession({ id: "sX" }), kind: "evil" })))).status).toBe(400);
  });

  it("a session missing title or timestamps is a 400/defaulted insert, never a SqliteError 500", async () => {
    // Regression: these bodies used to reach the NOT NULL columns and crash with 500.
    expect((await SESSIONS_POST(req("/api/sessions", jsonInit({ id: "s-bare", kind: "chat" })))).status).toBe(400);
    const noTimes = await SESSIONS_POST(req("/api/sessions", jsonInit({ id: "s-nt", kind: "chat", title: "T", model: "m", messages: [] })));
    expect(noTimes.status).toBe(200);
    const { session } = (await noTimes.json()) as { session: Session };
    expect(Number.isFinite(session.createdAt)).toBe(true);
  });

  it("GET /api/sessions/[id] returns the session, or 404 when unknown", async () => {
    await SESSIONS_POST(req("/api/sessions", jsonInit(aChatSession({ id: "s1" }))));
    const found = await SESSION_GET(req("/api/sessions/s1"), ctx("s1"));
    expect(found.status).toBe(200);
    expect(((await found.json()) as { session: Session }).session.id).toBe("s1");
    expect((await SESSION_GET(req("/api/sessions/none"), ctx("none"))).status).toBe(404);
  });

  it("PATCH updates fields but can never change id or kind", async () => {
    await SESSIONS_POST(req("/api/sessions", jsonInit(aChatSession({ id: "s1", title: "Old" }))));
    const res = await SESSION_PATCH(req("/api/sessions/s1", { method: "PATCH", body: JSON.stringify({ title: "New", id: "hijacked", kind: "image" }) }), ctx("s1"));
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: Session };
    expect(session.title).toBe("New");
    expect(session.id).toBe("s1");
    expect(session.kind).toBe("chat");
    expect((await SESSION_GET(req("/api/sessions/hijacked"), ctx("hijacked"))).status).toBe(404);
  });

  it("PATCH on an unknown session 404s; malformed JSON 400s", async () => {
    expect((await SESSION_PATCH(req("/api/sessions/none", { method: "PATCH", body: JSON.stringify({ title: "x" }) }), ctx("none"))).status).toBe(404);
    expect((await SESSION_PATCH(req("/api/sessions/none", { method: "PATCH", body: "{oops" }), ctx("none"))).status).toBe(400);
  });

  it("a hostile PATCH (null title, poisoned timestamps) is 400 or ignored, never 500", async () => {
    await SESSIONS_POST(req("/api/sessions", jsonInit(aChatSession({ id: "s1", title: "Keep" }))));
    expect((await SESSION_PATCH(req("/api/sessions/s1", { method: "PATCH", body: JSON.stringify({ title: null }) }), ctx("s1"))).status).toBe(400);
    expect((await SESSION_PATCH(req("/api/sessions/s1", { method: "PATCH", body: JSON.stringify([1, 2]) }), ctx("s1"))).status).toBe(400);
    const poisoned = await SESSION_PATCH(req("/api/sessions/s1", { method: "PATCH", body: JSON.stringify({ createdAt: null, updatedAt: "later" }) }), ctx("s1"));
    expect(poisoned.status).toBe(200);
    const { session } = (await poisoned.json()) as { session: Session };
    expect(Number.isFinite(session.createdAt)).toBe(true);
  });

  it("DELETE removes the session and reports ok:false for an unknown id", async () => {
    await SESSIONS_POST(req("/api/sessions", jsonInit(aChatSession({ id: "s1" }))));
    expect(await (await SESSION_DELETE(req("/api/sessions/s1", { method: "DELETE" }), ctx("s1"))).json()).toEqual({ ok: true });
    expect(await (await SESSION_DELETE(req("/api/sessions/s1", { method: "DELETE" }), ctx("s1"))).json()).toEqual({ ok: false });
  });
});

describe("projects", () => {
  it("POST creates a project; a missing title is 400; malformed JSON is 400", async () => {
    const created = await PROJECTS_POST(req("/api/projects", jsonInit(aProject({ id: "p1", title: "Shoot" }))));
    expect(created.status).toBe(200);
    const list = (await (await PROJECTS_GET()).json()) as { projects: { id: string }[] };
    expect(list.projects.map((p) => p.id)).toEqual(["p1"]);
    expect((await PROJECTS_POST(req("/api/projects", jsonInit({ id: "p2", title: "  " })))).status).toBe(400);
    expect((await PROJECTS_POST(req("/api/projects", jsonInit("{nope")))).status).toBe(400);
    // Regression: a non-string title or missing createdAt used to 500 on the NOT NULL columns.
    expect((await PROJECTS_POST(req("/api/projects", jsonInit({ id: "p3", title: 5 })))).status).toBe(400);
    expect((await PROJECTS_POST(req("/api/projects", jsonInit({ id: "p4", title: "No times" })))).status).toBe(200);
  });

  it("PATCH renames but cannot change the id, and 404s on unknown ids", async () => {
    await PROJECTS_POST(req("/api/projects", jsonInit(aProject({ id: "p1", title: "Old" }))));
    const res = await PROJECT_PATCH(req("/api/projects/p1", { method: "PATCH", body: JSON.stringify({ title: "New", id: "stolen" }) }), ctx("p1"));
    const { project } = (await res.json()) as { project: { id: string; title: string } };
    expect(project).toMatchObject({ id: "p1", title: "New" });
    expect((await PROJECT_PATCH(req("/api/projects/none", { method: "PATCH", body: JSON.stringify({ title: "x" }) }), ctx("none"))).status).toBe(404);
    expect((await PROJECT_PATCH(req("/api/projects/p1", { method: "PATCH", body: "{oops" }), ctx("p1"))).status).toBe(400);
    // Regression: title:null used to 500 on the NOT NULL column.
    expect((await PROJECT_PATCH(req("/api/projects/p1", { method: "PATCH", body: JSON.stringify({ title: null }) }), ctx("p1"))).status).toBe(400);
  });

  it("deleting a project unfiles its sessions instead of deleting them", async () => {
    await PROJECTS_POST(req("/api/projects", jsonInit(aProject({ id: "p1", title: "Shoot" }))));
    await SESSIONS_POST(req("/api/sessions", jsonInit(aChatSession({ id: "s1", projectId: "p1" }))));
    const res = await PROJECT_DELETE(req("/api/projects/p1", { method: "DELETE" }), ctx("p1"));
    expect(await res.json()).toEqual({ ok: true });
    const kept = (await (await SESSION_GET(req("/api/sessions/s1"), ctx("s1"))).json()) as { session: Session };
    expect(kept.session.projectId ?? null).toBeNull();
    const projects = (await (await PROJECTS_GET()).json()) as { projects: unknown[] };
    expect(projects.projects).toEqual([]);
  });
});
