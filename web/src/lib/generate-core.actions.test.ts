import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "@/lib/comfy/types";

// The output folder must be pinned before generate-core (via safelight-files) resolves it at import time.
const OUT = mkdtempSync(path.join(tmpdir(), "safelight-out-"));
mkdirSync(path.join(OUT, "safelight")); // ComfyUI creates output subfolders when it saves
process.env.COMFY_OUTPUT_DIR = OUT;

const comfy = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getQueue: vi.fn(async () => ({ queue_running: [], queue_pending: [] })),
  hasNode: vi.fn(async () => true),
  listFolder: vi.fn(async (folder: string) => {
    void folder;
    return [] as string[];
  }),
  queuePrompt: vi.fn(async () => ({ prompt_id: "11111111-1111-4111-8111-111111111111", number: 1, node_errors: {} })),
}));
vi.mock("@/lib/comfy/client", () => comfy);
vi.mock("@/lib/ollama/client", () => ({ unloadOllamaModels: vi.fn(async () => []) }));
vi.mock("@/lib/providers", () => ({ generateCloudImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }]) }));
vi.mock("@/lib/providers/keys", () => ({ PROVIDERS: ["openai", "anthropic", "gemini"] }));

type Core = typeof import("./generate-core");
let core: Core;
beforeAll(async () => {
  core = await import("./generate-core");
});
beforeEach(() => {
  comfy.getHistory.mockReset();
  comfy.getQueue.mockClear();
  comfy.hasNode.mockClear().mockResolvedValue(true);
  comfy.listFolder.mockClear().mockResolvedValue([]);
  comfy.queuePrompt.mockClear();
});

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return core.sanitizeRequest({
    model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
    textEncoders: ["qwen3vl_8b.safetensors"],
    vae: "qwen_vae.safetensors",
    prompt: "a test print",
    seed: 7,
    ...overrides,
  });
}

describe("queueUpscale", () => {
  it("names the upscale_models folder when nothing is installed", async () => {
    await expect(core.queueUpscale({ image: "a.png [output]" }, "c1")).rejects.toThrow(/upscale_models/);
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });

  it("queues the upscale graph with the first installed model by default", async () => {
    comfy.listFolder.mockResolvedValue(["4x-UltraSharp.pth", "other.pth"]);
    const { id, graph, model } = await core.queueUpscale({ image: "a.png [output]" }, "c1");
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
    expect(model).toBe("4x-UltraSharp.pth");
    const classes = Object.values(graph).map((n) => (n as { class_type: string }).class_type);
    expect(classes).toEqual(["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "SaveImage"]);
  });

  it("rejects a model that is not installed", async () => {
    comfy.listFolder.mockResolvedValue(["4x-UltraSharp.pth"]);
    await expect(core.queueUpscale({ image: "a.png", upscaleModel: "missing.pth" }, "c1")).rejects.toThrow(/not in ComfyUI's "upscale_models" folder/);
  });
});

describe("queueRemoveBackground", () => {
  it("requires the BiRefNet custom node", async () => {
    comfy.hasNode.mockResolvedValue(false);
    await expect(core.queueRemoveBackground({ image: "a.png" }, "c1")).rejects.toThrow(/requires the BiRefNet custom node/i);
  });

  it("names the background_removal folder when no model file is installed", async () => {
    await expect(core.queueRemoveBackground({ image: "a.png" }, "c1")).rejects.toThrow(/background_removal/);
  });

  it("prefers a birefnet-named model and queues the blueprint-shaped graph", async () => {
    comfy.listFolder.mockResolvedValue(["zzz.safetensors", "birefnet.safetensors"]);
    const { graph, model } = await core.queueRemoveBackground({ image: "a.png [output]" }, "c1");
    expect(model).toBe("birefnet.safetensors");
    const classes = Object.values(graph).map((n) => (n as { class_type: string }).class_type);
    expect(classes).toEqual(["LoadImage", "LoadBackgroundRemovalModel", "RemoveBackground", "InvertMask", "JoinImageWithAlpha", "SaveImage"]);
  });
});

describe("imageCapabilities", () => {
  it("reports what is installed", async () => {
    comfy.listFolder.mockImplementation(async (folder: string) => {
      if (folder === "upscale_models") return ["4x.pth"];
      if (folder === "controlnet") return ["Qwen-Image-InstantX-ControlNet-Inpainting.safetensors", "canny-lora.safetensors"];
      if (folder === "model_patches") return ["Z-Image-Turbo-Fun-Controlnet-Union.safetensors"];
      return [];
    });
    expect(await core.imageCapabilities()).toEqual({
      online: true,
      upscaleModels: ["4x.pth"],
      removeBackground: { node: true, models: [] },
      inpaint: { controlNets: ["Qwen-Image-InstantX-ControlNet-Inpainting.safetensors"] },
      controlnet: { node: true, patches: ["Z-Image-Turbo-Fun-Controlnet-Union.safetensors"] },
    });
  });

  it("degrades to offline when ComfyUI is unreachable", async () => {
    comfy.listFolder.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await core.imageCapabilities()).toEqual({
      online: false,
      upscaleModels: [],
      removeBackground: { node: false, models: [] },
      inpaint: { controlNets: [] },
      controlnet: { node: false, patches: [] },
    });
  });
});

describe("collectOutputs", () => {
  it("collects images, videos, audio, and VHS gifs with their kinds", () => {
    // Shapes as the vendored ComfyUI writes them: SaveImage → images, SaveVideo → images + animated, SaveAudio → audio, VHS → gifs.
    const outputs = core.collectOutputs({
      "9": { images: [{ filename: "render_00001_.png", subfolder: "safelight", type: "output" }] },
      "12": { images: [{ filename: "video_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] },
      "15": { audio: [{ filename: "song_00001_.flac", subfolder: "audio", type: "output" }] },
      "18": { gifs: [{ filename: "anim_00001_.webp", subfolder: "", type: "output" }] },
    });
    expect(outputs).toEqual([
      { filename: "render_00001_.png", subfolder: "safelight", type: "output", kind: "image" },
      { filename: "video_00001_.mp4", subfolder: "video", type: "output", kind: "video" },
      { filename: "song_00001_.flac", subfolder: "audio", type: "output", kind: "audio" },
      { filename: "anim_00001_.webp", subfolder: "", type: "output", kind: "video" },
    ]);
  });

  it("classifies by extension when a video or audio file arrives under the images key un-flagged", () => {
    const outputs = core.collectOutputs({
      "1": { images: [{ filename: "clip.webm", subfolder: "", type: "output" }, { filename: "voice.mp3", subfolder: "", type: "output" }] },
    });
    expect(outputs.map((o) => o.kind)).toEqual(["video", "audio"]);
  });

  it("jobStatus surfaces every output-bearing key, not just images", async () => {
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "3": { audio: [{ filename: "tune.flac", subfolder: "audio", type: "output" }] } },
    });
    const status = await core.jobStatus("some-id");
    expect(status.state).toBe("done");
    expect(status.outputs).toEqual([{ filename: "tune.flac", subfolder: "audio", type: "output", kind: "audio" }]);
  });
});

describe("queueLocal ControlNet gating", () => {
  const controlBody = {
    mode: "img2img" as const,
    model: { name: "z_image_turbo_bf16.safetensors", folder: "diffusion_models" as const },
    textEncoders: ["qwen_3_4b.safetensors"],
    vae: "ae.safetensors",
    prompt: "a poster",
    images: ["safelight/ref.png"],
    control: { type: "canny" as const, strength: 1 },
  };

  it("names the exact patch file to fetch when none is installed", async () => {
    await expect(core.queueLocal(core.sanitizeRequest(controlBody), "c1")).rejects.toThrow(/Z-Image-Turbo-Fun-Controlnet-Union\.safetensors.*model_patches/);
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });

  it("refuses a patch that does not fit the selected model", async () => {
    comfy.listFolder.mockImplementation(async (folder: string) => (folder === "model_patches" ? ["Qwen-Image-Fun-Controlnet-Union.safetensors"] : []));
    await expect(core.queueLocal(core.sanitizeRequest(controlBody), "c1")).rejects.toThrow(/does not fit|None of the installed/i);
  });

  it("resolves the fitting installed patch and queues the graph", async () => {
    comfy.listFolder.mockImplementation(async (folder: string) => (folder === "model_patches" ? ["Z-Image-Turbo-Fun-Controlnet-Union.safetensors"] : []));
    const { graph } = await core.queueLocal(core.sanitizeRequest(controlBody), "c1");
    const patch = Object.values(graph).find((n) => (n as { class_type: string }).class_type === "ModelPatchLoader");
    expect(patch?.inputs).toMatchObject({ name: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" });
  });

  it("requires the QwenImageDiffsynthControlnet node", async () => {
    comfy.hasNode.mockResolvedValue(false);
    await expect(core.queueLocal(core.sanitizeRequest(controlBody), "c1")).rejects.toThrow(/QwenImageDiffsynthControlnet/);
  });
});

describe("mask edits (inpaint / outpaint)", () => {
  /** Renders an image so its sidecar exists, the way mask edits find their model settings. */
  async function renderWithSidecar(filename: string) {
    await writeFile(path.join(OUT, "safelight", filename), "png");
    const { id } = await core.queueLocal(req({ seed: 99 }), "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename, subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);
    comfy.getHistory.mockReset();
    comfy.queuePrompt.mockClear();
    return `safelight/${filename} [output]`;
  }

  it("queueInpaint pulls model settings from the image's sidecar and records an inpaint sidecar", async () => {
    const image = await renderWithSidecar("to_inpaint.png");
    const { graph, id } = await core.queueInpaint({ mode: "inpaint", image, mask: "safelight/mask.png", prompt: "a red hat" }, "c1");
    const classes = Object.values(graph).map((n) => (n as { class_type: string }).class_type);
    expect(classes).toEqual(expect.arrayContaining(["SetLatentNoiseMask", "KSampler"]));
    expect(classes).not.toContain("ControlNetLoader"); // none installed in this mock

    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename: "inpainted.png", subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);
    const sidecar = JSON.parse(await readFile(path.join(OUT, "safelight", "inpainted.png.json"), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, mode: "inpaint", mask: "safelight/mask.png", prompt: "a red hat" });
  });

  it("queueInpaint uses an installed inpainting ControlNet", async () => {
    const image = await renderWithSidecar("to_inpaint_cn.png");
    comfy.listFolder.mockImplementation(async (folder: string) => (folder === "controlnet" ? ["Qwen-Image-InstantX-ControlNet-Inpainting.safetensors"] : []));
    const { graph, controlNet } = await core.queueInpaint({ mode: "inpaint", image, mask: "safelight/mask.png", prompt: "a red hat" }, "c1");
    expect(controlNet).toBe("Qwen-Image-InstantX-ControlNet-Inpainting.safetensors");
    expect(Object.values(graph).some((n) => (n as { class_type: string }).class_type === "ControlNetInpaintingAliMamaApply")).toBe(true);
  });

  it("queueOutpaint builds the pad graph and records an outpaint sidecar", async () => {
    const image = await renderWithSidecar("to_outpaint.png");
    const { graph, id } = await core.queueOutpaint({ mode: "outpaint", image, prompt: "rolling dunes", left: 256, right: 256 }, "c1");
    const pad = Object.values(graph).find((n) => (n as { class_type: string }).class_type === "ImagePadForOutpaint") as { inputs: Record<string, unknown> };
    expect(pad.inputs).toMatchObject({ left: 256, right: 256, top: 0, bottom: 0 });

    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename: "outpainted.png", subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);
    const sidecar = JSON.parse(await readFile(path.join(OUT, "safelight", "outpainted.png.json"), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, mode: "outpaint", prompt: "rolling dunes" });
  });

  it("explains itself when the image has no sidecar and no model is given", async () => {
    await expect(core.queueInpaint({ mode: "inpaint", image: "safelight/unknown.png [output]", mask: "m.png", prompt: "x" }, "c1")).rejects.toThrow(/no render settings sidecar/i);
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });

  it("accepts explicit model settings instead of a sidecar", async () => {
    const { graph } = await core.queueInpaint(
      {
        mode: "inpaint",
        image: "safelight/fresh.png",
        mask: "safelight/mask.png",
        prompt: "a hat",
        model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
        textEncoders: ["qwen3vl_8b.safetensors"],
        vae: "qwen_vae.safetensors",
      },
      "c1",
    );
    expect(Object.values(graph).some((n) => (n as { class_type: string }).class_type === "SetLatentNoiseMask")).toBe(true);
  });
});

describe("action sidecars (upscale / rmbg)", () => {
  it("queueUpscale records an upscale-mode sidecar beside the result", async () => {
    comfy.listFolder.mockResolvedValue(["4x-UltraSharp.pth"]);
    const { id } = await core.queueUpscale({ image: "safelight/base.png [output]" }, "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "4": { images: [{ filename: "upscaled.png", subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);
    const sidecar = JSON.parse(await readFile(path.join(OUT, "safelight", "upscaled.png.json"), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, mode: "upscale", model: { name: "4x-UltraSharp.pth", folder: "upscale_models" }, images: ["safelight/base.png [output]"] });
  });

  it("queueRemoveBackground records an rmbg-mode sidecar", async () => {
    comfy.listFolder.mockResolvedValue(["birefnet.safetensors"]);
    const { id } = await core.queueRemoveBackground({ image: "safelight/base.png [output]" }, "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "6": { images: [{ filename: "cutout.png", subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);
    const sidecar = JSON.parse(await readFile(path.join(OUT, "safelight", "cutout.png.json"), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, mode: "rmbg", model: { name: "birefnet.safetensors", folder: "background_removal" } });
  });
});

describe("sidecar wiring", () => {
  it("queueLocal + jobStatus(done) writes a sidecar beside every output", async () => {
    const request = req();
    const { id } = await core.queueLocal(request, "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename: "render_00001_.png", subfolder: "safelight", type: "output" }] } },
    });
    const status = await core.jobStatus(id);
    expect(status.state).toBe("done");
    const sidecar = JSON.parse(await readFile(path.join(OUT, "safelight", "render_00001_.png.json"), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, kind: "safelight-render", mode: "txt2img", seed: 7, prompt: "a test print", model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" } });
  });

  it("a failed sidecar write does not fail the job", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await core.queueLocal(req(), "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename: "escape.png", subfolder: "../outside", type: "output" }] } },
    });
    const status = await core.jobStatus(id);
    expect(status.state).toBe("done");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("runCloud writes the image and its sidecar", async () => {
    const request = req({ model: { name: "gpt-image-1", folder: "cloud", provider: "openai" }, textEncoders: [], vae: undefined });
    const [out] = await core.runCloud(request);
    const image = path.join(OUT, "cloud", out.filename);
    expect((await readFile(image)).length).toBe(3);
    expect(JSON.parse(await readFile(`${image}.json`, "utf8"))).toMatchObject({ v: 1, kind: "safelight-render", model: { provider: "openai" } });
  });

  it("requestFromSidecarRef rebuilds the request; vary swaps the seed", async () => {
    const dir = path.join(OUT, "safelight");
    const image = path.join(dir, "recreate_me.png");
    await writeFile(image, "png");
    const { id } = await core.queueLocal(req({ seed: 1234 }), "c1");
    comfy.getHistory.mockResolvedValue({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images: [{ filename: "recreate_me.png", subfolder: "safelight", type: "output" }] } },
    });
    await core.jobStatus(id);

    const recreated = await core.requestFromSidecarRef("safelight/recreate_me.png [output]", false);
    expect(recreated.seed).toBe(1234);
    expect(recreated.prompt).toBe("a test print");

    const varied = await core.requestFromSidecarRef("safelight/recreate_me.png [output]", true);
    expect(varied.seed).not.toBe(1234);
    expect(varied.prompt).toBe("a test print");
  });

  it("requestFromSidecarRef errors clearly when the sidecar is missing", async () => {
    await expect(core.requestFromSidecarRef("safelight/never_rendered.png [output]", false)).rejects.toThrow(/no render settings sidecar/i);
  });
});
