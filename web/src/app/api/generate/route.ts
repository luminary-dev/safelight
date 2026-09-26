import type { NextRequest } from "next/server";
import type { GenerateRequest, ImageActionRequest, MaskEditRequest } from "@/lib/comfy/types";
import { imageCapabilities, queueInpaint, queueLocal, queueOutpaint, queueRemoveBackground, queueUpscale, readSidecarForRef, requestFromSidecarRef, runCloud, sanitizeRequest } from "@/lib/generate-core";

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

type Body = Omit<Partial<GenerateRequest>, "mode"> &
  Omit<Partial<ImageActionRequest>, "mode"> &
  Omit<Partial<MaskEditRequest>, "mode"> & { mode?: GenerateRequest["mode"] | ImageActionRequest["mode"] | MaskEditRequest["mode"]; clientId?: string; fromSidecar?: string; vary?: boolean };

/** Gating/user errors read as 400; anything else is the backend failing (502). */
function errorStatus(message: string): number {
  return /needs|installed|requires|not in|empty|pick|unsupported|sidecar|fit|paint|describe|patch/i.test(message) ? 400 : 502;
}

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
      return Response.json({ error: message }, { status: errorStatus(message) });
    }
  }

  // Mask edits: the render settings come from the target image's sidecar (or the body's model fields).
  if (body.mode === "inpaint" || body.mode === "outpaint") {
    try {
      const edit = { ...body, mode: body.mode, image: typeof body.image === "string" ? body.image : "", prompt: String(body.prompt ?? "") };
      const { id, graph, freed, seed, controlNet } = body.mode === "inpaint" ? await queueInpaint(edit, clientId) : await queueOutpaint(edit, clientId);
      return Response.json({ id, seed, graph, state: "queued", controlNet, freedChatModels: freed });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue.";
      return Response.json({ error: message }, { status: errorStatus(message) });
    }
  }

  let req: GenerateRequest;
  try {
    if (typeof body.fromSidecar === "string" && body.fromSidecar) {
      // Recreate/vary: the whole request comes from the image's sidecar.
      req = await requestFromSidecarRef(body.fromSidecar, body.vary === true);
    } else {
      // The action modes were handled above, so what is left is a plain generate body.
      req = sanitizeRequest(body as Partial<GenerateRequest>);
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
    return Response.json({ error: message }, { status: errorStatus(message) });
  }
}
