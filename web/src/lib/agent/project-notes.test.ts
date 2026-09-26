import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { appendNote, deleteNote, executeNotesTool, listNotes, MAX_NOTES_PER_PROJECT, notesToolDefs, withNotesTools } from "./project-notes";
import type { ToolContext } from "./tools";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-notes-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("project notes store", () => {
  it("round-trips notes newest first, scoped to the project", () => {
    const a = appendNote("p1", "champion model is Qwen 2.1", "agent");
    const b = appendNote("p1", "client wants lime accents", "user");
    appendNote("p2", "other project", "agent");

    const notes = listNotes("p1");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ id: b.id, projectId: "p1", source: "user", note: "client wants lime accents" });
    expect(notes[1]).toMatchObject({ id: a.id, projectId: "p1", source: "agent", note: "champion model is Qwen 2.1" });
    expect(listNotes("p1", 1)).toHaveLength(1);
    expect(listNotes("p1", 1)[0].id).toBe(b.id);
    expect(listNotes("missing")).toEqual([]);
  });

  it("rejects empty input and trims whitespace", () => {
    expect(() => appendNote("p1", "   ")).toThrow(/text/);
    expect(() => appendNote("  ", "x")).toThrow(/project id/);
    expect(appendNote("p1", "  padded  ").note).toBe("padded");
  });

  it("prunes each project to the newest 500 notes", () => {
    for (let i = 0; i < MAX_NOTES_PER_PROJECT + 10; i++) appendNote("p1", `note ${i}`);
    appendNote("p2", "untouched neighbor");

    const count = getDb().prepare("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = 'p1'").get() as { n: number };
    expect(count.n).toBe(MAX_NOTES_PER_PROJECT);
    const kept = listNotes("p1", MAX_NOTES_PER_PROJECT).map((n) => n.note);
    expect(kept[0]).toBe(`note ${MAX_NOTES_PER_PROJECT + 9}`);
    expect(kept).not.toContain("note 0");
    expect(kept).not.toContain("note 9");
    expect(kept).toContain("note 10");
    expect(listNotes("p2")).toHaveLength(1); // pruning never crosses projects
  });

  it("deletes single notes by id", () => {
    const a = appendNote("p1", "keep");
    const b = appendNote("p1", "drop");
    expect(deleteNote(b.id)).toBe(true);
    expect(deleteNote(b.id)).toBe(false);
    expect(listNotes("p1").map((n) => n.id)).toEqual([a.id]);
  });
});

describe("notes tools", () => {
  it("read_project_notes and append_project_note work against the store", async () => {
    appendNote("p1", "earlier decision", "user");
    const saved = await executeNotesTool("append_project_note", { note: "agent learned a fact" }, "p1");
    expect(saved.result).toMatchObject({ saved: true });

    const read = await executeNotesTool("read_project_notes", { limit: 10 }, "p1");
    const notes = (read.result as { notes: { source: string; note: string }[] }).notes;
    expect(notes.map((n) => n.note)).toEqual(["agent learned a fact", "earlier decision"]);
    expect(notes[0].source).toBe("agent");
    await expect(executeNotesTool("bogus", {}, "p1")).rejects.toThrow(/Unknown notes tool/);
  });

  it("withNotesTools merges defs and routes execution, falling through to the base", async () => {
    const baseExecute = vi.fn(async () => ({ result: { ok: true } }));
    const base = { defs: [{ name: "fake_tool", description: "x", parameters: {} }], execute: baseExecute };
    const merged = withNotesTools(base, "p1");

    expect(merged.defs.map((d) => d.name)).toEqual(["fake_tool", "read_project_notes", "append_project_note"]);
    const ctx = { clientId: "t", emit: () => {} } as unknown as ToolContext;
    await merged.execute("append_project_note", { note: "hello" }, ctx, "id1");
    expect(listNotes("p1")).toHaveLength(1);
    await merged.execute("fake_tool", { a: 1 }, ctx, "id2");
    expect(baseExecute).toHaveBeenCalledWith("fake_tool", { a: 1 }, ctx, "id2");

    // Idempotent: merging twice never duplicates the tools.
    expect(withNotesTools(merged, "p1")).toBe(merged);
  });

  it("exposes stable definitions for other toolsets", () => {
    const defs = notesToolDefs("p1");
    expect(defs.map((d) => d.name)).toEqual(["read_project_notes", "append_project_note"]);
    expect(defs[1].description).toMatch(/durable/i);
  });
});
