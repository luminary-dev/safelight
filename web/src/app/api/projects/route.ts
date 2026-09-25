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
  if (!body?.id || !body.title?.trim()) return Response.json({ error: "Bad project." }, { status: 400 });
  return Response.json({ project: await upsertProject(body) });
}
