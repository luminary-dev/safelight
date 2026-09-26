import type { NextRequest } from "next/server";
import type { Project } from "@/lib/session-types";
import { deleteProject, patchProject } from "@/lib/sessions-store";

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  let patch: Partial<Project>;
  try {
    patch = (await request.json()) as Partial<Project>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return Response.json({ error: "Bad patch." }, { status: 400 });
  if ("title" in patch && (typeof patch.title !== "string" || !patch.title.trim())) return Response.json({ error: "Bad patch." }, { status: 400 });
  const project = await patchProject(id, patch);
  return project ? Response.json({ project }) : Response.json({ error: "Not found." }, { status: 404 });
}

/** Deletes the project; its sessions are kept and become unfiled. */
export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  const removed = await deleteProject(id);
  return Response.json({ ok: removed });
}
