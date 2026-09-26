import type { NextRequest } from "next/server";
import { computeStatus, getInstalled } from "@/lib/blueprints/gating";
import { getBlueprint } from "@/lib/blueprints/registry";

/** Full input spec for one blueprint, so a form can be rendered for it. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const parsed = await getBlueprint(id);
    if (!parsed) return Response.json({ error: `No blueprint named "${id}".` }, { status: 404 });
    const installed = await getInstalled();
    return Response.json({ ...parsed.spec, ...computeStatus(parsed.spec, installed), online: installed !== null });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load the blueprint." }, { status: 502 });
  }
}
