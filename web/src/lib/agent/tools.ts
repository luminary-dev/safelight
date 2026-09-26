import "server-only";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isComfyUp } from "@/lib/comfy/client";
import { emptyCatalog, getCatalog } from "@/lib/comfy/models";
import type { GenerateRequest, JobOutput, ModelCatalog, ModelEntry } from "@/lib/comfy/types";
import { friendlyName } from "@/lib/friendly-names";
import { queueLocal, runCloud, sanitizeRequest, waitForJob } from "@/lib/generate-core";
import { defaultsForModel } from "@/lib/safelight-state";
import { cloudCatalog } from "@/lib/providers";
import { OUTPUT_DIR } from "@/lib/safelight-files";
import { SIZE_PRESETS, randomSeed } from "@/lib/presets";

/** Provider-neutral tool definition; each provider adapter maps it to its own wire format. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  clientId: string;
  /** Replaces the Safelight toolset; used by the code agent. */
  toolset?: {
    defs: ToolDef[];
    execute: (name: string, args: Record<string, unknown>, ctx: ToolContext, id: string) => Promise<{ result: unknown; images?: JobOutput[]; note?: string }>;
  };
  /** Replaces the default agent system prompt. */
  systemPrompt?: string;
  /** Loop budget; the default suits chat-sized tasks, coding runs pass more. */
  budget?: { maxRounds?: number };
  /** Preferred image model key "folder:name" chosen in the UI, if any. */
  preferredModel?: string;
  /** Sampling overrides from the UI; unset fields keep each provider's defaults. */
  params?: { temperature?: number; topP?: number; maxTokens?: number };
  /** Project this run belongs to; when set, the per-project notes tools join the toolset. */
  projectId?: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: Record<string, unknown>; state: "running" | "done" | "error"; result?: unknown; images?: JobOutput[]; note?: string }
  | { type: "approval"; id: string; path: string; tool: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string }
  | { type: "done" };

const ASPECTS = SIZE_PRESETS.map((p) => p.ratio);

export const TOOLS: ToolDef[] = [
  {
    name: "generate_image",
    description:
      "Render a new image from a text prompt with Safelight's image models. Use for any request to make, draw, render, or imagine a picture. Returns image references you can pass to edit_image. Rendering takes from a few seconds (cloud) to several minutes (local), so call it once with a strong prompt rather than many times.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed visual description: subject, setting, lighting, style, camera." },
        aspect: { type: "string", enum: ASPECTS, description: "Aspect ratio. Default 1:1." },
        model: { type: "string", description: "Optional model id from list_models. Defaults to the model selected in the app." },
        count: { type: "integer", minimum: 1, maximum: 4, description: "How many variations. Default 1." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_image",
    description:
      "Change an existing image with an instruction, keeping everything else the same. Pass the reference returned by generate_image or list_recent_images (for example 'safelight/qwen_00003_.png'). Describe the change in the instruction; with the local Qwen-Image model refer to the picture as <image1>.",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image reference like 'safelight/qwen_00003_.png' or 'cloud/openai_..._1.png'." },
        instruction: { type: "string", description: "What to change." },
        model: { type: "string", description: "Optional model id from list_models that supports edits." },
      },
      required: ["image", "instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    description: "List the image models available right now (local via ComfyUI and cloud via API keys) with their ids and whether they support edits.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_recent_images",
    description: "List the most recent rendered images in the gallery with their references, newest first.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 24, description: "Default 8." } },
      additionalProperties: false,
    },
  },
];

async function fullCatalog(): Promise<ModelCatalog> {
  const [up, cloud] = await Promise.all([isComfyUp(), cloudCatalog()]);
  let catalog = emptyCatalog();
  if (up) catalog = await getCatalog().catch(() => emptyCatalog());
  const cloudModels: ModelEntry[] = cloud.images.map((m) => ({ name: m.id, folder: "cloud", family: "cloud", label: m.label, tags: m.tags, provider: m.provider, edit: m.edit }));
  return { ...catalog, models: [...catalog.models, ...cloudModels], cloudErrors: cloud.errors };
}

function modelKey(m: ModelEntry) {
  return `${m.folder}:${m.name}`;
}

function pickModel(catalog: ModelCatalog, requested: string | undefined, preferred: string | undefined, needEdit: boolean): ModelEntry {
  const byId = (id: string) => catalog.models.find((m) => modelKey(m) === id || m.name === id || m.label.toLowerCase() === id.toLowerCase());
  const candidates = [requested && byId(requested), preferred && byId(preferred), ...catalog.models].filter((m): m is ModelEntry => Boolean(m));
  const usable = candidates.filter((m) => (m.folder === "cloud" ? !needEdit || m.edit : true));
  if (usable.length === 0) throw new Error(needEdit ? "No model that supports edits is available." : "No image model is available. Start ComfyUI or add an OpenAI or Gemini key.");
  return usable[0];
}

function sizeFor(aspect: string | undefined) {
  const preset = SIZE_PRESETS.find((p) => p.ratio === aspect) ?? SIZE_PRESETS[0];
  return { width: preset.width, height: preset.height };
}

async function render(req: GenerateRequest, ctx: ToolContext, toolId: string, name: string, args: Record<string, unknown>): Promise<{ images: JobOutput[]; seed: number; model: string }> {
  if (req.model.folder === "cloud") {
    const outputs = await runCloud(req);
    return { images: outputs, seed: req.seed, model: req.model.name };
  }
  const { id } = await queueLocal(req, ctx.clientId);
  const status = await waitForJob(id, {
    signal: ctx.signal,
    onTick: (s, elapsed) => {
      ctx.emit({ type: "tool", id: toolId, name, args, state: "running", note: `${s.state === "queued" ? "Queued" : "Rendering"} · ${Math.round(elapsed / 1000)}s` });
    },
  });
  if (status.state === "error") throw new Error(status.error ?? "Render failed.");
  return { images: status.outputs, seed: req.seed, model: req.model.name };
}

function refOf(o: JobOutput) {
  return o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
}

export async function executeTool(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext, toolId: string): Promise<{ result: unknown; images?: JobOutput[]; note?: string }> {
  switch (name) {
    case "list_models": {
      const catalog = await fullCatalog();
      return {
        result: {
          models: catalog.models.map((m) => ({
            id: modelKey(m),
            name: m.label,
            where: m.folder === "cloud" ? m.provider : "local",
            tags: m.tags ?? [],
            supportsEdit: m.folder === "cloud" ? Boolean(m.edit) : true,
          })),
          comfyOnline: catalog.online,
        },
      };
    }
    case "list_recent_images": {
      const limit = typeof rawArgs.limit === "number" ? Math.min(24, Math.max(1, rawArgs.limit)) : 8;
      const items: { ref: string; modified: string }[] = [];
      const walk = async (dir: string, rel: string) => {
        let entries: import("node:fs").Dirent[] = [];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full, rel ? `${rel}/${e.name}` : e.name);
          else if (/\.(png|jpe?g|webp)$/i.test(e.name)) {
            const s = await stat(full);
            items.push({ ref: rel ? `${rel}/${e.name}` : e.name, modified: new Date(s.mtimeMs).toISOString() });
          }
        }
      };
      await walk(OUTPUT_DIR, "");
      items.sort((a, b) => (a.modified < b.modified ? 1 : -1));
      const top = items.slice(0, limit);
      return { result: { images: top }, images: top.map((i) => ({ filename: path.basename(i.ref), subfolder: path.dirname(i.ref) === "." ? "" : path.dirname(i.ref), type: "output" })) };
    }
    case "generate_image": {
      const prompt = String(rawArgs.prompt ?? "").trim();
      if (!prompt) throw new Error("generate_image needs a prompt.");
      const catalog = await fullCatalog();
      const model = pickModel(catalog, typeof rawArgs.model === "string" ? rawArgs.model : undefined, ctx.preferredModel, false);
      const d = defaultsForModel(model, catalog);
      const req = sanitizeRequest({
        mode: "txt2img",
        model: { name: model.name, folder: model.folder, provider: model.provider },
        textEncoders: d.textEncoders ?? [],
        vae: d.vae || undefined,
        prompt,
        negativePrompt: "",
        ...sizeFor(typeof rawArgs.aspect === "string" ? rawArgs.aspect : undefined),
        steps: d.steps ?? 20,
        cfg: d.cfg ?? 1,
        seed: randomSeed(),
        sampler: d.sampler ?? "euler",
        scheduler: d.scheduler ?? "simple",
        batch: typeof rawArgs.count === "number" ? Math.min(4, Math.max(1, Math.round(rawArgs.count))) : 1,
        denoise: 1,
        images: [],
        refResolution: 1024,
        matchInputSize: true,
      });
      const out = await render(req, ctx, toolId, name, rawArgs);
      // `model` is the friendly label for display; `modelId` is the raw identifier the pricing table matches on.
      return { result: { images: out.images.map(refOf), seed: out.seed, model: friendlyName(out.model).label, modelId: out.model }, images: out.images };
    }
    case "edit_image": {
      const image = String(rawArgs.image ?? "").trim();
      const instruction = String(rawArgs.instruction ?? "").trim();
      if (!image || !instruction) throw new Error("edit_image needs an image reference and an instruction.");
      const catalog = await fullCatalog();
      const model = pickModel(catalog, typeof rawArgs.model === "string" ? rawArgs.model : undefined, ctx.preferredModel, true);
      const d = defaultsForModel(model, catalog);
      const isQwen = model.family === "qwen-image";
      const ref = /\s\[(input|output|temp)\]$/.test(image) ? image : `${image} [output]`;
      const req = sanitizeRequest({
        mode: "img2img",
        model: { name: model.name, folder: model.folder, provider: model.provider },
        textEncoders: d.textEncoders ?? [],
        vae: d.vae || undefined,
        prompt: isQwen && !/<image1>/.test(instruction) ? `${instruction} Keep everything else in <image1> unchanged.` : instruction,
        negativePrompt: "",
        width: 1024,
        height: 1024,
        steps: d.steps ?? 20,
        cfg: d.cfg ?? 1,
        seed: randomSeed(),
        sampler: d.sampler ?? "euler",
        scheduler: d.scheduler ?? "simple",
        batch: 1,
        denoise: 0.6,
        images: [ref],
        refResolution: 1024,
        matchInputSize: true,
      });
      const out = await render(req, ctx, toolId, name, rawArgs);
      return { result: { images: out.images.map(refOf), seed: out.seed, model: friendlyName(out.model).label, modelId: out.model }, images: out.images };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
