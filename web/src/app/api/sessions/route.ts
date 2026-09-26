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
  if (!body?.id || (body.kind !== "chat" && body.kind !== "image" && body.kind !== "code" && body.kind !== "design")) return Response.json({ error: "Bad session." }, { status: 400 });
  return Response.json({ session: await upsertSession(body) });
}
