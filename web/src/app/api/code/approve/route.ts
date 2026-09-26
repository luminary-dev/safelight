import type { NextRequest } from "next/server";
import { resolveApproval } from "@/lib/agent/approvals";

/** Resolves a pending path-access question raised by a running coding agent. */
export async function POST(request: NextRequest) {
  let body: { id?: string; allow?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.id) return Response.json({ error: "Missing approval id." }, { status: 400 });
  const found = resolveApproval(body.id, body.allow === true);
  return Response.json({ ok: found });
}
