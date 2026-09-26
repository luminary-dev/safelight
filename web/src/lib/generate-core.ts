import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistory, getQueue, hasNode, listFolder, queuePrompt } from "@/lib/comfy/client";
import { buildGraph, buildRemoveBackgroundGraph, buildUpscaleGraph } from "@/lib/comfy/graph";
import type { GenerateRequest, ImageCapabilities, JobOutput, JobStatus } from "@/lib/comfy/types";
import { unloadOllamaModels } from "@/lib/ollama/client";
import { generateCloudImages } from "@/lib/providers";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { OUTPUT_DIR, parseImageRef, safeJoin } from "@/lib/safelight-files";
import { readSidecar, sidecarForRequest, sidecarToRequest, writeSidecar } from "@/lib/sidecars";

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
  };
}

const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const EXT_BY_MIME: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

// ---------- sidecars ----------

/**
 * Requests for local renders still in flight, so their sidecars can be written when the job
 * completes. Kept on globalThis to survive Next.js dev-mode module reloads.
 */
const pendingSidecars: Map<string, GenerateRequest> = ((globalThis as Record<string, unknown>).__safelightPendingSidecars ??= new Map()) as Map<string, GenerateRequest>;
const PENDING_SIDECAR_CAP = 200;

function rememberPendingSidecar(id: string, req: GenerateRequest) {
  pendingSidecars.set(id, req);
  while (pendingSidecars.size > PENDING_SIDECAR_CAP) {
    const oldest = pendingSidecars.keys().next().value;
    if (oldest === undefined) break;
    pendingSidecars.delete(oldest);
  }
}

/** Writes `<image>.json` beside each output of a finished local render. Never throws. */
async function writeSidecarsForJob(id: string, outputs: JobOutput[]): Promise<void> {
  const req = pendingSidecars.get(id);
  if (!req) return;
  pendingSidecars.delete(id);
  const sidecar = sidecarForRequest(req);
  for (const out of outputs) {
    if ((out.type ?? "output") !== "output") continue;
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

/** Queues a local render on ComfyUI, freeing Ollama's memory first. Returns the prompt id. */
export async function queueLocal(req: GenerateRequest, clientId: string) {
  const graph = buildGraph(req);
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  rememberPendingSidecar(result.prompt_id, req);
  return { id: result.prompt_id, graph, freed };
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
  return { id: result.prompt_id, graph, freed, model };
}

/** What the connected ComfyUI can do for Stage actions right now. */
export async function imageCapabilities(): Promise<ImageCapabilities> {
  try {
    const [upscaleModels, rmbgModels, rmbgNode] = await Promise.all([listFolder("upscale_models"), listFolder("background_removal"), hasNode("RemoveBackground")]);
    return { online: true, upscaleModels, removeBackground: { node: rmbgNode, models: rmbgModels } };
  } catch {
    return { online: false, upscaleModels: [], removeBackground: { node: false, models: [] } };
  }
}

export async function jobStatus(id: string): Promise<JobStatus> {
  const entry = await getHistory(id);
  if (entry) {
    const outputs = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
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
