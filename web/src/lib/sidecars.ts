import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import type { GenerateRequest, ModelFolder } from "@/lib/comfy/types";
import { randomSeed } from "@/lib/presets";

/**
 * Metadata sidecars: `<image>.json` written beside every successful render.
 * The shape is a cross-workstream contract (Library indexing, recreate/vary) —
 * change it only by bumping `v`.
 */
export interface RenderSidecar {
  v: 1;
  kind: "safelight-render";
  mode: "txt2img" | "img2img";
  model: { name: string; folder: string; provider?: string };
  prompt: string;
  negativePrompt: string;
  seed: number;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  width: number;
  height: number;
  denoise: number;
  /** Input image references (ComfyUI-style, e.g. "safelight/ref.png"). */
  images: string[];
  textEncoders: string[];
  vae?: string;
  lora?: unknown;
  createdAt: string;
}

/** Where the sidecar for an image lives: right beside it, same name plus .json. */
export function sidecarPath(imagePath: string): string {
  return `${imagePath}.json`;
}

/** Builds the sidecar document for a finished render. */
export function sidecarForRequest(req: GenerateRequest, createdAt = new Date().toISOString()): RenderSidecar {
  const sidecar: RenderSidecar = {
    v: 1,
    kind: "safelight-render",
    mode: req.mode,
    model: { name: req.model.name, folder: req.model.folder, ...(req.model.provider ? { provider: req.model.provider } : {}) },
    prompt: req.prompt,
    negativePrompt: req.negativePrompt,
    seed: req.seed,
    sampler: req.sampler,
    scheduler: req.scheduler,
    steps: req.steps,
    cfg: req.cfg,
    width: req.width,
    height: req.height,
    denoise: req.denoise,
    images: [...req.images],
    textEncoders: [...req.textEncoders],
    createdAt,
  };
  if (req.vae) sidecar.vae = req.vae;
  if (req.lora) sidecar.lora = req.lora;
  return sidecar;
}

/**
 * Writes `<imagePath>.json`. Never throws: a failed sidecar must not fail the
 * render it describes. Returns whether the write landed.
 */
export async function writeSidecar(imagePath: string, sidecar: RenderSidecar): Promise<boolean> {
  try {
    await writeFile(sidecarPath(imagePath), `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    return true;
  } catch (err) {
    console.warn(`[sidecar] could not write ${sidecarPath(imagePath)}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Reads the sidecar beside an image. Missing file, garbage JSON, or a foreign shape all return null. */
export async function readSidecar(imagePath: string): Promise<RenderSidecar | null> {
  let raw: string;
  try {
    raw = await readFile(sidecarPath(imagePath), "utf8");
  } catch {
    return null;
  }
  try {
    const data: unknown = JSON.parse(raw);
    return isRenderSidecar(data) ? data : null;
  } catch {
    return null;
  }
}

function isRenderSidecar(data: unknown): data is RenderSidecar {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const model = d.model as Record<string, unknown> | undefined;
  return (
    d.v === 1 &&
    d.kind === "safelight-render" &&
    (d.mode === "txt2img" || d.mode === "img2img") &&
    typeof model === "object" &&
    model !== null &&
    typeof model.name === "string" &&
    typeof model.folder === "string" &&
    typeof d.prompt === "string" &&
    typeof d.negativePrompt === "string" &&
    typeof d.seed === "number" &&
    typeof d.sampler === "string" &&
    typeof d.scheduler === "string" &&
    typeof d.steps === "number" &&
    typeof d.cfg === "number" &&
    typeof d.width === "number" &&
    typeof d.height === "number" &&
    typeof d.denoise === "number" &&
    Array.isArray(d.images) &&
    Array.isArray(d.textEncoders) &&
    typeof d.createdAt === "string"
  );
}

const KNOWN_FOLDERS: ModelFolder[] = ["unet_gguf", "diffusion_models", "checkpoints", "cloud"];

/**
 * Rebuilds a generate request body from a sidecar. `vary` swaps in a fresh
 * random seed; everything else recreates the original render exactly.
 */
export function sidecarToRequest(sidecar: RenderSidecar, vary = false): Partial<GenerateRequest> {
  const folder = sidecar.model.folder as ModelFolder;
  if (!KNOWN_FOLDERS.includes(folder)) throw new Error(`This render used an unknown model folder ("${sidecar.model.folder}"), so it cannot be recreated.`);
  return {
    mode: sidecar.mode,
    model: { name: sidecar.model.name, folder, provider: sidecar.model.provider as GenerateRequest["model"]["provider"] },
    textEncoders: sidecar.textEncoders.map(String),
    vae: sidecar.vae,
    lora: isLoraChoice(sidecar.lora) ? sidecar.lora : null,
    prompt: sidecar.prompt,
    negativePrompt: sidecar.negativePrompt,
    seed: vary ? randomSeed() : sidecar.seed,
    sampler: sidecar.sampler,
    scheduler: sidecar.scheduler,
    steps: sidecar.steps,
    cfg: sidecar.cfg,
    width: sidecar.width,
    height: sidecar.height,
    denoise: sidecar.denoise,
    images: sidecar.images.map(String),
  };
}

function isLoraChoice(lora: unknown): lora is { name: string; strength: number } {
  return Boolean(lora) && typeof lora === "object" && typeof (lora as { name?: unknown }).name === "string" && typeof (lora as { strength?: unknown }).strength === "number";
}
