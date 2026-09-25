import type { NextRequest } from "next/server";
import type { Session } from "@/lib/session-types";
import { deleteSession, getSession, patchSession } from "@/lib/sessions-store";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/sessions/[id]">) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  return session ? Response.json({ session }) : Response.json({ error: "Not found." }, { status: 404 });
}

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/sessions/[id]">) {
  const { id } = await ctx.params;
  let patch: Partial<Session>;
  try {
    patch = (await request.json()) as Partial<Session>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const session = await patchSession(id, patch);
  return session ? Response.json({ session }) : Response.json({ error: "Not found." }, { status: 404 });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/sessions/[id]">) {
  const { id } = await ctx.params;
  const removed = await deleteSession(id);
  return Response.json({ ok: removed });
}
