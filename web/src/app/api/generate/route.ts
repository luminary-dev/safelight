import type { NextRequest } from "next/server";
import type { GenerateRequest, ImageActionRequest } from "@/lib/comfy/types";
import { imageCapabilities, queueLocal, queueRemoveBackground, queueUpscale, readSidecarForRef, requestFromSidecarRef, runCloud, sanitizeRequest } from "@/lib/generate-core";

/**
 * GET: capability probe for Stage actions, or `?sidecar=<image ref>` to read a
 * render's metadata sidecar ({ sidecar: null } when absent or unreadable).
 */
export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("sidecar");
  if (ref !== null) {
    try {
      return Response.json({ sidecar: await readSidecarForRef(ref) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Bad image reference." }, { status: 400 });
    }
  }
  return Response.json(await imageCapabilities());
}

type Body = Partial<GenerateRequest> & Partial<ImageActionRequest> & { clientId?: string; fromSidecar?: string; vary?: boolean };

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : "safelight";

  // One-click actions run their own small graphs; no prompt or model settings involved.
  if (body.mode === "upscale" || body.mode === "rmbg") {
    try {
      const image = typeof body.image === "string" ? body.image : "";
      const { id, graph, freed, model } =
        body.mode === "upscale"
          ? await queueUpscale({ image, upscaleModel: typeof body.upscaleModel === "string" ? body.upscaleModel : undefined }, clientId)
          : await queueRemoveBackground({ image }, clientId);
      return Response.json({ id, graph, state: "queued", model, freedChatModels: freed });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue.";
      return Response.json({ error: message }, { status: /needs|installed|requires|not in/i.test(message) ? 400 : 502 });
    }
  }

  let req: GenerateRequest;
  try {
    if (typeof body.fromSidecar === "string" && body.fromSidecar) {
      // Recreate/vary: the whole request comes from the image's sidecar.
      req = await requestFromSidecarRef(body.fromSidecar, body.vary === true);
    } else {
      req = sanitizeRequest(body);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request.";
    return Response.json({ error: message }, { status: /no render settings sidecar/i.test(message) ? 404 : 400 });
  }

  if (req.model.folder === "cloud") {
    try {
      const outputs = await runCloud(req);
      return Response.json({ id: `cloud-${crypto.randomUUID()}`, seed: req.seed, outputs, state: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cloud generation failed.";
      return Response.json({ error: message }, { status: /empty|no provider|no .* key|bad input/i.test(message) ? 400 : 502 });
    }
  }

  try {
    const { id, graph, freed } = await queueLocal(req, clientId);
    return Response.json({ id, seed: req.seed, graph, state: "queued", freedChatModels: freed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue generation.";
    const status = /empty|needs|pick|unsupported/i.test(message) ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}
