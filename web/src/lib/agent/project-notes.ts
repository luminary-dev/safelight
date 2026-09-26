import "server-only";
import { getDb } from "@/lib/db";
import type { ToolContext, ToolDef } from "./tools";

/**
 * Per-project agent memory (migration 6): explicit, user-visible notes the agent
 * reads and appends to, so long projects do not restart cold. Notes are plain
 * rows — nothing is summarized or rewritten silently — and the /api/notes route
 * exposes the same store to the UI.
 */

export type NoteSource = "agent" | "user";

export interface ProjectNote {
  id: number;
  projectId: string;
  ts: number;
  source: NoteSource;
  note: string;
}

export const MAX_NOTES_PER_PROJECT = 500;
export const DEFAULT_NOTES_LIMIT = 50;
/** Longer notes are clipped; memory is for durable facts, not transcripts. */
const MAX_NOTE_LENGTH = 4000;

export const NOTES_TOOL_NAMES: readonly string[] = ["read_project_notes", "append_project_note"];

interface Row {
  id: number;
  project_id: string;
  ts: number;
  source: string;
  note: string;
}

function toNote(r: Row): ProjectNote {
  return { id: r.id, projectId: r.project_id, ts: r.ts, source: r.source === "user" ? "user" : "agent", note: r.note };
}

/** The newest `limit` notes for a project, newest first. */
export function listNotes(projectId: string, limit = DEFAULT_NOTES_LIMIT): ProjectNote[] {
  const n = Math.max(1, Math.min(MAX_NOTES_PER_PROJECT, Math.floor(limit) || DEFAULT_NOTES_LIMIT));
  const rows = getDb()
    .prepare("SELECT id, project_id, ts, source, note FROM project_notes WHERE project_id = ? ORDER BY ts DESC, id DESC LIMIT ?")
    .all(projectId, n) as Row[];
  return rows.map(toNote);
}

/** Appends one note and prunes the project back to the newest MAX_NOTES_PER_PROJECT. */
export function appendNote(projectId: string, note: string, source: NoteSource = "agent"): ProjectNote {
  const pid = projectId.trim();
  const text = note.trim().slice(0, MAX_NOTE_LENGTH);
  if (!pid) throw new Error("appendNote needs a project id.");
  if (!text) throw new Error("A note needs some text.");
  const db = getDb();
  const ts = Date.now();
  const write = db.transaction((): number => {
    const r = db.prepare("INSERT INTO project_notes (project_id, ts, source, note) VALUES (?, ?, ?, ?)").run(pid, ts, source, text);
    db.prepare(
      "DELETE FROM project_notes WHERE project_id = ? AND id NOT IN (SELECT id FROM project_notes WHERE project_id = ? ORDER BY ts DESC, id DESC LIMIT ?)",
    ).run(pid, pid, MAX_NOTES_PER_PROJECT);
    return Number(r.lastInsertRowid);
  });
  return { id: write(), projectId: pid, ts, source, note: text };
}

/** Removes one note by id; false when it does not exist. */
export function deleteNote(id: number): boolean {
  return getDb().prepare("DELETE FROM project_notes WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Agent tools

/** Tool definitions for the project-notes pair; offered whenever a run carries a projectId. */
export function notesToolDefs(projectId: string): ToolDef[] {
  void projectId; // the id is bound at execute time; defs are identical across projects
  return [
    {
      name: "read_project_notes",
      description:
        "Read this project's saved notes — durable facts, decisions and preferences recorded in earlier sessions, newest first. Check them before assuming a long-running project starts cold.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "How many notes. Default 50." } },
        additionalProperties: false,
      },
    },
    {
      name: "append_project_note",
      description:
        "Save one durable note to this project's memory: a fact, decision, preference or constraint worth keeping for future sessions (for example 'Client approved the lime palette for the hero'). Notes are visible to the user. Do not record chit-chat, transient status, or things already noted.",
      parameters: {
        type: "object",
        properties: { note: { type: "string", description: "One concise, self-contained note." } },
        required: ["note"],
        additionalProperties: false,
      },
    },
  ];
}

/** Executes one of the notes tools against the given project. */
export async function executeNotesTool(name: string, rawArgs: Record<string, unknown>, projectId: string): Promise<{ result: unknown; note?: string }> {
  switch (name) {
    case "read_project_notes": {
      const limit = typeof rawArgs.limit === "number" ? Math.min(100, Math.max(1, Math.floor(rawArgs.limit))) : DEFAULT_NOTES_LIMIT;
      const notes = listNotes(projectId, limit);
      return { result: { notes: notes.map((n) => ({ id: n.id, when: new Date(n.ts).toISOString(), source: n.source, note: n.note })) } };
    }
    case "append_project_note": {
      const saved = appendNote(projectId, String(rawArgs.note ?? ""), "agent");
      return { result: { saved: true, id: saved.id }, note: "Noted" };
    }
    default:
      throw new Error(`Unknown notes tool: ${name}`);
  }
}

type Toolset = NonNullable<ToolContext["toolset"]>;

/**
 * Appends the notes tools to any toolset (default or override), the same way MCP
 * merges: extra defs plus an execute that handles its own names and falls through
 * to the base for everything else. A no-op when the names are already present.
 */
export function withNotesTools(base: Toolset, projectId: string): Toolset {
  if (base.defs.some((d) => NOTES_TOOL_NAMES.includes(d.name))) return base;
  return {
    defs: [...base.defs, ...notesToolDefs(projectId)],
    execute: (name, args, ctx, id) => (NOTES_TOOL_NAMES.includes(name) ? executeNotesTool(name, args, projectId) : base.execute(name, args, ctx, id)),
  };
}
