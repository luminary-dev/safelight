import { describe, expect, it } from "vitest";
import type { GenerateRequest } from "./types";
import { buildGraph, buildInpaintGraph, buildOutpaintGraph, buildRemoveBackgroundGraph, buildUpscaleGraph, type Graph } from "./graph";

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
    expect(buildGraph(req({ mode: "img2img", images: ["safelight/ref1.png", "safelight/ref2.png"] }))).toMatchSnapshot();
  });

  it("qwen-image img2img with matchInputSize off uses the requested canvas", () => {
    const g = buildGraph(req({ mode: "img2img", images: ["safelight/ref1.png"], matchInputSize: false }));
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
          images: ["safelight/in.png"],
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

describe("buildUpscaleGraph", () => {
  it("LoadImage → UpscaleModelLoader → ImageUpscaleWithModel → SaveImage", () => {
    expect(buildUpscaleGraph({ image: "safelight/render.png [output]", upscaleModel: "4x-UltraSharp.pth" })).toMatchSnapshot();
  });

  it("rejects a missing image or model", () => {
    expect(() => buildUpscaleGraph({ image: "", upscaleModel: "x.pth" })).toThrow(/needs an input image/i);
    expect(() => buildUpscaleGraph({ image: "a.png", upscaleModel: "" })).toThrow(/needs an upscale model/i);
  });
});

describe("buildRemoveBackgroundGraph", () => {
  it("matches the BiRefNet blueprint: mask inverted before JoinImageWithAlpha", () => {
    expect(buildRemoveBackgroundGraph({ image: "safelight/render.png [output]", model: "birefnet.safetensors" })).toMatchSnapshot();
  });

  it("rejects a missing image or model", () => {
    expect(() => buildRemoveBackgroundGraph({ image: "", model: "birefnet.safetensors" })).toThrow(/needs an input image/i);
    expect(() => buildRemoveBackgroundGraph({ image: "a.png", model: "" })).toThrow(/needs a birefnet model/i);
  });
});

const classesOf = (g: Graph) => Object.values(g).map((n) => n.class_type);

describe("buildInpaintGraph", () => {
  const inpaintReq = () => req({ mode: "img2img", images: ["safelight/render.png [output]"], prompt: "a red hat", denoise: 1 });

  it("matches the Qwen inpainting blueprint shape (latent noise mask, grown + feathered mask)", () => {
    expect(buildInpaintGraph(inpaintReq(), { mask: "safelight/mask.png", maskExpand: 4, maskBlur: 8 })).toMatchSnapshot();
  });

  it("adds ControlNetInpaintingAliMamaApply when an inpainting ControlNet is installed", () => {
    const g = buildInpaintGraph(inpaintReq(), { mask: "safelight/mask.png", controlNet: "Qwen-Image-InstantX-ControlNet-Inpainting.safetensors" });
    const applyId = Object.keys(g).find((id) => g[id].class_type === "ControlNetInpaintingAliMamaApply");
    expect(applyId).toBeDefined();
    // The sampler must be conditioned by the ControlNet's outputs, not the raw text encoding.
    const sampler = Object.values(g).find((n) => n.class_type === "KSampler");
    expect(sampler?.inputs.positive).toEqual([applyId, 0]);
    expect(sampler?.inputs.negative).toEqual([applyId, 1]);
  });

  it("keeps the sampler noise inside the mask via SetLatentNoiseMask", () => {
    const g = buildInpaintGraph(inpaintReq(), { mask: "safelight/mask.png" });
    expect(classesOf(g)).toEqual(expect.arrayContaining(["LoadImage", "ImageToMask", "GrowMask", "ImageBlur", "SetLatentNoiseMask", "VAEEncode", "KSampler", "VAEDecode", "SaveImage"]));
    expect(classesOf(g)).not.toContain("ControlNetLoader");
  });

  it("rejects a missing mask, image, or prompt", () => {
    expect(() => buildInpaintGraph(inpaintReq(), { mask: "" })).toThrow(/needs a mask/i);
    expect(() => buildInpaintGraph(req({ mode: "img2img", images: [], prompt: "x" }), { mask: "m.png" })).toThrow(/needs the image/i);
    expect(() => buildInpaintGraph(req({ mode: "img2img", images: ["a.png"], prompt: " " }), { mask: "m.png" })).toThrow(/prompt is empty/i);
  });

  it("names the model family when it is not Qwen-Image", () => {
    expect(() =>
      buildInpaintGraph(req({ mode: "img2img", images: ["a.png"], prompt: "x", model: { name: "flux1-dev-Q8_0.gguf", folder: "unet_gguf" }, textEncoders: ["t5.safetensors"], vae: "ae.safetensors" }), { mask: "m.png" }),
    ).toThrow(/qwen-image/i);
  });
});

describe("buildOutpaintGraph", () => {
  const outpaintReq = () => req({ mode: "img2img", images: ["safelight/render.png [output]"], prompt: "rolling dunes", denoise: 1 });

  it("matches the Qwen outpainting blueprint shape (pad, scale, composite back)", () => {
    expect(buildOutpaintGraph(outpaintReq(), { left: 256, top: 0, right: 256, bottom: 0, feathering: 24 })).toMatchSnapshot();
  });

  it("pads only the requested sides and composites the original pixels back", () => {
    const g = buildOutpaintGraph(outpaintReq(), { left: 0, top: 128, right: 0, bottom: 0 });
    const pad = Object.values(g).find((n) => n.class_type === "ImagePadForOutpaint");
    expect(pad?.inputs).toMatchObject({ left: 0, top: 128, right: 0, bottom: 0 });
    expect(classesOf(g)).toEqual(expect.arrayContaining(["ImagePadForOutpaint", "ImageScaleToMaxDimension", "SetLatentNoiseMask", "ImageCompositeMasked", "SaveImage"]));
  });

  it("rejects a no-direction outpaint", () => {
    expect(() => buildOutpaintGraph(outpaintReq(), { left: 0, top: 0, right: 0, bottom: 0 })).toThrow(/at least one direction/i);
  });
});

describe("buildGraph with ControlNet", () => {
  const controlReq = (over: Partial<GenerateRequest> = {}) =>
    req({
      mode: "img2img",
      model: { name: "z_image_turbo_bf16.safetensors", folder: "diffusion_models" },
      textEncoders: ["qwen_3_4b.safetensors"],
      vae: "ae.safetensors",
      images: ["safelight/ref.png"],
      control: { type: "canny", strength: 1, patch: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors", cannyLow: 0.3, cannyHigh: 0.4 },
      ...over,
    });

  it("matches the Z-Image-Turbo ControlNet blueprint shape (canny)", () => {
    expect(buildGraph(controlReq())).toMatchSnapshot();
  });

  it("routes the model through the control patch and sizes the canvas from the control map", () => {
    const g = buildGraph(controlReq());
    expect(classesOf(g)).toEqual(expect.arrayContaining(["ModelPatchLoader", "QwenImageDiffsynthControlnet", "ModelSamplingAuraFlow", "Canny", "GetImageSize", "EmptySD3LatentImage"]));
    const guidedId = Object.keys(g).find((id) => g[id].class_type === "QwenImageDiffsynthControlnet");
    const sampler = Object.values(g).find((n) => n.class_type === "KSampler");
    expect(sampler?.inputs.model).toEqual([guidedId, 0]);
  });

  it("depth/pose skip the canny preprocessor: the reference is already a map", () => {
    const g = buildGraph(controlReq({ control: { type: "depth", strength: 0.8, patch: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" } }));
    expect(classesOf(g)).not.toContain("Canny");
  });

  it("uses the lumina2 clip type for Z-Image models", () => {
    const g = buildGraph(controlReq());
    const clip = Object.values(g).find((n) => n.class_type === "CLIPLoader");
    expect(clip?.inputs.type).toBe("lumina2");
  });

  it("names the missing patch file when none is resolved", () => {
    expect(() => buildGraph(controlReq({ control: { type: "canny", strength: 1 } }))).toThrow(/Z-Image-Turbo-Fun-Controlnet-Union\.safetensors/);
  });

  it("rejects checkpoints", () => {
    expect(() => buildGraph(controlReq({ model: { name: "dreamshaper_8.safetensors", folder: "checkpoints" } }))).toThrow(/checkpoint/i);
  });
});
