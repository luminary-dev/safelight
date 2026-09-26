import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";
import { modelNamesByFamily } from "@/test/fixtures/model-names";
import type { ModelCatalog, ModelEntry, ModelFamily } from "./types";
import { classifyFamily, suggestCompanions } from "./models";

/** Real-world filenames and the family each must land in. */
const FIXTURES: [string, ModelFamily][] = [
  // Qwen-Image line (including edit variants, which share the graph today)
  ["qwen-image-2.1-Q4_K_M.gguf", "qwen-image"],
  ["Qwen_Image_2.1_uncensored_Q5_K_M.gguf", "qwen-image"],
  ["qwenimage-v1.safetensors", "qwen-image"],
  ["qwen-image-edit-2511-Q4_K_M.gguf", "qwen-image"],
  // Flux line — flux2 files also land here since the dedicated family was removed
  ["flux1-dev-Q8_0.gguf", "flux"],
  ["FLUX.1-schnell-fp8.safetensors", "flux"],
  ["flux1-kontext-dev-Q4_K_S.gguf", "flux"],
  ["flux-2-klein-9b-Q4_K_M.gguf", "flux"],
  // SDXL family and its finetune ecosystem
  ["sd_xl_base_1.0.safetensors", "sdxl"],
  ["juggernautXL_v9.safetensors", "sdxl"],
  ["ponyDiffusionV6XL.safetensors", "sdxl"],
  ["illustriousXL_v01.safetensors", "sdxl"],
  ["noobaiXLNAIXL_epsilon.safetensors", "sdxl"],
  ["animagineXL_v31.safetensors", "sdxl"],
  ["realvisxlV40.safetensors", "sdxl"],
  // SD 1.5
  ["v1-5-pruned-emaonly.ckpt", "sd15"],
  ["sd-1.5-inpainting.safetensors", "sd15"],
  ["dreamshaper_8.safetensors", "sd15"],
  ["realisticVisionV60.safetensors", "sd15"],
  // Unknown stays unknown rather than guessing
  ["mystery-model.safetensors", "unknown"],
  ["hunyuan_dit_1.2.safetensors", "unknown"],
];

describe("classifyFamily", () => {
  it.each(FIXTURES)("%s → %s", (name, family) => {
    expect(classifyFamily(name)).toBe(family);
  });

  it("is case-insensitive", () => {
    expect(classifyFamily("QWEN-IMAGE-2.1.GGUF")).toBe("qwen-image");
    expect(classifyFamily("FLUX1-DEV.SAFETENSORS")).toBe("flux");
  });
});

// ---------------------------------------------------------------------------
// getCatalog against the fake ComfyUI (TEST-BRIEF §6)

describe("getCatalog", () => {
  let comfy: FakeComfy;

  /** COMFY_URL is read at client-module load, so each test imports a fresh models module pointed at the fake. */
  async function catalogAt(url: string) {
    vi.resetModules();
    vi.stubEnv("COMFY_URL", url);
    const { getCatalog } = await import("./models");
    return getCatalog();
  }

  beforeEach(async () => {
    comfy = await startFakeComfy();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await comfy.close();
  });

  it("assembles gguf, diffusion and checkpoint models when the GGUF node is installed", async () => {
    comfy.setObjectInfo("UnetLoaderGGUF", { input: { required: { unet_name: [[]] } } });
    comfy.setFolder("unet_gguf", ["qwen-image-Q4_K_M.gguf"]);
    comfy.setFolder("diffusion_models", ["flux1-fill-dev.safetensors", "qwen-image-Q4_K_M.gguf"]); // the gguf duplicate loads through the GGUF node instead
    comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
    const catalog = await catalogAt(comfy.url);
    expect(catalog.online).toBe(true);
    expect(catalog.models.map((m) => `${m.folder}:${m.name}`)).toEqual([
      "unet_gguf:qwen-image-Q4_K_M.gguf",
      "diffusion_models:flux1-fill-dev.safetensors",
      "checkpoints:sd_xl_base_1.0.safetensors",
    ]);
    const gguf = catalog.models[0];
    expect(gguf.family).toBe("qwen-image");
    expect(gguf.precision).toBe("Q4_K_M");
  });

  it("hides GGUF models and clip_gguf encoders when the UnetLoaderGGUF node is absent", async () => {
    comfy.setFolder("unet_gguf", ["qwen-image-Q4_K_M.gguf"]);
    comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
    comfy.setFolder("clip_gguf", ["qwen3-vl-8b-Q8_0.gguf"]);
    comfy.setFolder("text_encoders", ["clip_l.safetensors"]);
    const catalog = await catalogAt(comfy.url); // default object_info has no UnetLoaderGGUF
    expect(catalog.models.map((m) => m.name)).toEqual(["sd_xl_base_1.0.safetensors"]);
    expect(catalog.textEncoders).toEqual(["clip_l.safetensors"]);
  });

  it("merges text_encoders, clip, and clip_gguf into one sorted, deduped encoder list", async () => {
    comfy.setObjectInfo("UnetLoaderGGUF", { input: { required: { unet_name: [[]] } } });
    comfy.setFolder("text_encoders", ["t5xxl_fp16.safetensors", "clip_l.safetensors"]);
    comfy.setFolder("clip", ["clip_l.safetensors", "clip_g.safetensors"]);
    comfy.setFolder("clip_gguf", ["qwen3-vl-8b-Q8_0.gguf"]);
    const catalog = await catalogAt(comfy.url);
    expect(catalog.textEncoders).toEqual(["clip_g.safetensors", "clip_l.safetensors", "qwen3-vl-8b-Q8_0.gguf", "t5xxl_fp16.safetensors"]);
  });

  it("treats absent folders (clip, clip_gguf answer 404) as empty rather than failing", async () => {
    comfy.setFolder("text_encoders", ["clip_l.safetensors"]);
    comfy.setFolder("checkpoints", ["dreamshaper_8.safetensors"]);
    const catalog = await catalogAt(comfy.url); // "clip" and "clip_gguf" are not registered on the fake
    expect(catalog.textEncoders).toEqual(["clip_l.safetensors"]);
    expect(catalog.models).toHaveLength(1);
  });

  it("filters companion subfolders and non-model extensions out of the model list", async () => {
    comfy.setFolder("checkpoints", [
      "sd_xl_base_1.0.safetensors",
      "text_encoders/t5xxl_fp16.safetensors",
      "vae/sdxl_vae.safetensors",
      "loras/lcm-lora-sdxl.safetensors",
      "controlnet/control_v11p_sd15_canny.pth",
      "upscale_models/4x-UltraSharp.pth",
      "notes.txt",
    ]);
    const catalog = await catalogAt(comfy.url);
    expect(catalog.models.map((m) => m.name)).toEqual(["sd_xl_base_1.0.safetensors"]);
  });

  it("dedupes a name listed twice in the same folder", async () => {
    comfy.setFolder("checkpoints", ["dreamshaper_8.safetensors", "dreamshaper_8.safetensors"]);
    const catalog = await catalogAt(comfy.url);
    expect(catalog.models).toHaveLength(1);
  });

  it("takes samplers and schedulers from KSampler's object_info", async () => {
    const catalog = await catalogAt(comfy.url);
    expect(catalog.samplers).toEqual(["euler", "euler_ancestral", "dpmpp_2m", "res_multistep"]);
    expect(catalog.schedulers).toEqual(["simple", "normal", "karras", "beta"]);
  });

  it("falls back to the built-in sampler lists when object_info fails", async () => {
    comfy.removeObjectInfo("KSampler");
    const catalog = await catalogAt(comfy.url);
    expect(catalog.samplers).toEqual(["euler", "dpmpp_2m", "res_multistep"]);
    expect(catalog.schedulers).toEqual(["simple", "normal", "karras", "beta"]);
    expect(catalog.online).toBe(true); // a missing node never marks ComfyUI offline
  });

  it("sorts vaes and loras", async () => {
    comfy.setFolder("vae", ["z.safetensors", "ae.safetensors"]);
    comfy.setFolder("loras", ["b.safetensors", "a.safetensors"]);
    const catalog = await catalogAt(comfy.url);
    expect(catalog.vaes).toEqual(["ae.safetensors", "z.safetensors"]);
    expect(catalog.loras).toEqual(["a.safetensors", "b.safetensors"]);
  });
});

// ---------------------------------------------------------------------------
// suggestCompanions per family, using the shared model-name fixtures

describe("suggestCompanions", () => {
  const TE = ["clip_l.safetensors", "t5xxl_fp16.safetensors", "qwen_3_vl_7b_bf16.safetensors"];
  const VAES = ["ae.safetensors", "qwen_image_2.1_vae.safetensors", "sdxl_vae.safetensors"];

  function entry(name: string, folder: ModelEntry["folder"] = "unet_gguf"): ModelEntry {
    return { name, folder, family: classifyFamily(name), label: name, tags: [] };
  }

  function catalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
    return { models: [], textEncoders: TE, vaes: VAES, loras: [], samplers: [], schedulers: [], online: true, ...overrides };
  }

  it("qwen-image: picks a qwen text encoder and the qwen VAE", () => {
    const model = entry(modelNamesByFamily("qwen-image")[0]);
    expect(suggestCompanions(model, catalog())).toEqual({
      textEncoders: ["qwen_3_vl_7b_bf16.safetensors"],
      vae: "qwen_image_2.1_vae.safetensors",
    });
  });

  it("flux: picks the T5 + CLIP-L pair and the flux VAE (published as ae.safetensors)", () => {
    const model = entry(modelNamesByFamily("flux")[0]);
    expect(suggestCompanions(model, catalog())).toEqual({
      textEncoders: ["t5xxl_fp16.safetensors", "clip_l.safetensors"],
      vae: "ae.safetensors",
    });
  });

  it("flux without a CLIP-L still suggests the T5 alone", () => {
    const model = entry("flux1-dev-Q8_0.gguf");
    const out = suggestCompanions(model, catalog({ textEncoders: ["t5xxl_fp16.safetensors"] }));
    expect(out.textEncoders).toEqual(["t5xxl_fp16.safetensors"]);
  });

  it("checkpoints need no companions: the file bundles them", () => {
    const model = entry("majicmixRealistic_v7.safetensors", "checkpoints");
    expect(suggestCompanions(model, catalog())).toEqual({ textEncoders: [], vae: undefined });
  });

  it("an unknown diffusion model falls back to the first encoder and VAE", () => {
    const model = entry("hunyuan_dit_1.2.safetensors", "diffusion_models");
    expect(suggestCompanions(model, catalog())).toEqual({ textEncoders: ["clip_l.safetensors"], vae: "ae.safetensors" });
  });

  it("qwen-image with an empty catalog suggests nothing rather than throwing", () => {
    const model = entry("qwen-image-Q4_K_M.gguf");
    expect(suggestCompanions(model, catalog({ textEncoders: [], vaes: [] }))).toEqual({ textEncoders: [], vae: undefined });
  });
});
