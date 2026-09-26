import { describe, expect, it } from "vitest";
import { sanitizeRequest } from "./generate-core";

const MODEL = { model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" as const } };

describe("sanitizeRequest", () => {
  it("requires a model", () => {
    expect(() => sanitizeRequest({})).toThrow(/pick a model/i);
  });

  it("fills defaults", () => {
    const r = sanitizeRequest(MODEL);
    expect(r).toMatchObject({ mode: "txt2img", width: 1024, height: 1024, steps: 25, cfg: 1, batch: 1, sampler: "euler", scheduler: "simple" });
  });

  it("clamps every numeric to its bounds", () => {
    const r = sanitizeRequest({ ...MODEL, width: 99999, height: 1, steps: 900, cfg: -5, seed: -1, batch: 99, denoise: 7, refResolution: 99999 });
    expect(r.width).toBe(4096);
    expect(r.height).toBe(256);
    expect(r.steps).toBe(150);
    expect(r.cfg).toBe(0);
    expect(r.seed).toBe(0);
    expect(r.batch).toBe(8);
    expect(r.denoise).toBe(1);
    expect(r.refResolution).toBe(4096);
  });

  it("rounds non-integer numerics and rejects non-numbers and NaN to defaults", () => {
    const r = sanitizeRequest({ ...MODEL, steps: 20.9, batch: "3" as unknown as number, width: NaN });
    expect(r.steps).toBe(21);
    expect(r.batch).toBe(1);
    expect(r.width).toBe(1024);
  });

  it("caps input images at 16 and stringifies entries", () => {
    const r = sanitizeRequest({ ...MODEL, images: Array.from({ length: 30 }, (_, i) => `safelight/${i}.png`) });
    expect(r.images).toHaveLength(16);
  });

  it("only accepts the two known modes", () => {
    expect(sanitizeRequest({ ...MODEL, mode: "img2img" }).mode).toBe("img2img");
    expect(sanitizeRequest({ ...MODEL, mode: "evil" as never }).mode).toBe("txt2img");
  });

  it("clamps control settings and rejects unknown control types", () => {
    const r = sanitizeRequest({ ...MODEL, control: { type: "canny", strength: 99, cannyLow: -1, cannyHigh: 5, patch: "union.safetensors" } });
    expect(r.control).toEqual({ type: "canny", strength: 2, cannyLow: 0, cannyHigh: 1, patch: "union.safetensors" });
    expect(sanitizeRequest({ ...MODEL, control: { type: "canny", strength: "x" as never } }).control?.strength).toBe(1);
    expect(sanitizeRequest({ ...MODEL, control: { type: "scribble" as never, strength: 1 } }).control).toBeNull();
    expect(sanitizeRequest({ ...MODEL }).control).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST-BRIEF §6 extensions: property-based sanitizeRequest, buildGraph
// invariants beyond the snapshots, and the stageLabel-sync test.

import fc from "fast-check";
import { buildGraph, buildInpaintGraph, buildOutpaintGraph, buildRemoveBackgroundGraph, buildUpscaleGraph, type Graph } from "./comfy/graph";
import type { GenerateRequest } from "./comfy/types";
import { stageLabel } from "./safelight-state";

/** Deterministic property runs: a fixed seed, so a failure reproduces byte-for-byte. */
const FC = { seed: 20260926, numRuns: 300 };

const FIELDS = [
  "mode",
  "textEncoders",
  "vae",
  "lora",
  "prompt",
  "negativePrompt",
  "width",
  "height",
  "steps",
  "cfg",
  "seed",
  "sampler",
  "scheduler",
  "batch",
  "denoise",
  "images",
  "refResolution",
  "matchInputSize",
  "control",
] as const;

const garbageBody = fc.dictionary(fc.constantFrom(...FIELDS), fc.anything());

function assertInIntRange(name: string, v: number, lo: number, hi: number) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} escaped its clamp: ${v} not an integer in [${lo}, ${hi}]`);
}

function assertInFloatRange(name: string, v: number, lo: number, hi: number) {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} escaped its clamp: ${v} not in [${lo}, ${hi}]`);
}

describe("sanitizeRequest properties (fast-check)", () => {
  it("never throws on arbitrary garbage when a model is present, and every numeric lands inside its clamp", () => {
    fc.assert(
      fc.property(garbageBody, (body) => {
        const r = sanitizeRequest({ ...(body as Partial<GenerateRequest>), ...MODEL });
        assertInIntRange("width", r.width, 256, 4096);
        assertInIntRange("height", r.height, 256, 4096);
        assertInIntRange("steps", r.steps, 1, 150);
        assertInFloatRange("cfg", r.cfg, 0, 30);
        assertInIntRange("seed", r.seed, 0, Number.MAX_SAFE_INTEGER);
        assertInIntRange("batch", r.batch, 1, 8);
        assertInFloatRange("denoise", r.denoise, 0, 1);
        assertInIntRange("refResolution", r.refResolution, 0, 4096);
        if (r.lora) assertInFloatRange("lora.strength", r.lora.strength, -5, 5);
        if (r.control) {
          assertInFloatRange("control.strength", r.control.strength, 0, 2);
          assertInFloatRange("control.cannyLow", r.control.cannyLow ?? 0, 0, 0.99);
          assertInFloatRange("control.cannyHigh", r.control.cannyHigh ?? 0.01, 0.01, 1);
          if (!["canny", "depth", "pose"].includes(r.control.type)) throw new Error(`control.type leaked through: ${r.control.type}`);
        }
        if (!["txt2img", "img2img"].includes(r.mode)) throw new Error(`mode leaked through: ${r.mode}`);
        if (r.images.length > 16 || r.images.some((i) => typeof i !== "string")) throw new Error("images escaped the cap or kept non-strings");
        if (r.textEncoders.some((t) => typeof t !== "string")) throw new Error("textEncoders kept non-strings");
        if (typeof r.prompt !== "string" || typeof r.negativePrompt !== "string" || typeof r.sampler !== "string" || typeof r.scheduler !== "string") {
          throw new Error("string fields were not stringified");
        }
        if (typeof r.matchInputSize !== "boolean") throw new Error("matchInputSize is not a boolean");
      }),
      FC,
    );
  });

  it("throws ONLY the missing-model error when the model is absent or incomplete", () => {
    const brokenModel = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}),
      fc.constant({ name: "" }),
      fc.constant({ name: "x" }),
      fc.constant({ folder: "checkpoints" }),
      fc.constant({ name: "", folder: "checkpoints" }),
    );
    fc.assert(
      fc.property(garbageBody, brokenModel, (body, model) => {
        expect(() => sanitizeRequest({ ...(body as Partial<GenerateRequest>), model: model as GenerateRequest["model"] })).toThrow("Pick a model first.");
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// buildGraph invariants — checked structurally on every family and variant

const QWEN_BASE = {
  model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" as const },
  textEncoders: ["qwen3vl_8b.safetensors"],
  vae: "qwen_image_2.1_vae.safetensors",
  prompt: "a test print",
  seed: 12345,
};

/** Every named generate request the builders accept, sanitized like the routes do. */
const GENERATE_CASES: [string, GenerateRequest][] = [
  ["qwen txt2img", sanitizeRequest({ ...QWEN_BASE })],
  ["qwen txt2img with LoRA", sanitizeRequest({ ...QWEN_BASE, lora: { name: "detail.safetensors", strength: 0.8 } })],
  ["qwen img2img, two refs, batch 3", sanitizeRequest({ ...QWEN_BASE, mode: "img2img", images: ["safelight/a.png", "safelight/b.png"], batch: 3 })],
  ["qwen img2img, requested canvas", sanitizeRequest({ ...QWEN_BASE, mode: "img2img", images: ["safelight/a.png"], matchInputSize: false })],
  [
    "flux txt2img",
    sanitizeRequest({
      ...QWEN_BASE,
      model: { name: "flux1-dev-Q8_0.gguf", folder: "unet_gguf" },
      textEncoders: ["t5xxl_fp16.safetensors", "clip_l.safetensors"],
      vae: "ae.safetensors",
    }),
  ],
  [
    "sd15 diffusion img2img",
    sanitizeRequest({
      ...QWEN_BASE,
      model: { name: "sd15_photorealistic.safetensors", folder: "diffusion_models" },
      textEncoders: ["clip_l.safetensors"],
      vae: "vae-ft-mse.safetensors",
      mode: "img2img",
      images: ["safelight/a.png"],
      batch: 2,
    }),
  ],
  ["checkpoint txt2img with LoRA", sanitizeRequest({ ...QWEN_BASE, model: { name: "sd_xl_base_1.0.safetensors", folder: "checkpoints" }, textEncoders: [], vae: undefined, lora: { name: "lcm.safetensors", strength: 1 } })],
  [
    "controlnet canny (z-image)",
    sanitizeRequest({
      ...QWEN_BASE,
      model: { name: "z-image-turbo_fp8.safetensors", folder: "diffusion_models" },
      textEncoders: ["lumina2_te.safetensors"],
      vae: "z_vae.safetensors",
      mode: "img2img",
      images: ["safelight/ref.png"],
      control: { type: "canny", strength: 1, patch: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" },
    }),
  ],
  [
    "controlnet pose (qwen)",
    sanitizeRequest({
      ...QWEN_BASE,
      mode: "img2img",
      images: ["safelight/ref.png"],
      control: { type: "pose", strength: 1.5, patch: "Qwen-Fun-Controlnet-Union.safetensors" },
    }),
  ],
];

const MASK_REQ = sanitizeRequest({ ...QWEN_BASE, mode: "img2img", images: ["safelight/a.png"] });

/** Graphs from every builder, for the invariants that apply to all of them. */
const ALL_GRAPHS: [string, Graph][] = [
  ...GENERATE_CASES.map(([label, req]): [string, Graph] => [label, buildGraph(req)]),
  ["inpaint", buildInpaintGraph(MASK_REQ, { mask: "safelight/mask.png", maskExpand: 8, maskBlur: 8, controlNet: "inpaint_cn.safetensors" })],
  ["outpaint", buildOutpaintGraph(MASK_REQ, { left: 128, top: 0, right: 128, bottom: 0, feathering: 24, controlNet: "inpaint_cn.safetensors" })],
  ["upscale", buildUpscaleGraph({ image: "a.png [output]", upscaleModel: "4x-UltraSharp.pth" })],
  ["remove background", buildRemoveBackgroundGraph({ image: "a.png [output]", model: "birefnet.safetensors" })],
];

function nodesOf(graph: Graph, classType: string) {
  return Object.entries(graph).filter(([, n]) => n.class_type === classType);
}

describe("buildGraph invariants", () => {
  it.each(ALL_GRAPHS)("%s: every input reference points at an existing node", (_label, graph) => {
    expect(graph).toMatchGraphShape();
  });

  it.each(ALL_GRAPHS)("%s: exactly one SaveImage", (_label, graph) => {
    expect(nodesOf(graph, "SaveImage")).toHaveLength(1);
  });

  it.each(GENERATE_CASES)("%s: the request seed reaches the sampler", (_label, req) => {
    const graph = buildGraph(req);
    const samplers = nodesOf(graph, "KSampler");
    expect(samplers).toHaveLength(1);
    expect(samplers[0][1].inputs.seed).toBe(req.seed);
    expect(samplers[0][1].inputs.seed).toBe(12345);
  });

  it("the LoRA sits between the loader and the sampler (diffusion path)", () => {
    const req = GENERATE_CASES.find(([l]) => l === "qwen txt2img with LoRA")![1];
    const graph = buildGraph(req);
    const [, sampler] = nodesOf(graph, "KSampler")[0];
    const [loraId, lora] = nodesOf(graph, "LoraLoaderModelOnly")[0];
    expect(sampler.inputs.model).toEqual([loraId, 0]);
    const [loaderId] = nodesOf(graph, "UnetLoaderGGUF")[0];
    expect(lora.inputs.model).toEqual([loaderId, 0]);
    expect(lora.inputs).toMatchObject({ lora_name: "detail.safetensors", strength_model: 0.8 });
  });

  it("the LoRA sits between the loader and the sampler (checkpoint path, model AND clip)", () => {
    const req = GENERATE_CASES.find(([l]) => l === "checkpoint txt2img with LoRA")![1];
    const graph = buildGraph(req);
    const [, sampler] = nodesOf(graph, "KSampler")[0];
    const [loraId, lora] = nodesOf(graph, "LoraLoader")[0];
    expect(sampler.inputs.model).toEqual([loraId, 0]);
    const [ckptId] = nodesOf(graph, "CheckpointLoaderSimple")[0];
    expect(lora.inputs.model).toEqual([ckptId, 0]);
    // Text encoding must run through the LoRA-patched clip, not the raw checkpoint clip.
    for (const [, encode] of nodesOf(graph, "CLIPTextEncode")) expect(encode.inputs.clip).toEqual([loraId, 1]);
  });

  it("without a LoRA the sampler takes the loader's model directly", () => {
    const graph = buildGraph(GENERATE_CASES[0][1]);
    const [, sampler] = nodesOf(graph, "KSampler")[0];
    const [loaderId] = nodesOf(graph, "UnetLoaderGGUF")[0];
    expect(sampler.inputs.model).toEqual([loaderId, 0]);
    expect(nodesOf(graph, "LoraLoaderModelOnly")).toHaveLength(0);
  });

  it("every class_type the builders can emit has a non-default stageLabel (the two stay in sync)", () => {
    const classTypes = new Set<string>();
    for (const [, graph] of ALL_GRAPHS) for (const node of Object.values(graph)) classTypes.add(node.class_type);
    expect(classTypes.size).toBeGreaterThan(20); // the matrix really does cover the builders
    const unlabeled = [...classTypes].filter((ct) => stageLabel(ct) === "Preparing").sort();
    expect(unlabeled, `stageLabel falls back to "Preparing" for: ${unlabeled.join(", ")} — add cases to stageLabel in safelight-state.ts`).toEqual([]);
  });
});
