import type { NextRequest } from "next/server";
import type { Project } from "@/lib/session-types";
import { listProjects, upsertProject } from "@/lib/sessions-store";

export async function GET() {
  return Response.json({ projects: await listProjects() });
}

/** Creates or replaces a project. The client owns ids. */
export async function POST(request: NextRequest) {
  let body: Project;
  try {
    body = (await request.json()) as Project;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body?.id || typeof body.id !== "string" || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json({ error: "Bad project." }, { status: 400 });
  }
  // created_at is a NOT NULL column — a body that omits it must be a 400/defaulted insert, not a SqliteError 500.
  const createdAt = typeof body.createdAt === "number" && Number.isFinite(body.createdAt) ? body.createdAt : Date.now();
  return Response.json({ project: await upsertProject({ ...body, createdAt, updatedAt: createdAt }) });
}
