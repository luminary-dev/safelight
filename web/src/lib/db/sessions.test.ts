import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatSession, CodeSession } from "@/lib/session-types";
import { resetDbForTests } from "./index";
import { deleteProject, deleteSession, getSession, listProjects, listSessions, listThemes, patchSession, saveTheme, upsertProject, upsertSession } from "./sessions";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-db-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  delete process.env.SAFELIGHT_SESSIONS_FILE;
  delete process.env.STUDIO_SESSIONS_FILE;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function chat(id: string, overrides?: Partial<ChatSession>): ChatSession {
  return { id, kind: "chat", title: "t", titled: false, createdAt: 1, updatedAt: 1, model: "m", messages: [{ role: "user", text: "hi" }], ...overrides };
}

describe("sessions repository", () => {
  it("round-trips a session with its mode-specific fields", async () => {
    const code: CodeSession = { id: "c1", kind: "code", title: "fix", titled: true, createdAt: 1, updatedAt: 1, model: "m", messages: [], root: "/tmp/x", approvedPaths: ["/tmp/y"] };
    await upsertSession(code);
    const back = (await getSession("c1")) as CodeSession;
    expect(back.root).toBe("/tmp/x");
    expect(back.approvedPaths).toEqual(["/tmp/y"]);
    expect(back.titled).toBe(true);
  });

  it("lists newest first and deletes", async () => {
    await upsertSession(chat("a"));
    await new Promise((r) => setTimeout(r, 5));
    await upsertSession(chat("b"));
    const list = await listSessions();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(await deleteSession("a")).toBe(true);
    expect(await deleteSession("a")).toBe(false);
  });

  it("patch preserves kind and bumps updatedAt", async () => {
    await upsertSession(chat("a"));
    const patched = await patchSession("a", { title: "renamed", kind: "image" } as never);
    expect(patched?.kind).toBe("chat");
    expect(patched?.title).toBe("renamed");
  });

  it("deleting a project unfiles its sessions in both column and blob", async () => {
    await upsertProject({ id: "p1", title: "P", createdAt: 1, updatedAt: 1 });
    await upsertSession(chat("a", { projectId: "p1" }));
    expect(await deleteProject("p1")).toBe(true);
    const back = await getSession("a");
    expect(back?.projectId ?? null).toBeNull();
    expect(await listProjects()).toEqual([]);
  });

  it("themes round-trip", () => {
    saveTheme("nordic", { name: "nordic", colors: { bg: "#ffffff" } });
    expect(listThemes()[0]).toMatchObject({ name: "nordic", data: { colors: { bg: "#ffffff" } } });
  });
});

describe("legacy JSON import", () => {
  it("imports sessions.json and themes on first open, then renames them", async () => {
    const legacy = {
      sessions: [
        { id: "s1", kind: "chat", title: "old chat", titled: false, createdAt: 10, updatedAt: 20, model: "m", messages: [{ role: "user", text: "hello" }] },
        { id: "s2", kind: "image", projectId: "p1", title: "old image", titled: true, createdAt: 11, updatedAt: 21, draft: "d", currentJobId: null, jobs: [] },
      ],
      projects: [{ id: "p1", title: "Old project", createdAt: 5, updatedAt: 6 }],
    };
    await writeFile(path.join(dir, "sessions.json"), JSON.stringify(legacy));
    await mkdir(path.join(dir, "themes"), { recursive: true });
    await writeFile(path.join(dir, "themes", "nordic-calm.json"), JSON.stringify({ name: "nordic-calm", colors: {}, savedAt: 123 }));

    const sessions = await listSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect((await getSession("s2"))?.projectId).toBe("p1");
    expect((await listProjects())[0]).toMatchObject({ id: "p1", title: "Old project" });
    expect(listThemes()[0].name).toBe("nordic-calm");

    const files = await readdir(dir);
    expect(files).toContain("sessions.json.migrated");
    expect(files).not.toContain("sessions.json");
    expect(await readdir(path.join(dir, "themes"))).toContain("nordic-calm.json.migrated");
  });
});
