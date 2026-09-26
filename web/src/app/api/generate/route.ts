import type { NextRequest } from "next/server";
import type { GenerateRequest, ImageActionRequest, MaskEditRequest } from "@/lib/comfy/types";
import {
  estimateLocalFootprint,
  imageCapabilities,
  queueInpaint,
  queueLocal,
  queueOutpaint,
  queueRemoveBackground,
  queueUpscale,
  readSidecarForRef,
  requestFromSidecarRef,
  runCloud,
  sanitizeRequest,
  sanitizeSweep,
  sweepPoints,
  type FootprintEstimate,
} from "@/lib/generate-core";
import { expandPromptText } from "@/lib/prompts";
import { cancelJob } from "@/lib/comfy/client";

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
  Omit<Partial<MaskEditRequest>, "mode"> & {
    mode?: GenerateRequest["mode"] | ImageActionRequest["mode"] | MaskEditRequest["mode"];
    clientId?: string;
    fromSidecar?: string;
    vary?: boolean;
    /** Seed or parameter sweep: queue one job per point. */
    sweep?: unknown;
    /** Dry run: return the memory footprint estimate without queueing anything. */
    preflight?: boolean;
  };

/** Gating/user errors read as 400; anything else is the backend failing (502). */
function errorStatus(message: string): number {
  return /needs|installed|requires|not in|empty|pick|unsupported|sidecar|fit|paint|describe|patch|sweep/i.test(message) ? 400 : 502;
}

/**
 * Expands `{a|b}` and `__title__` wildcards in the prompt and negative,
 * seeded by this job's seed so a locked seed reproduces the expansion and
 * every sweep point expands independently.
 */
function withWildcards(req: GenerateRequest): GenerateRequest {
  return {
    ...req,
    prompt: expandPromptText(req.prompt, req.seed),
    // A different stream for the negative, so it does not mirror the prompt's picks.
    negativePrompt: expandPromptText(req.negativePrompt, req.seed ^ 0x5f356495),
  };
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

  const fromSidecar = typeof body.fromSidecar === "string" && body.fromSidecar;
  let req: GenerateRequest;
  try {
    if (fromSidecar) {
      // Recreate/vary: the whole request comes from the image's sidecar.
      req = await requestFromSidecarRef(body.fromSidecar as string, body.vary === true);
    } else {
      // The action modes were handled above, so what is left is a plain generate body.
      req = sanitizeRequest(body as Partial<GenerateRequest>);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request.";
    return Response.json({ error: message }, { status: /no render settings sidecar/i.test(message) ? 404 : 400 });
  }

  // Preflight (§O memory manager): the footprint estimate for these settings, nothing queued.
  if (body.preflight === true) {
    if (req.model.folder === "cloud") {
      return Response.json({ preflight: true, willSwap: false, warning: null });
    }
    try {
      const estimate = await estimateLocalFootprint(req);
      return Response.json({ preflight: true, ...estimate });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "ComfyUI did not answer the memory probe." }, { status: 502 });
    }
  }

  if (req.model.folder === "cloud") {
    if (body.sweep !== undefined) return Response.json({ error: "Sweeps run on local models only." }, { status: 400 });
    try {
      const outputs = await runCloud(fromSidecar ? req : withWildcards(req));
      return Response.json({ id: `cloud-${crypto.randomUUID()}`, seed: req.seed, outputs, state: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cloud generation failed.";
      return Response.json({ error: message }, { status: /empty|no provider|no .* key|bad input/i.test(message) ? 400 : 502 });
    }
  }

  // The swap guard never blocks a render: estimate, queue anyway, and warn in the response.
  const estimate: FootprintEstimate | null = await estimateLocalFootprint(req).catch(() => null);
  const warning = estimate?.warning ? { warning: estimate.warning } : {};

  // Sweeps: one job per point, all sharing a group id recorded in each sidecar.
  if (body.sweep !== undefined) {
    if (req.mode !== "txt2img") return Response.json({ error: "Sweeps are for txt2img renders." }, { status: 400 });
    let points;
    try {
      points = sweepPoints(req, sanitizeSweep(body.sweep));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Bad sweep." }, { status: 400 });
    }
    const group = crypto.randomUUID();
    const kind = (body.sweep as { kind: string }).kind;
    const queued: { id: string; seed: number; value: number; label: string }[] = [];
    try {
      for (const p of points) {
        // Wildcards expand per job, so `{a|b}` varies across a seed sweep.
        const jobReq = withWildcards(p.req);
        const { id } = await queueLocal(jobReq, clientId, { sidecarExtra: { sweep: { group, kind, value: p.value } } });
        queued.push({ id, seed: jobReq.seed, value: p.value, label: p.label });
      }
    } catch (err) {
      // Half a grid helps nobody: withdraw what was queued and report the failure.
      await Promise.all(queued.map((q) => cancelJob(q.id).catch(() => undefined)));
      const message = err instanceof Error ? err.message : "Failed to queue the sweep.";
      return Response.json({ error: message }, { status: errorStatus(message) });
    }
    return Response.json({ group, ids: queued.map((q) => q.id), points: queued, seed: req.seed, state: "queued", ...warning });
  }

  try {
    const { id, graph, freed } = await queueLocal(fromSidecar ? req : withWildcards(req), clientId);
    return Response.json({ id, seed: req.seed, graph, state: "queued", freedChatModels: freed, ...warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue generation.";
    return Response.json({ error: message }, { status: errorStatus(message) });
  }
}
