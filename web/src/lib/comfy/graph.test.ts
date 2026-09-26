import { describe, expect, it } from "vitest";
import type { GenerateRequest } from "./types";
import { buildGraph } from "./graph";

function req(overrides: Partial<GenerateRequest>): GenerateRequest {
  return {
    mode: "txt2img",
    model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
    textEncoders: ["qwen3vl_8b_int8_convrot.safetensors"],
    vae: "qwen_image_2.1_vae_bf16.safetensors",
    lora: null,
    prompt: "a test print",
    negativePrompt: "",
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 1,
    seed: 7,
    sampler: "euler",
    scheduler: "simple",
    batch: 1,
    denoise: 0.7,
    images: [],
    refResolution: 1024,
    matchInputSize: true,
    ...overrides,
  };
}

describe("buildGraph", () => {
  it("qwen-image txt2img", () => {
    expect(buildGraph(req({}))).toMatchSnapshot();
  });

  it("qwen-image img2img with references", () => {
    expect(buildGraph(req({ mode: "img2img", images: ["studio/ref1.png", "studio/ref2.png"] }))).toMatchSnapshot();
  });

  it("qwen-image img2img with matchInputSize off uses the requested canvas", () => {
    const g = buildGraph(req({ mode: "img2img", images: ["studio/ref1.png"], matchInputSize: false }));
    const empty = Object.values(g).find((n) => n.class_type === "EmptyLatentImage");
    expect(empty?.inputs).toMatchObject({ width: 1024, height: 1024 });
  });

  it("flux txt2img with dual encoders", () => {
    expect(
      buildGraph(
        req({
          model: { name: "flux1-dev-Q8_0.gguf", folder: "unet_gguf" },
          textEncoders: ["t5xxl_fp8.safetensors", "clip_l.safetensors"],
          vae: "flux_ae.safetensors",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("flux with one encoder throws a clear error", () => {
    expect(() =>
      buildGraph(req({ model: { name: "flux1-dev.gguf", folder: "unet_gguf" }, textEncoders: ["t5xxl_fp8.safetensors"], vae: "flux_ae.safetensors" })),
    ).toThrow(/two text encoders/i);
  });

  it("checkpoint img2img", () => {
    expect(
      buildGraph(
        req({
          mode: "img2img",
          model: { name: "dreamshaper_8.safetensors", folder: "checkpoints" },
          textEncoders: [],
          vae: "",
          images: ["studio/in.png"],
          denoise: 0.55,
        }),
      ),
    ).toMatchSnapshot();
  });

  it("applies a LoRA to the model only", () => {
    const g = buildGraph(req({ lora: { name: "style.safetensors", strength: 0.8 } }));
    const lora = Object.values(g).find((n) => n.class_type === "LoraLoaderModelOnly");
    expect(lora?.inputs).toMatchObject({ lora_name: "style.safetensors", strength_model: 0.8 });
  });

  it("rejects an incompatible text encoder up front", () => {
    expect(() => buildGraph(req({ textEncoders: ["clip_l.safetensors"] }))).toThrow(/does not fit this model/);
  });

  it("rejects an empty prompt for txt2img", () => {
    expect(() => buildGraph(req({ prompt: "  " }))).toThrow(/prompt is empty/i);
  });

  it("rejects img2img without input images", () => {
    expect(() => buildGraph(req({ mode: "img2img", images: [] }))).toThrow(/needs at least one input image/i);
  });
});
