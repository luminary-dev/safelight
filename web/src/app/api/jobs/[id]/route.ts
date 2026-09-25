import type { NextRequest } from "next/server";
import { jobStatus } from "@/lib/generate-core";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await jobStatus(id));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to read job." }, { status: 502 });
  }
}
