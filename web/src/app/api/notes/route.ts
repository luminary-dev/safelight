import type { NextRequest } from "next/server";
import { appendNote, deleteNote, listNotes } from "@/lib/agent/project-notes";

/**
 * Per-project agent memory, user-visible and user-editable:
 *   GET    /api/notes?projectId=…&limit=…  → { notes } newest first
 *   POST   /api/notes?projectId=…          body { note } → saved with source 'user'
 *   DELETE /api/notes?id=…                 → removes one note
 */

function projectIdOf(request: NextRequest): string {
  return new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
}

export async function GET(request: NextRequest) {
  const projectId = projectIdOf(request);
  if (!projectId) return Response.json({ error: "projectId is required." }, { status: 400 });
  const raw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? raw : undefined;
  return Response.json({ notes: listNotes(projectId, limit) });
}

export async function POST(request: NextRequest) {
  const projectId = projectIdOf(request);
  if (!projectId) return Response.json({ error: "projectId is required." }, { status: 400 });
  let body: { note?: unknown };
  try {
    body = (await request.json()) as { note?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return Response.json({ error: "A note needs some text." }, { status: 400 });
  return Response.json({ note: appendNote(projectId, note, "user") });
}

export async function DELETE(request: NextRequest) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Pass the id of the note to delete." }, { status: 400 });
  if (!deleteNote(id)) return Response.json({ error: "No such note." }, { status: 404 });
  return Response.json({ ok: true });
}
