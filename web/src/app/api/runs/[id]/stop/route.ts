import type { NextRequest } from "next/server";
import { stopRun } from "@/lib/agent/run-registry";

/**
 * Explicitly cancels a detached run via the registry's own controller — the
 * only thing that actually stops a run (closing the NDJSON view never does).
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const outcome = stopRun(id);
  if (outcome === "unknown") return Response.json({ error: "No such run." }, { status: 404 });
  return Response.json({ ok: true, alreadyFinished: outcome === "finished" });
}
