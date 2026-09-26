import type { NextRequest } from "next/server";
import { getRun } from "@/lib/agent/runs-store";

/** One persisted run with its ordered events — what a reload-restore consumes. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const found = getRun(id);
  return found ? Response.json(found) : Response.json({ error: "Not found." }, { status: 404 });
}
