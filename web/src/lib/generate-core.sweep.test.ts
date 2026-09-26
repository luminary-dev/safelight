import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "@/lib/comfy/types";

const comfy = vi.hoisted(() => ({ systemStats: vi.fn() }));
vi.mock("@/lib/comfy/client", () => comfy);

import { activationMarginBytes, deriveSweepSeed, estimateLocalFootprint, footprintVerdict, sanitizeRequest, sanitizeSweep, sweepPoints } from "./generate-core";

const GiB = 1024 ** 3;

function base(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return sanitizeRequest({
    model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" },
    prompt: "a test print",
    seed: 1000,
    batch: 4,
    cfg: 2,
    steps: 20,
    ...overrides,
  });
}

describe("sanitizeSweep", () => {
  it("clamps seed sweep counts into 2–9", () => {
    expect(sanitizeSweep({ kind: "seed", count: 4 })).toEqual({ kind: "seed", count: 4 });
    expect(sanitizeSweep({ kind: "seed", count: 1 })).toEqual({ kind: "seed", count: 2 });
    expect(sanitizeSweep({ kind: "seed", count: 40 })).toEqual({ kind: "seed", count: 9 });
  });

  it("parses parameter values, clamps them, and caps the list at 6", () => {
    expect(sanitizeSweep({ kind: "cfg", values: [1, "2.5", 99] })).toEqual({ kind: "cfg", values: [1, 2.5, 30] });
    expect(sanitizeSweep({ kind: "steps", values: [0, 10.4, 999] })).toEqual({ kind: "steps", values: [1, 10, 150] });
    const sweep = sanitizeSweep({ kind: "cfg", values: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(sweep.kind === "cfg" && sweep.values).toHaveLength(6);
  });

  it("rejects too-short value lists, unknown kinds, and junk", () => {
    expect(() => sanitizeSweep({ kind: "cfg", values: [1] })).toThrow(/2 to 6/);
    expect(() => sanitizeSweep({ kind: "cfg", values: ["x", null] })).toThrow(/2 to 6/);
    expect(() => sanitizeSweep({ kind: "lora" })).toThrow(/unsupported sweep kind/i);
    expect(() => sanitizeSweep("seed")).toThrow(/bad sweep/i);
    expect(() => sanitizeSweep(null)).toThrow(/bad sweep/i);
  });
});

describe("deriveSweepSeed", () => {
  it("keeps the base seed for point 0 so a locked seed stays reproducible", () => {
    expect(deriveSweepSeed(1234, 0)).toBe(1234);
  });

  it("derives distinct, deterministic, in-range seeds for the other points", () => {
    const seeds = Array.from({ length: 9 }, (_, i) => deriveSweepSeed(987654321, i));
    expect(new Set(seeds).size).toBe(9);
    for (const s of seeds) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(s)).toBe(true);
    }
    expect(Array.from({ length: 9 }, (_, i) => deriveSweepSeed(987654321, i))).toEqual(seeds);
  });
});

describe("sweepPoints", () => {
  it("fans a seed sweep out into N single-image requests with derived seeds", () => {
    const req = base();
    const points = sweepPoints(req, { kind: "seed", count: 5 });
    expect(points).toHaveLength(5);
    expect(points[0].req.seed).toBe(1000);
    expect(new Set(points.map((p) => p.req.seed)).size).toBe(5);
    for (const p of points) {
      expect(p.req.batch).toBe(1);
      expect(p.req.cfg).toBe(2);
      expect(p.value).toBe(p.req.seed);
      expect(p.label).toBe(`seed ${p.req.seed}`);
    }
  });

  it("fans a cfg sweep out with the base seed and one request per value", () => {
    const points = sweepPoints(base(), { kind: "cfg", values: [1, 2.5, 4] });
    expect(points.map((p) => p.req.cfg)).toEqual([1, 2.5, 4]);
    expect(points.every((p) => p.req.seed === 1000)).toBe(true);
    expect(points.map((p) => p.label)).toEqual(["cfg 1", "cfg 2.5", "cfg 4"]);
  });

  it("fans a steps sweep out without touching cfg", () => {
    const points = sweepPoints(base(), { kind: "steps", values: [10, 30] });
    expect(points.map((p) => p.req.steps)).toEqual([10, 30]);
    expect(points.every((p) => p.req.cfg === 2)).toBe(true);
  });
});

describe("activationMarginBytes", () => {
  it("grows super-linearly with resolution", () => {
    const w = 14.6 * GiB;
    const at512 = activationMarginBytes(512, 512, w);
    const at1024 = activationMarginBytes(1024, 1024, w);
    const at2048 = activationMarginBytes(2048, 2048, w);
    expect(at1024).toBeGreaterThan(at512);
    expect(at2048).toBeGreaterThan(at1024);
    // 4x the pixels must cost more than 4x the margin's variable part.
    expect(at2048 - 0.75 * GiB).toBeGreaterThan(4 * (at1024 - 0.75 * GiB) * 0.99);
  });

  it("grows with the size of the weights", () => {
    expect(activationMarginBytes(1024, 1024, 20 * GiB)).toBeGreaterThan(activationMarginBytes(1024, 1024, 10 * GiB));
  });
});

describe("footprintVerdict", () => {
  const champion = { modelBytes: 4.3 * GiB, textEncoderBytes: 8.7 * GiB, vaeBytes: 0.6 * GiB }; // ~13.6 GB of weights (the 20B stack)

  it("flags the calibrated swap point: the 20B stack at ≥896px on a 26 GB machine", () => {
    // With the OS and apps holding the rest, ~17 GB free is a generous idle state.
    const at896 = footprintVerdict({ ...champion, width: 896, height: 896 }, 17 * GiB, 0);
    expect(at896.willSwap).toBe(true);
    expect(at896.warning).toMatch(/GB needed/);
    expect(at896.warning).toMatch(/swap and slow dramatically/);
    const at640 = footprintVerdict({ ...champion, width: 640, height: 640 }, 17 * GiB, 0);
    expect(at640.willSwap).toBe(false);
    expect(at640.warning).toBeNull();
  });

  it("adds up weights and margin, and counts Ollama's resident bytes as freeable", () => {
    const v = footprintVerdict({ ...champion, width: 1024, height: 1024 }, 10 * GiB, 9 * GiB);
    expect(v.neededBytes).toBe(champion.modelBytes + champion.textEncoderBytes + champion.vaeBytes + v.marginBytes);
    expect(v.freeBytes).toBe(19 * GiB);
    expect(v.willSwap).toBe(true);
    expect(v.warning).toMatch(/unloading Ollama/i);
  });

  it("suggests a smaller size when one would fit", () => {
    const v = footprintVerdict({ ...champion, width: 2048, height: 2048 }, 19 * GiB, 0);
    expect(v.willSwap).toBe(true);
    expect(v.warning).toMatch(/consider \d+×\d+|consider a smaller size/);
  });

  it("never cries wolf when the model file was not found on disk", () => {
    const v = footprintVerdict({ modelBytes: 0, textEncoderBytes: 0, vaeBytes: 0, width: 4096, height: 4096 }, 1 * GiB, 0);
    expect(v.willSwap).toBe(false);
    expect(v.warning).toBeNull();
  });
});

describe("estimateLocalFootprint", () => {
  afterAll(() => {
    delete process.env.COMFY_EXTRA_MODEL_PATHS;
    vi.unstubAllGlobals();
  });

  it("stats the weights across the registered model paths and folds in free RAM plus Ollama", async () => {
    // A models tree shaped like the real extra_model_paths.yaml: a model-specific
    // bundle dir listed before the generic one, so the resolver must try both.
    const root = mkdtempSync(path.join(tmpdir(), "sl-models-"));
    mkdirSync(path.join(root, "bundle", "text_encoders"), { recursive: true });
    mkdirSync(path.join(root, "bundle", "vae"), { recursive: true });
    mkdirSync(path.join(root, "diffusion_models"), { recursive: true });
    writeFileSync(path.join(root, "bundle", "model.gguf"), Buffer.alloc(4096));
    writeFileSync(path.join(root, "bundle", "text_encoders", "te.safetensors"), Buffer.alloc(2048));
    writeFileSync(path.join(root, "bundle", "vae", "vae.safetensors"), Buffer.alloc(1024));
    const yaml = ["studio_models:", `  base_path: ${root}`, "  unet: |", "    bundle", "    diffusion_models", "  diffusion_models: |", "    bundle", "    diffusion_models", "  text_encoders: bundle/text_encoders", "  vae: bundle/vae", ""].join("\n");
    const yamlPath = path.join(root, "extra_model_paths.yaml");
    writeFileSync(yamlPath, yaml);
    process.env.COMFY_EXTRA_MODEL_PATHS = yamlPath;

    comfy.systemStats.mockResolvedValue({ system: { os: "darwin", ram_total: 26 * GiB, ram_free: 20 * GiB, comfyui_version: "0", pytorch_version: "0" }, devices: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [{ size: 123 }, { size: 77 }] }))),
    );

    const req = base({ model: { name: "model.gguf", folder: "unet_gguf" }, textEncoders: ["te.safetensors"], vae: "vae.safetensors", width: 512, height: 512 });
    const est = await estimateLocalFootprint(req);
    expect(est.modelBytes).toBe(4096);
    expect(est.textEncoderBytes).toBe(2048);
    expect(est.vaeBytes).toBe(1024);
    expect(est.ollamaResidentBytes).toBe(200);
    expect(est.freeBytes).toBe(20 * GiB + 200);
    expect(est.neededBytes).toBe(4096 + 2048 + 1024 + est.marginBytes);
    expect(est.willSwap).toBe(false);
    expect(est.warning).toBeNull();
    // A missing file counts as zero rather than failing the estimate.
    const missing = await estimateLocalFootprint(base({ model: { name: "nope.gguf", folder: "unet_gguf" } }));
    expect(missing.modelBytes).toBe(0);
    expect(missing.willSwap).toBe(false);
  });
});
