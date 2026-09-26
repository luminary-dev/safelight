import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistory, getQueue, hasNode, listFolder, queuePrompt, type HistoryEntry } from "@/lib/comfy/client";
import { buildGraph, buildInpaintGraph, buildOutpaintGraph, buildRemoveBackgroundGraph, buildUpscaleGraph } from "@/lib/comfy/graph";
import type { ControlType, GenerateRequest, ImageCapabilities, JobOutput, JobStatus, MaskEditRequest } from "@/lib/comfy/types";
import { unloadOllamaModels } from "@/lib/ollama/client";
import { randomSeed } from "@/lib/presets";
import { generateCloudImages } from "@/lib/providers";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { OUTPUT_DIR, parseImageRef, safeJoin } from "@/lib/safelight-files";
import { readSidecar, sidecarForAction, sidecarForRequest, sidecarSettings, sidecarToRequest, writeSidecar, type RenderSidecar } from "@/lib/sidecars";

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
}

function clampFloat(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

export function sanitizeRequest(body: Partial<GenerateRequest>): GenerateRequest {
  if (!body.model?.name || !body.model.folder) throw new Error("Pick a model first.");
  return {
    mode: body.mode === "img2img" ? "img2img" : "txt2img",
    model: { name: String(body.model.name), folder: body.model.folder, provider: body.model.provider },
    textEncoders: Array.isArray(body.textEncoders) ? body.textEncoders.filter(Boolean).map(String) : [],
    vae: body.vae ? String(body.vae) : undefined,
    lora: body.lora?.name ? { name: String(body.lora.name), strength: clampFloat(body.lora.strength, -5, 5, 1) } : null,
    prompt: String(body.prompt ?? ""),
    negativePrompt: String(body.negativePrompt ?? ""),
    width: clampInt(body.width, 256, 4096, 1024),
    height: clampInt(body.height, 256, 4096, 1024),
    steps: clampInt(body.steps, 1, 150, 25),
    cfg: clampFloat(body.cfg, 0, 30, 1),
    seed: clampInt(body.seed, 0, Number.MAX_SAFE_INTEGER, 0),
    sampler: String(body.sampler ?? "euler"),
    scheduler: String(body.scheduler ?? "simple"),
    batch: clampInt(body.batch, 1, 8, 1),
    denoise: clampFloat(body.denoise, 0, 1, 0.75),
    images: Array.isArray(body.images) ? body.images.filter(Boolean).map(String).slice(0, 16) : [],
    refResolution: clampInt(body.refResolution, 0, 4096, 1024),
    matchInputSize: body.matchInputSize !== false,
    control: sanitizeControl(body.control),
  };
}

const CONTROL_TYPES: ControlType[] = ["canny", "depth", "pose"];

function sanitizeControl(control: GenerateRequest["control"]): GenerateRequest["control"] {
  if (!control || !CONTROL_TYPES.includes(control.type)) return null;
  return {
    type: control.type,
    strength: clampFloat(control.strength, 0, 2, 1),
    patch: control.patch ? String(control.patch) : undefined,
    cannyLow: clampFloat(control.cannyLow, 0, 0.99, 0.3),
    cannyHigh: clampFloat(control.cannyHigh, 0.01, 1, 0.4),
  };
}

const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const EXT_BY_MIME: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

// ---------- sidecars ----------

/**
 * Sidecar documents for local jobs still in flight, written beside the outputs when the job
 * completes. Kept on globalThis to survive Next.js dev-mode module reloads.
 */
const pendingSidecars: Map<string, RenderSidecar> = ((globalThis as Record<string, unknown>).__safelightPendingSidecarDocs ??= new Map()) as Map<string, RenderSidecar>;
const PENDING_SIDECAR_CAP = 200;

function rememberPendingSidecar(id: string, sidecar: RenderSidecar) {
  pendingSidecars.set(id, sidecar);
  while (pendingSidecars.size > PENDING_SIDECAR_CAP) {
    const oldest = pendingSidecars.keys().next().value;
    if (oldest === undefined) break;
    pendingSidecars.delete(oldest);
  }
}

/** Writes `<image>.json` beside each output of a finished local render. Never throws. */
async function writeSidecarsForJob(id: string, outputs: JobOutput[]): Promise<void> {
  const sidecar = pendingSidecars.get(id);
  if (!sidecar) return;
  pendingSidecars.delete(id);
  for (const out of outputs) {
    if ((out.type ?? "output") !== "output" || (out.kind ?? "image") !== "image") continue;
    const full = safeJoin(OUTPUT_DIR, out.subfolder, out.filename);
    if (full) await writeSidecar(full, sidecar);
    else console.warn(`[sidecar] refusing to write outside the output folder: ${out.subfolder}/${out.filename}`);
  }
}

/** Resolves an image reference ("safelight/x.png [output]") to its absolute path and reads the sidecar. */
export async function readSidecarForRef(ref: string) {
  const { dir, subfolder, filename } = parseImageRef(ref);
  const full = safeJoin(dir, subfolder, filename);
  if (!full) throw new Error(`Bad image reference: ${ref}`);
  return readSidecar(full);
}

/** Rebuilds a full generate request from an image's sidecar. `vary` swaps in a fresh random seed. */
export async function requestFromSidecarRef(ref: string, vary: boolean): Promise<GenerateRequest> {
  const sidecar = await readSidecarForRef(ref);
  if (!sidecar) throw new Error("This image has no render settings sidecar (missing or unreadable .json), so it cannot be recreated.");
  return sanitizeRequest(sidecarToRequest(sidecar, vary));
}

export async function runCloud(req: GenerateRequest): Promise<JobOutput[]> {
  const provider = req.model.provider;
  if (!provider || !PROVIDERS.includes(provider as ProviderId)) throw new Error("This cloud model has no provider.");
  if (!req.prompt.trim()) throw new Error("Prompt is empty.");

  const images = await Promise.all(
    (req.mode === "img2img" ? req.images : []).map(async (ref) => {
      const { dir, subfolder, filename } = parseImageRef(ref);
      const full = safeJoin(dir, subfolder, filename);
      if (!full) throw new Error(`Bad input reference: ${ref}`);
      const bytes = await readFile(full);
      return { bytes: new Uint8Array(bytes), mime: MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "image/png", name: filename };
    }),
  );

  const generated = await generateCloudImages(provider as ProviderId, req.model.name, {
    prompt: req.prompt,
    width: req.width,
    height: req.height,
    count: req.batch,
    images,
  });
  if (generated.length === 0) throw new Error("The provider returned no images.");

  const dir = path.join(OUTPUT_DIR, "cloud");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputs: JobOutput[] = [];
  const sidecar = sidecarForRequest(req);
  for (const [i, img] of generated.entries()) {
    const filename = `${provider}_${stamp}_${i + 1}${EXT_BY_MIME[img.mime] ?? ".png"}`;
    const full = path.join(dir, filename);
    await writeFile(full, Buffer.from(img.bytes));
    await writeSidecar(full, sidecar); // never throws; a failed sidecar must not fail the render
    outputs.push({ filename, subfolder: "cloud", type: "output" });
  }
  return outputs;
}

/** The exact file the ControlNet UI/errors tell the user to fetch. */
const CONTROL_PATCH_HINT = 'Download "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" into ComfyUI\'s "model_patches" folder (the model manager can fetch it).';

/** Picks the installed control patch that fits the selected model, or explains what to fetch. */
function resolveControlPatch(modelName: string, patches: string[]): string {
  const isZ = /z[-_]?image/i.test(modelName);
  const fits = (p: string) => (isZ ? /z[-_]?image/i.test(p) : /qwen/i.test(p) && !/z[-_]?image/i.test(p));
  const match = patches.find((p) => /controlnet|control[-_ ]?net|control/i.test(p) && fits(p)) ?? patches.find(fits);
  if (match) return match;
  if (patches.length > 0) {
    throw new Error(`None of the installed control patches (${patches.join(", ")}) fit "${modelName}". ${CONTROL_PATCH_HINT}`);
  }
  throw new Error(`No ControlNet patch is installed. ${CONTROL_PATCH_HINT}`);
}

/** Gates a ControlNet request on the node and a fitting patch file being present. */
async function gateControl(req: GenerateRequest): Promise<GenerateRequest> {
  if (!req.control || req.mode !== "img2img") return req;
  const [node, patches] = await Promise.all([hasNode("QwenImageDiffsynthControlnet"), listFolder("model_patches")]);
  if (!node) throw new Error("ControlNet requires the QwenImageDiffsynthControlnet node — update the local ComfyUI.");
  const patch = req.control.patch && patches.includes(req.control.patch) ? req.control.patch : resolveControlPatch(req.model.name, patches);
  return { ...req, control: { ...req.control, patch } };
}

/** Queues a local render on ComfyUI, freeing Ollama's memory first. Returns the prompt id. */
export async function queueLocal(req: GenerateRequest, clientId: string) {
  req = await gateControl(req);
  const graph = buildGraph(req);
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, sidecarForRequest(req));
  return { id: result.prompt_id, graph, freed };
}

/** A mask-edit request that may also carry explicit render settings (model, steps, …). */
export type MaskEditBody = Omit<Partial<GenerateRequest>, "mode"> & MaskEditRequest;

/** The mask edit base: the target image's sidecar settings, unless the body names a model itself. */
async function maskEditBase(body: MaskEditBody): Promise<GenerateRequest> {
  if (!body.image) throw new Error(`${body.mode === "outpaint" ? "Outpainting" : "Inpainting"} needs the image to edit.`);
  let settings: Partial<GenerateRequest>;
  if (body.model?.name) {
    const rest: Omit<MaskEditBody, "mode"> & { mode?: undefined } = { ...body, mode: undefined };
    settings = rest;
  } else {
    const sidecar = await readSidecarForRef(body.image);
    if (!sidecar) throw new Error("This image has no render settings sidecar, so Safelight cannot tell which model to edit it with. Render it in Safelight first, or generate with a model selected.");
    settings = sidecarSettings(sidecar);
  }
  return sanitizeRequest({
    ...settings,
    mode: "img2img",
    images: [body.image],
    prompt: String(body.prompt ?? ""),
    negativePrompt: typeof body.negativePrompt === "string" ? body.negativePrompt : (settings.negativePrompt ?? ""),
    seed: randomSeed(),
    denoise: typeof body.denoise === "number" ? body.denoise : 1,
    control: null,
  });
}

/** The installed inpainting ControlNets (an optional quality boost for inpaint/outpaint). */
async function installedInpaintControlNets(): Promise<string[]> {
  const files = await listFolder("controlnet");
  return files.filter((f) => /inpaint/i.test(f));
}

const clampMaskPx = (n: unknown, fallback: number) => clampInt(n, 0, 256, fallback);

/** Queues a mask-brush inpaint. Model settings come from the image's sidecar (or the body). */
export async function queueInpaint(body: MaskEditBody, clientId: string) {
  const req = await maskEditBase(body);
  const mask = typeof body.mask === "string" ? body.mask : "";
  const [controlNet] = await installedInpaintControlNets();
  const graph = buildInpaintGraph(req, { mask, maskExpand: clampMaskPx(body.maskExpand, 0), maskBlur: clampMaskPx(body.maskBlur, 8), controlNet });
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, sidecarForRequest(req, undefined, { mode: "inpaint", mask }));
  return { id: result.prompt_id, graph, freed, seed: req.seed, controlNet: controlNet ?? null };
}

/** Queues a direction/percent outpaint. Model settings come from the image's sidecar (or the body). */
export async function queueOutpaint(body: MaskEditBody, clientId: string) {
  const req = await maskEditBase(body);
  const pad = (n: unknown) => clampInt(n, 0, 2048, 0);
  const [controlNet] = await installedInpaintControlNets();
  const graph = buildOutpaintGraph(req, {
    left: pad(body.left),
    top: pad(body.top),
    right: pad(body.right),
    bottom: pad(body.bottom),
    feathering: clampInt(body.feathering, 0, 512, 24),
    controlNet,
  });
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, sidecarForRequest(req, undefined, { mode: "outpaint" }));
  return { id: result.prompt_id, graph, freed, seed: req.seed, controlNet: controlNet ?? null };
}

/** Queues an ESRGAN-style model upscale of one image. Errors clearly when no upscale model is installed. */
export async function queueUpscale(opts: { image: string; upscaleModel?: string }, clientId: string) {
  if (!opts.image) throw new Error("Upscale needs an input image.");
  const models = await listFolder("upscale_models");
  if (models.length === 0) throw new Error('No upscale model is installed. Put an ESRGAN model file in ComfyUI\'s "upscale_models" models folder.');
  const model = opts.upscaleModel ?? models[0];
  if (!models.includes(model)) throw new Error(`"${model}" is not in ComfyUI's "upscale_models" folder.`);
  const graph = buildUpscaleGraph({ image: opts.image, upscaleModel: model });
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, sidecarForAction("upscale", { image: opts.image, model, folder: "upscale_models" }));
  return { id: result.prompt_id, graph, freed, model };
}

/** Queues BiRefNet background removal for one image, gated on the node and a model file being present. */
export async function queueRemoveBackground(opts: { image: string; model?: string }, clientId: string) {
  if (!opts.image) throw new Error("Background removal needs an input image.");
  const [loader, remover] = await Promise.all([hasNode("LoadBackgroundRemovalModel"), hasNode("RemoveBackground")]);
  if (!loader || !remover) throw new Error("Background removal requires the BiRefNet custom node (RemoveBackground) in ComfyUI.");
  const models = await listFolder("background_removal");
  if (models.length === 0) throw new Error('No background-removal model is installed. Put birefnet.safetensors in ComfyUI\'s "background_removal" models folder.');
  const model = opts.model && models.includes(opts.model) ? opts.model : (models.find((m) => /birefnet/i.test(m)) ?? models[0]);
  const graph = buildRemoveBackgroundGraph({ image: opts.image, model });
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, sidecarForAction("rmbg", { image: opts.image, model, folder: "background_removal" }));
  return { id: result.prompt_id, graph, freed, model };
}

/** What the connected ComfyUI can do for Stage actions right now. */
export async function imageCapabilities(): Promise<ImageCapabilities> {
  try {
    const [upscaleModels, rmbgModels, rmbgNode, inpaintControlNets, controlNode, controlPatches] = await Promise.all([
      listFolder("upscale_models"),
      listFolder("background_removal"),
      hasNode("RemoveBackground"),
      installedInpaintControlNets(),
      hasNode("QwenImageDiffsynthControlnet"),
      listFolder("model_patches"),
    ]);
    return {
      online: true,
      upscaleModels,
      removeBackground: { node: rmbgNode, models: rmbgModels },
      inpaint: { controlNets: inpaintControlNets },
      controlnet: { node: controlNode, patches: controlPatches },
    };
  } catch {
    return { online: false, upscaleModels: [], removeBackground: { node: false, models: [] }, inpaint: { controlNets: [] }, controlnet: { node: false, patches: [] } };
  }
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|gif)$/i;
const AUDIO_EXT = /\.(flac|mp3|wav|ogg|opus|m4a|aac)$/i;

function outputKind(key: string, filename: string, animated: boolean): NonNullable<JobOutput["kind"]> {
  if (key === "audio" || AUDIO_EXT.test(filename)) return "audio";
  if (key === "gifs" || key === "videos" || animated || VIDEO_EXT.test(filename)) return "video";
  return "image";
}

/**
 * Collects every output-bearing key from a ComfyUI history entry: SaveImage/SaveVideo report
 * under `images` (videos also set `animated`), SaveAudio* under `audio`, and VHS-style custom
 * nodes under `gifs`/`videos`. Each output is tagged with its kind (image is the default).
 */
export function collectOutputs(outputs: HistoryEntry["outputs"] | undefined): JobOutput[] {
  const collected: JobOutput[] = [];
  for (const node of Object.values(outputs ?? {})) {
    // `animated` is a single-element tuple flagging the whole images list (SaveVideo, animated WEBP).
    const animated = Array.isArray(node.animated) && node.animated.some(Boolean);
    for (const key of ["images", "gifs", "videos", "audio"] as const) {
      for (const out of node[key] ?? []) {
        if (!out || typeof out.filename !== "string") continue;
        collected.push({ ...out, kind: outputKind(key, out.filename, key === "images" && animated) });
      }
    }
  }
  return collected;
}

export async function jobStatus(id: string): Promise<JobStatus> {
  const entry = await getHistory(id);
  if (entry) {
    const outputs = collectOutputs(entry.outputs);
    const failed = entry.status?.status_str === "error";
    let error: string | undefined;
    if (failed) {
      const msg = entry.status?.messages.find(([type]) => type === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
      error = msg?.exception_message ? `${msg.node_type ?? "Node"}: ${msg.exception_message}` : "Generation failed.";
      pendingSidecars.delete(id);
    } else {
      await writeSidecarsForJob(id, outputs);
    }
    return { id, state: failed ? "error" : "done", outputs, error };
  }
  const queue = await getQueue();
  const running = queue.queue_running.some(([, pid]) => pid === id);
  const pending = queue.queue_pending.some(([, pid]) => pid === id);
  const status: JobStatus = { id, state: running ? "running" : pending ? "queued" : "error", outputs: [] };
  if (status.state === "error") {
    status.error = "Job vanished from the queue. It may have been cancelled.";
    pendingSidecars.delete(id);
  }
  return status;
}

/** Polls a ComfyUI job until it finishes. Used by the agent, which needs the result before it can continue. */
export async function waitForJob(id: string, opts: { timeoutMs?: number; onTick?: (s: JobStatus, elapsedMs: number) => void; signal?: AbortSignal } = {}): Promise<JobStatus> {
  const start = Date.now();
  const timeout = opts.timeoutMs ?? 25 * 60 * 1000;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    const s = await jobStatus(id);
    opts.onTick?.(s, Date.now() - start);
    if (s.state === "done" || s.state === "error") return s;
    if (Date.now() - start > timeout) return { id, state: "error", outputs: [], error: "Timed out waiting for the render." };
    await new Promise((r) => setTimeout(r, 2000));
  }
}
