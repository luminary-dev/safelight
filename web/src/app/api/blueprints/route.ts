import { computeStatus, getInstalled } from "@/lib/blueprints/gating";
import { getRegistry } from "@/lib/blueprints/registry";
import type { BlueprintListResponse } from "@/lib/blueprints/types";

/** The blueprint registry: every workflow the vendored ComfyUI ships, with readiness gating. */
export async function GET() {
  try {
    const [{ blueprints, failures }, installed] = await Promise.all([getRegistry(), getInstalled()]);
    const body: BlueprintListResponse = {
      online: installed !== null,
      blueprints: blueprints.map(({ spec }) => ({ ...spec, ...computeStatus(spec, installed) })),
      failures,
    };
    return Response.json(body);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load blueprints." }, { status: 502 });
  }
}
