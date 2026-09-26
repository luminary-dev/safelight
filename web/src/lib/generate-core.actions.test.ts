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
    comfy.listFolder.mockImplementation(async (folder: string) => (folder === "upscale_models" ? ["4x.pth"] : []));
    expect(await core.imageCapabilities()).toEqual({ online: true, upscaleModels: ["4x.pth"], removeBackground: { node: true, models: [] } });
  });

  it("degrades to offline when ComfyUI is unreachable", async () => {
    comfy.listFolder.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await core.imageCapabilities()).toEqual({ online: false, upscaleModels: [], removeBackground: { node: false, models: [] } });
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
