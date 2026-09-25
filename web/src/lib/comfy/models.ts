import "server-only";
import { hasNode, listFolder, objectInfo } from "./client";
import { friendlyName } from "@/lib/friendly-names";
import type { ModelCatalog, ModelEntry, ModelFamily, ModelFolder } from "./types";

const IMAGE_MODEL_EXT = /\.(gguf|safetensors|sft|ckpt|pt|pth|bin)$/i;

export function classifyFamily(name: string): ModelFamily {
  const n = name.toLowerCase();
  if (/qwen[-_ ]?image|qwen-image|qwenimage/.test(n)) return "qwen-image";
  if (/flux/.test(n)) return "flux";
  if (/sdxl|xl[-_]|pony|illustrious|noob|juggernaut.*xl|realvis.*xl|animagine/.test(n)) return "sdxl";
  if (/sd[-_]?1\.?5|v1-5|dreamshaper_8|realisticvision/.test(n)) return "sd15";
  return "unknown";
}

function precisionOf(name: string): string | undefined {
  const m = name.match(/(Q[2-8]_[A-Z0-9_]+|Q[2-8]_0|Q[2-8]_1|int8|int4|fp8[a-z0-9_]*|fp16|bf16|nf4)/i);
  return m?.[1];
}

function labelOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.replace(IMAGE_MODEL_EXT, "");
}

/** Companion files that share a model folder but are not image transformers. */
const COMPANION_SUBFOLDER = /^(text_encoders|clip|vae|loras|lora|controlnet|upscale_models)\//i;

function toEntries(names: string[], folder: ModelFolder): ModelEntry[] {
  return names
    .filter((n) => IMAGE_MODEL_EXT.test(n) && !COMPANION_SUBFOLDER.test(n))
    .map((name) => {
      const friendly = friendlyName(name);
      return { name, folder, family: classifyFamily(name), label: friendly.label || labelOf(name), precision: precisionOf(name), tags: friendly.tags };
    });
}

export function emptyCatalog(): ModelCatalog {
  return { models: [], textEncoders: [], vaes: [], loras: [], samplers: ["euler", "dpmpp_2m", "res_multistep"], schedulers: ["simple", "normal", "karras", "beta"], online: false };
}

export async function getCatalog(): Promise<ModelCatalog> {
  const [gguf, diffusion, checkpoints, textEncoders, clip, clipGguf, vaes, loras, ksampler, ggufAvailable] = await Promise.all([
    listFolder("unet_gguf"),
    listFolder("diffusion_models"),
    listFolder("checkpoints"),
    listFolder("text_encoders"),
    listFolder("clip"),
    // GGUF text encoders register under their own key with only the .gguf extension.
    listFolder("clip_gguf"),
    listFolder("vae"),
    listFolder("loras"),
    objectInfo("KSampler").catch(() => undefined),
    hasNode("UnetLoaderGGUF"),
  ]);

  const ggufNames = new Set(gguf);
  // diffusion_models may also list .gguf files; those are loaded through the GGUF node instead.
  const diffusionOnly = diffusion.filter((n) => !/\.gguf$/i.test(n) || !ggufNames.has(n));

  const models: ModelEntry[] = [
    ...(ggufAvailable ? toEntries(gguf, "unet_gguf") : []),
    ...toEntries(diffusionOnly.filter((n) => !/\.gguf$/i.test(n)), "diffusion_models"),
    ...toEntries(checkpoints, "checkpoints"),
  ];

  const samplers = (ksampler?.input.required?.sampler_name?.[0] as string[] | undefined) ?? ["euler", "dpmpp_2m", "res_multistep"];
  const schedulers = (ksampler?.input.required?.scheduler?.[0] as string[] | undefined) ?? ["simple", "normal", "karras", "beta"];

  return {
    models: dedupe(models),
    textEncoders: Array.from(new Set([...textEncoders, ...clip, ...(ggufAvailable ? clipGguf : [])])).sort(),
    vaes: vaes.sort(),
    loras: loras.sort(),
    samplers,
    schedulers,
    online: true,
  };
}

function dedupe(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    const key = `${m.folder}:${m.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Picks sensible companion files for a model so the UI starts in a working state. */
export function suggestCompanions(model: ModelEntry, catalog: ModelCatalog): { textEncoders: string[]; vae?: string } {
  const te = catalog.textEncoders;
  const vaes = catalog.vaes;
  const pick = (re: RegExp, list: string[]) => list.find((n) => re.test(n.toLowerCase()));

  switch (model.family) {
    case "qwen-image":
      return {
        textEncoders: [pick(/qwen3vl[-_ ]?8b/, te) ?? pick(/qwen3vl|qwen_?3|qwen2\.5|qwen/, te) ?? te[0]].filter(Boolean) as string[],
        vae: pick(/qwen/, vaes) ?? vaes[0],
      };
    case "flux": {
      const t5 = pick(/t5/, te);
      const clipL = pick(/clip_l|clip-l/, te);
      return { textEncoders: [t5, clipL].filter(Boolean) as string[], vae: pick(/flux|ae\.s/, vaes) ?? vaes[0] };
    }
    default:
      if (model.folder === "checkpoints") return { textEncoders: [], vae: undefined };
      return { textEncoders: te.slice(0, 1), vae: vaes[0] };
  }
}
