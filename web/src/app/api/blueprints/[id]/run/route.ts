import type { NextRequest } from "next/server";
import { computeStatus, getInstalled } from "@/lib/blueprints/gating";
import { applyInputs } from "@/lib/blueprints/parse";
import { getBlueprint } from "@/lib/blueprints/registry";
import type { BlueprintRunRequest } from "@/lib/blueprints/types";
import { queuePrompt } from "@/lib/comfy/client";
import { unloadOllamaModels } from "@/lib/ollama/client";

/**
 * Patches the user's values onto the blueprint graph and queues it on ComfyUI. Returns the
 * prompt id, which the existing /api/jobs/[id] flow tracks like any other render.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: BlueprintRunRequest;
  try {
    body = (await request.json()) as BlueprintRunRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const parsed = await getBlueprint(id);
    if (!parsed) return Response.json({ error: `No blueprint named "${id}".` }, { status: 404 });

    const installed = await getInstalled();
    if (!installed) return Response.json({ error: "ComfyUI is offline; blueprints need the local backend." }, { status: 502 });
    const gate = computeStatus(parsed.spec, installed);
    if (gate.status !== "ready") {
      const parts = [
        gate.missingNodeClasses.length ? `node classes: ${gate.missingNodeClasses.join(", ")}` : "",
        gate.missingModels.length ? `models: ${gate.missingModels.join(", ")}` : "",
      ].filter(Boolean);
      return Response.json(
        { error: `"${parsed.spec.name}" is missing ${parts.join(" and ")}.`, missingNodeClasses: gate.missingNodeClasses, missingModels: gate.missingModels },
        { status: 409 },
      );
    }

    let graph;
    try {
      graph = applyInputs(parsed, body.values ?? {});
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Bad input values." }, { status: 400 });
    }

    // Video and audio graphs need every byte of VRAM; drop any resident chat models first.
    const freed = await unloadOllamaModels().catch(() => [] as string[]);
    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : "safelight";
    const result = await queuePrompt(graph, clientId);
    return Response.json({ id: result.prompt_id, state: "queued", blueprint: parsed.spec.id, freedChatModels: freed });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to queue the blueprint." }, { status: 502 });
  }
}
