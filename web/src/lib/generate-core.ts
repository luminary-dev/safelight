import "server-only";
import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistory, getQueue, hasNode, listFolder, queuePrompt, systemStats, type HistoryEntry } from "@/lib/comfy/client";
import { parseExtraModelPaths } from "@/lib/models/paths";
import { buildGraph, buildInpaintGraph, buildOutpaintGraph, buildRemoveBackgroundGraph, buildUpscaleGraph } from "@/lib/comfy/graph";
import type { ControlType, GenerateRequest, ImageCapabilities, JobOutput, JobStatus, MaskEditRequest } from "@/lib/comfy/types";
import { unloadOllamaModels } from "@/lib/ollama/client";
import { randomSeed } from "@/lib/presets";
import { generateCloudImages } from "@/lib/providers";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { readImageBytesForRef } from "@/lib/input-bytes";
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
      const { bytes, filename } = await readImageBytesForRef(ref);
      return { bytes, mime: MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "image/png", name: filename };
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

/**
 * Queues a local render on ComfyUI, freeing Ollama's memory first. Returns the prompt id.
 * `sidecarExtra` fields are recorded verbatim in the render's metadata sidecar
 * (e.g. sweep group info); readers ignore fields they do not know.
 */
export async function queueLocal(req: GenerateRequest, clientId: string, opts: { sidecarExtra?: Record<string, unknown> } = {}) {
  req = await gateControl(req);
  const graph = buildGraph(req);
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  const sidecar = opts.sidecarExtra ? ({ ...sidecarForRequest(req), ...opts.sidecarExtra } as RenderSidecar) : sidecarForRequest(req);
  rememberPendingSidecar(result.prompt_id, sidecar);
  return { id: result.prompt_id, graph, freed };
}

// ---------- sweeps (seed / parameter grids) ----------

export type SweepSpec = { kind: "seed"; count: number } | { kind: "cfg" | "steps"; values: number[] };

export interface SweepPoint {
  req: GenerateRequest;
  /** The swept value: the seed for seed sweeps, the cfg/steps value otherwise. */
  value: number;
  label: string;
}

/** Validates a sweep request body. Throws a user-readable error on bad shapes. */
export function sanitizeSweep(raw: unknown): SweepSpec {
  if (!raw || typeof raw !== "object") throw new Error("Bad sweep: pass { kind, count | values }.");
  const s = raw as { kind?: unknown; count?: unknown; values?: unknown };
  if (s.kind === "seed") {
    return { kind: "seed", count: clampInt(s.count, 2, 9, 4) };
  }
  if (s.kind === "cfg" || s.kind === "steps") {
    const values = (Array.isArray(s.values) ? s.values : [])
      .map((v) => (typeof v === "string" ? Number(v) : v))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .map((v) => (s.kind === "cfg" ? Math.min(30, Math.max(0, v)) : clampInt(v, 1, 150, 1)))
      .slice(0, 6);
    if (values.length < 2) throw new Error(`A ${s.kind} sweep needs 2 to 6 comma-separated values.`);
    return { kind: s.kind, values };
  }
  throw new Error('Unsupported sweep kind. Use "seed", "cfg" or "steps".');
}

/** Deterministic seed for sweep point `i`: point 0 keeps the base seed so a locked seed stays reproducible. */
export function deriveSweepSeed(base: number, i: number): number {
  if (i === 0) return base;
  return (base + i * 0x9e3779b1) % Number.MAX_SAFE_INTEGER;
}

/**
 * Fans one base request out into per-point requests. Seed sweeps derive each
 * seed from the base; parameter sweeps keep the base seed and vary cfg/steps.
 * Every point renders a single image (batch 1) so the grid maps 1:1 to jobs.
 */
export function sweepPoints(base: GenerateRequest, sweep: SweepSpec): SweepPoint[] {
  if (sweep.kind === "seed") {
    return Array.from({ length: sweep.count }, (_, i) => {
      const seed = deriveSweepSeed(base.seed, i);
      return { req: { ...base, seed, batch: 1 }, value: seed, label: `seed ${seed}` };
    });
  }
  return sweep.values.map((value) => ({
    req: { ...base, [sweep.kind]: value, batch: 1 },
    value,
    label: `${sweep.kind} ${value}`,
  }));
}

// ---------- memory / swap guard (§O: warn before a render that will swap) ----------

const GiB = 1024 ** 3;

/**
 * Where a model folder's files can live on disk. ComfyUI merges several
 * registered paths per folder key (extra_model_paths.yaml plus the vendored
 * models dir), so the estimator checks all of them.
 */
const FOLDER_ALIASES: Record<string, string[]> = {
  unet_gguf: ["unet", "diffusion_models"],
  diffusion_models: ["diffusion_models", "unet"],
  checkpoints: ["checkpoints"],
  text_encoders: ["text_encoders", "clip"],
  vae: ["vae"],
};

let modelDirsCache: Record<string, string[]> | null = null;

/** Every absolute directory that may hold files of a model folder, yaml order first. */
function modelDirsFor(folder: string): string[] {
  if (!modelDirsCache) {
    const repoRoot = path.resolve(process.cwd(), "..");
    const extraFile = process.env.COMFY_EXTRA_MODEL_PATHS ?? path.join(repoRoot, "comfyui", "extra_model_paths.yaml");
    const vendored = path.join(repoRoot, "comfyui", "models");
    let parsed: ReturnType<typeof parseExtraModelPaths> = { map: {} };
    try {
      parsed = parseExtraModelPaths(readFileSync(extraFile, "utf8"));
    } catch {
      /* no extra paths file: only the vendored tree */
    }
    const base = parsed.basePath ?? vendored;
    const dirs: Record<string, string[]> = {};
    for (const [key, subpaths] of Object.entries(parsed.map)) {
      dirs[key] = subpaths.map((s) => path.join(base, s));
    }
    for (const key of new Set(Object.values(FOLDER_ALIASES).flat())) {
      (dirs[key] ??= []).push(path.join(vendored, key));
    }
    modelDirsCache = dirs;
  }
  const keys = FOLDER_ALIASES[folder] ?? [folder];
  return keys.flatMap((k) => modelDirsCache![k] ?? []);
}

/** File size of a model file as ComfyUI names it (may include a subfolder prefix). 0 when not found. */
async function modelFileBytes(folder: string, name: string): Promise<number> {
  for (const dir of modelDirsFor(folder)) {
    try {
      const s = await stat(path.join(dir, name));
      if (s.isFile()) return s.size;
    } catch {
      /* try the next registered path */
    }
  }
  return 0;
}

/**
 * Resolution-dependent activation head-room, calibrated conservatively on this
 * machine (26 GB unified memory): the ~20B Qwen stack (~14.6 GB of weights)
 * starts swapping at ≥896 px (0.8 MP), which puts its activations near 5 GB
 * there. Activations grow super-linearly with pixel count (attention over
 * latent tokens), encoded as MP^1.5, and scale with the size of the weights.
 */
export function activationMarginBytes(width: number, height: number, weightsBytes: number): number {
  const mp = Math.max(0.05, (width * height) / 1e6);
  const weightScale = Math.max(1, weightsBytes / (8 * GiB));
  return Math.round((0.75 + 3.5 * mp ** 1.5 * weightScale) * GiB);
}

export interface FootprintEstimate {
  modelBytes: number;
  textEncoderBytes: number;
  vaeBytes: number;
  marginBytes: number;
  /** modelBytes + textEncoderBytes + vaeBytes + marginBytes. */
  neededBytes: number;
  /** Free unified memory (ComfyUI's ram_free) plus what unloading Ollama's resident models frees. */
  freeBytes: number;
  ollamaResidentBytes: number;
  willSwap: boolean;
  warning: string | null;
}

const fmtGb = (bytes: number) => {
  const gb = bytes / GiB;
  return gb >= 10 ? String(Math.round(gb)) : (Math.round(gb * 10) / 10).toString();
};

/** Largest same-aspect size (multiples of 32) whose estimated footprint still fits, or null. */
function suggestedSize(width: number, height: number, weightsBytes: number, freeBytes: number): string | null {
  const budget = freeBytes - weightsBytes - 0.75 * GiB;
  if (budget <= 0) return null;
  // Invert margin = 0.75 + 3.5 * mp^1.5 * scale (GiB) for the largest mp that fits.
  const weightScale = Math.max(1, weightsBytes / (8 * GiB));
  const mp = (budget / GiB / (3.5 * weightScale)) ** (2 / 3);
  const factor = Math.sqrt((mp * 1e6) / (width * height));
  if (factor >= 1 || factor <= 0.2) return null;
  const round32 = (n: number) => Math.max(256, Math.floor((n * factor) / 32) * 32);
  return `${round32(width)}×${round32(height)}`;
}

/** Pure decision + message, split from the I/O so tests can drive the math directly. */
export function footprintVerdict(
  parts: { modelBytes: number; textEncoderBytes: number; vaeBytes: number; width: number; height: number },
  ramFreeBytes: number,
  ollamaResidentBytes: number,
): FootprintEstimate {
  const weights = parts.modelBytes + parts.textEncoderBytes + parts.vaeBytes;
  const marginBytes = activationMarginBytes(parts.width, parts.height, weights);
  const neededBytes = weights + marginBytes;
  const freeBytes = ramFreeBytes + ollamaResidentBytes;
  // Without the model file on disk there is nothing to estimate; never cry wolf.
  const willSwap = parts.modelBytes > 0 && neededBytes > freeBytes;
  let warning: string | null = null;
  if (willSwap) {
    const smaller = suggestedSize(parts.width, parts.height, weights, freeBytes);
    const freeNote = ollamaResidentBytes > 0 ? ` free (after unloading Ollama's resident chat models, ~${fmtGb(ollamaResidentBytes)} GB of it)` : " free";
    const advice = smaller ? `consider ${smaller} or closing apps` : "consider a smaller size or closing apps";
    warning = `~${fmtGb(neededBytes)} GB needed, ${fmtGb(freeBytes)} GB${freeNote} — this render will likely swap and slow dramatically; ${advice}.`;
  }
  return { modelBytes: parts.modelBytes, textEncoderBytes: parts.textEncoderBytes, vaeBytes: parts.vaeBytes, marginBytes, neededBytes, freeBytes, ollamaResidentBytes, willSwap, warning };
}

/** Bytes Ollama currently keeps resident (freed before every local render). Best effort. */
async function ollamaResidentBytes(): Promise<number> {
  const url = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${url}/api/ps`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!res.ok) return 0;
    const data = (await res.json()) as { models?: { size?: number }[] };
    return (data.models ?? []).reduce((sum, m) => sum + (m.size ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Estimates the unified-memory footprint of a local render (weights on disk +
 * a resolution-dependent activation margin) against the free RAM ComfyUI
 * reports — the same source /api/health uses. Throws only when ComfyUI is down.
 */
export async function estimateLocalFootprint(req: GenerateRequest): Promise<FootprintEstimate> {
  const [modelBytes, teBytes, vaeBytes, stats, ollamaBytes] = await Promise.all([
    modelFileBytes(req.model.folder, req.model.name),
    Promise.all(req.textEncoders.map((t) => modelFileBytes("text_encoders", t))).then((sizes) => sizes.reduce((a, b) => a + b, 0)),
    req.vae ? modelFileBytes("vae", req.vae) : Promise.resolve(0),
    systemStats(),
    ollamaResidentBytes(),
  ]);
  return footprintVerdict({ modelBytes, textEncoderBytes: teBytes, vaeBytes, width: req.width, height: req.height }, stats.system.ram_free, ollamaBytes);
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
