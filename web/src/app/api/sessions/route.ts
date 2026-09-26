import type { NextRequest } from "next/server";
import type { Session } from "@/lib/session-types";
import { listProjects, listSessions, upsertSession } from "@/lib/sessions-store";

export async function GET() {
  const [sessions, projects] = await Promise.all([listSessions(), listProjects()]);
  return Response.json({ sessions, projects });
}

/** Creates or replaces a whole session. The client owns ids. */
export async function POST(request: NextRequest) {
  let body: Session;
  try {
    body = (await request.json()) as Session;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body?.id || typeof body.id !== "string" || (body.kind !== "chat" && body.kind !== "image" && body.kind !== "code" && body.kind !== "design")) {
    return Response.json({ error: "Bad session." }, { status: 400 });
  }
  if (typeof body.title !== "string") return Response.json({ error: "Bad session." }, { status: 400 });
  // title/created_at are NOT NULL columns — a body that omits them must be a 400, not a SqliteError 500.
  const createdAt = typeof body.createdAt === "number" && Number.isFinite(body.createdAt) ? body.createdAt : Date.now();
  return Response.json({ session: await upsertSession({ ...body, titled: Boolean(body.titled), createdAt, updatedAt: createdAt }) });
}
