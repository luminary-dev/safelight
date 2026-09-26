import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelEntry } from "./comfy/types";
import { defaultsForModel, stageLabel } from "./studio-state";

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
