import type { NextRequest } from "next/server";
import { cancelJob, promoteQueued } from "@/lib/comfy/client";
import { jobStatus } from "@/lib/generate-core";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await jobStatus(id));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to read job." }, { status: 502 });
  }
}

/** Cancels one job: interrupts it when running, removes it from ComfyUI's queue when pending. */
export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  try {
    const action = await cancelJob(id);
    return Response.json({ ok: true, action });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel job." }, { status: 502 });
  }
}

/** { action: "front" } re-queues a pending job at the front of the line, keeping its prompt id. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.action !== "front") return Response.json({ error: 'Unknown action. Use { action: "front" }.' }, { status: 400 });
  try {
    const promoted = await promoteQueued(id);
    return Response.json({ ok: promoted, ...(promoted ? {} : { reason: "The job is not waiting in the queue any more." }) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to move job." }, { status: 502 });
  }
}
