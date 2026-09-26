import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "@/lib/comfy/types";
import { readSidecar, sidecarForAction, sidecarForRequest, sidecarPath, sidecarSettings, sidecarToRequest, writeSidecar, type RenderSidecar } from "./sidecars";

const REQ: GenerateRequest = {
  mode: "img2img",
  model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
  textEncoders: ["qwen3vl_8b_int8.safetensors"],
  vae: "qwen_image_2.1_vae.safetensors",
  lora: { name: "style.safetensors", strength: 0.8 },
  prompt: "a linen shirt on a dune",
  negativePrompt: "blurry",
  width: 1024,
  height: 768,
  steps: 25,
  cfg: 1,
  seed: 42,
  sampler: "euler",
  scheduler: "simple",
  batch: 1,
  denoise: 0.7,
  images: ["safelight/ref.png"],
  refResolution: 1024,
  matchInputSize: true,
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sidecars-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sidecarForRequest", () => {
  it("produces the v1 contract shape", () => {
    const sc = sidecarForRequest(REQ, "2026-09-26T00:00:00.000Z");
    expect(sc).toEqual({
      v: 1,
      kind: "safelight-render",
      mode: "img2img",
      model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
      prompt: "a linen shirt on a dune",
      negativePrompt: "blurry",
      seed: 42,
      sampler: "euler",
      scheduler: "simple",
      steps: 25,
      cfg: 1,
      width: 1024,
      height: 768,
      denoise: 0.7,
      images: ["safelight/ref.png"],
      textEncoders: ["qwen3vl_8b_int8.safetensors"],
      vae: "qwen_image_2.1_vae.safetensors",
      lora: { name: "style.safetensors", strength: 0.8 },
      createdAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("omits vae and lora when absent, keeps provider when present", () => {
    const sc = sidecarForRequest({ ...REQ, vae: undefined, lora: null, model: { name: "gpt-image-1", folder: "cloud", provider: "openai" } });
    expect("vae" in sc).toBe(false);
    expect("lora" in sc).toBe(false);
    expect(sc.model).toEqual({ name: "gpt-image-1", folder: "cloud", provider: "openai" });
  });
});

describe("writeSidecar / readSidecar", () => {
  it("round-trips beside the image", async () => {
    const image = path.join(dir, "render.png");
    const sc = sidecarForRequest(REQ);
    expect(await writeSidecar(image, sc)).toBe(true);
    expect(JSON.parse(await readFile(`${image}.json`, "utf8"))).toEqual(sc);
    expect(await readSidecar(image)).toEqual(sc);
  });

  it("returns null for a missing file", async () => {
    expect(await readSidecar(path.join(dir, "nope.png"))).toBeNull();
  });

  it("returns null for garbage JSON", async () => {
    const image = path.join(dir, "garbage.png");
    await writeFile(`${image}.json`, "{not json at all", "utf8");
    expect(await readSidecar(image)).toBeNull();
  });

  it("returns null for valid JSON that is not a render sidecar", async () => {
    const image = path.join(dir, "foreign.png");
    await writeFile(`${image}.json`, JSON.stringify({ v: 1, kind: "something-else", hello: true }), "utf8");
    expect(await readSidecar(image)).toBeNull();
  });

  it("never throws when the write fails, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const image = path.join(dir, "no-such-dir", "render.png");
    expect(await writeSidecar(image, sidecarForRequest(REQ))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("sidecarPath appends .json to the image path", () => {
    expect(sidecarPath("/x/a.png")).toBe("/x/a.png.json");
  });
});

describe("sidecarToRequest", () => {
  const sc: RenderSidecar = sidecarForRequest(REQ);

  it("recreates the render exactly, seed included", () => {
    const req = sidecarToRequest(sc);
    expect(req).toMatchObject({ mode: "img2img", seed: 42, prompt: REQ.prompt, images: ["safelight/ref.png"], lora: { name: "style.safetensors", strength: 0.8 } });
  });

  it("vary keeps everything except the seed", () => {
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const req = sidecarToRequest(sc, true);
    rand.mockRestore();
    expect(req.seed).toBe(Math.floor(0.5 * Number.MAX_SAFE_INTEGER));
    expect(req.prompt).toBe(REQ.prompt);
    expect(req.steps).toBe(REQ.steps);
  });

  it("drops a lora that is not a {name, strength} choice", () => {
    expect(sidecarToRequest({ ...sc, lora: "weird-string" }).lora).toBeNull();
  });

  it("refuses an unknown model folder with a clear error", () => {
    expect(() => sidecarToRequest({ ...sc, model: { name: "x", folder: "not-a-folder" } })).toThrow(/unknown model folder/i);
  });
});

describe("v1 additive extension: action modes and mask", () => {
  it("records inpaint mode and the mask reference via extra", () => {
    const sc = sidecarForRequest(REQ, "2026-09-26T00:00:00.000Z", { mode: "inpaint", mask: "safelight/mask.png" });
    expect(sc.mode).toBe("inpaint");
    expect(sc.mask).toBe("safelight/mask.png");
  });

  it("round-trips an inpaint sidecar through the validator", async () => {
    const image = path.join(dir, "inpainted.png");
    const sc = sidecarForRequest(REQ, undefined, { mode: "inpaint", mask: "safelight/mask.png" });
    expect(await writeSidecar(image, sc)).toBe(true);
    expect(await readSidecar(image)).toEqual(sc);
  });

  it("sidecarForAction records the action model and source image", () => {
    const sc = sidecarForAction("upscale", { image: "safelight/base.png [output]", model: "4x-UltraSharp.pth", folder: "upscale_models" }, "2026-09-26T00:00:00.000Z");
    expect(sc).toMatchObject({ v: 1, kind: "safelight-render", mode: "upscale", model: { name: "4x-UltraSharp.pth", folder: "upscale_models" }, images: ["safelight/base.png [output]"] });
  });

  it("rejects a sidecar with an unknown mode", async () => {
    const image = path.join(dir, "future.png");
    await writeFile(`${image}.json`, JSON.stringify({ ...sidecarForRequest(REQ), mode: "hologram" }), "utf8");
    expect(await readSidecar(image)).toBeNull();
  });

  it("sidecarToRequest refuses action modes with a clear error", () => {
    expect(() => sidecarToRequest({ ...sidecarForRequest(REQ), mode: "upscale" })).toThrow(/cannot rerun/i);
    expect(() => sidecarToRequest({ ...sidecarForRequest(REQ), mode: "inpaint" })).toThrow(/cannot rerun/i);
  });

  it("sidecarSettings reuses the model stack for any mode", () => {
    const settings = sidecarSettings(sidecarForRequest(REQ, undefined, { mode: "inpaint", mask: "m.png" }));
    expect(settings).toMatchObject({ model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" }, steps: 25, vae: "qwen_image_2.1_vae.safetensors" });
    expect("mode" in settings).toBe(false);
  });
});
