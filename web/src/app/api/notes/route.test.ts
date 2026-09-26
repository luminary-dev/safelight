import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNote, listNotes } from "@/lib/agent/project-notes";
import { resetDbForTests } from "@/lib/db";
import { DELETE, GET, POST } from "./route";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-notes-api-"));
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

describe("/api/notes", () => {
  it("GET returns a project's notes newest first and requires projectId", async () => {
    appendNote("p1", "first", "agent");
    appendNote("p1", "second", "user");
    const res = await GET(req("/api/notes?projectId=p1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: { note: string; source: string }[] };
    expect(body.notes.map((n) => n.note)).toEqual(["second", "first"]);
    expect((await GET(req("/api/notes"))).status).toBe(400);
  });

  it("GET honors a limit", async () => {
    for (let i = 0; i < 5; i++) appendNote("p1", `n${i}`);
    const body = (await (await GET(req("/api/notes?projectId=p1&limit=2"))).json()) as { notes: unknown[] };
    expect(body.notes).toHaveLength(2);
  });

  it("POST saves a user-sourced note", async () => {
    const res = await POST(req("/api/notes?projectId=p1", { method: "POST", body: JSON.stringify({ note: "from the UI" }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: { source: string; note: string } };
    expect(body.note).toMatchObject({ source: "user", note: "from the UI" });
    expect(listNotes("p1")[0].source).toBe("user");

    expect((await POST(req("/api/notes?projectId=p1", { method: "POST", body: JSON.stringify({ note: "  " }) }))).status).toBe(400);
    expect((await POST(req("/api/notes?projectId=p1", { method: "POST", body: "nope" }))).status).toBe(400);
    expect((await POST(req("/api/notes", { method: "POST", body: JSON.stringify({ note: "x" }) }))).status).toBe(400);
  });

  it("DELETE removes exactly one note by id", async () => {
    const keep = appendNote("p1", "keep");
    const drop = appendNote("p1", "drop");
    expect((await DELETE(req(`/api/notes?id=${drop.id}`, { method: "DELETE" }))).status).toBe(200);
    expect(listNotes("p1").map((n) => n.id)).toEqual([keep.id]);
    expect((await DELETE(req(`/api/notes?id=${drop.id}`, { method: "DELETE" }))).status).toBe(404);
    expect((await DELETE(req("/api/notes?id=abc", { method: "DELETE" }))).status).toBe(400);
  });
});
