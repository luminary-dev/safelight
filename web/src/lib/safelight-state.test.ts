import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelEntry } from "./comfy/types";
import { DEFAULT_SETTINGS, defaultsForModel, stageLabel, toRequest } from "./safelight-state";

const CATALOG: ModelCatalog = {
  models: [],
  textEncoders: ["clip_l.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "t5xxl_fp8.safetensors"],
  vaes: ["flux_ae.safetensors", "qwen_image_2.1_vae_bf16.safetensors"],
  loras: ["style.safetensors"],
  samplers: ["euler"],
  schedulers: ["simple"],
  online: true,
};

function entry(name: string, family: ModelEntry["family"], folder: ModelEntry["folder"] = "unet_gguf"): ModelEntry {
  return { name, folder, family, label: name, tags: [] };
}

describe("defaultsForModel", () => {
  it("qwen-image prefers the 8b encoder and its own vae", () => {
    const d = defaultsForModel(entry("qwen-image-2.1.gguf", "qwen-image"), CATALOG);
    expect(d.textEncoders).toEqual(["qwen3vl_8b_int8_convrot.safetensors"]);
    expect(d.vae).toBe("qwen_image_2.1_vae_bf16.safetensors");
    expect(d).toMatchObject({ steps: 25, cfg: 1 });
  });

  it("flux picks t5 plus clip-l and the flux vae", () => {
    const d = defaultsForModel(entry("flux1-dev.gguf", "flux"), CATALOG);
    expect(d.textEncoders).toEqual(["t5xxl_fp8.safetensors", "clip_l.safetensors"]);
    expect(d.vae).toBe("flux_ae.safetensors");
  });

  it("checkpoint families carry no companions", () => {
    const d = defaultsForModel(entry("dreamshaper_8.safetensors", "sd15", "checkpoints"), CATALOG);
    expect(d.textEncoders).toEqual([]);
    expect(d).toMatchObject({ steps: 28, cfg: 7 });
  });

  it("always clears any previously selected LoRA", () => {
    for (const fam of ["qwen-image", "flux", "sdxl", "sd15", "cloud"] as const) {
      expect(defaultsForModel(entry("x", fam), CATALOG).lora).toBe("");
    }
  });
});

describe("stageLabel", () => {
  it("names the load-bearing stages", () => {
    expect(stageLabel("UnetLoaderGGUF")).toBe("Loading model");
    expect(stageLabel("CLIPLoaderGGUF")).toBe("Loading text encoder");
    expect(stageLabel("VAEDecode")).toBe("Decoding image");
    expect(stageLabel("SomethingNew")).toBe("Preparing");
    expect(stageLabel(undefined)).toBe("Preparing");
  });
});

describe("stageLabel for Stage actions, mask edits, ControlNet, and video/audio", () => {
  it("names the new node classes instead of a generic Preparing", () => {
    expect(stageLabel("UpscaleModelLoader")).toBe("Loading upscale model");
    expect(stageLabel("ImageUpscaleWithModel")).toBe("Upscaling");
    expect(stageLabel("RemoveBackground")).toBe("Removing background");
    expect(stageLabel("SetLatentNoiseMask")).toBe("Preparing mask");
    expect(stageLabel("GrowMask")).toBe("Preparing mask");
    expect(stageLabel("ImagePadForOutpaint")).toBe("Extending canvas");
    expect(stageLabel("ImageCompositeMasked")).toBe("Compositing");
    expect(stageLabel("ControlNetLoader")).toBe("Loading ControlNet");
    expect(stageLabel("ModelPatchLoader")).toBe("Loading ControlNet");
    expect(stageLabel("QwenImageDiffsynthControlnet")).toBe("Applying ControlNet");
    expect(stageLabel("ControlNetInpaintingAliMamaApply")).toBe("Applying ControlNet");
    expect(stageLabel("Canny")).toBe("Tracing edges");
    expect(stageLabel("SaveVideo")).toBe("Encoding video");
    expect(stageLabel("SaveAudio")).toBe("Saving audio");
    expect(stageLabel("VAEDecodeAudio")).toBe("Decoding audio");
  });
});

describe("toRequest ControlNet wiring", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    model: entry("z_image_turbo_bf16.safetensors", "unknown", "diffusion_models"),
    prompt: "a poster",
  };

  it("carries control settings only for img2img with a type selected", () => {
    const on = toRequest({ ...settings, mode: "img2img", controlType: "canny", controlStrength: 0.7 }, 1);
    expect(on.control).toEqual({ type: "canny", strength: 0.7 });
    expect(toRequest({ ...settings, mode: "img2img", controlType: "" }, 1).control).toBeNull();
    expect(toRequest({ ...settings, mode: "txt2img", controlType: "canny" }, 1).control).toBeNull();
  });
});
