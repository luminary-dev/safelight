import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * /api/models: the local catalog from the ComfyUI fake plus the cloud catalog
 * (empty here — no provider keys in the sandbox) (TEST-BRIEF §8). COMFY_URL is
 * captured at import time, so the fake starts before the route module loads.
 */

let comfy: FakeComfy;
let dir: string;
let GET: () => Promise<Response>;
const savedEnv = new Map<string, string | undefined>();
const PROVIDER_ENVS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "AI_GATEWAY_API_KEY",
];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-models-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "COMFY_URL", ...PROVIDER_ENVS]) savedEnv.set(key, process.env[key]);
  for (const key of PROVIDER_ENVS) delete process.env[key];
  process.env.SAFELIGHT_DATA_DIR = dir;
  comfy = await startFakeComfy();
  process.env.COMFY_URL = comfy.url;
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  await comfy.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

interface CatalogBody {
  models: { name: string; folder: string }[];
  textEncoders: string[];
  vaes: string[];
  loras: string[];
  samplers: string[];
  cloudErrors: Record<string, string>;
}

describe("GET /api/models", () => {
  it("falls back to an empty catalog while ComfyUI is down, without erroring", async () => {
    await comfy.close();
    try {
      const res = await GET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as CatalogBody;
      expect(body.models).toEqual([]); // no keys configured → no cloud models either
      expect(body.cloudErrors).toEqual({});
    } finally {
      await comfy.restart();
    }
  });

  it("returns the ComfyUI catalog with checkpoints, encoders, vaes and samplers", async () => {
    comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
    comfy.setFolder("unet_gguf", ["qwen-image-2.1-Q4_K_M.gguf"]);
    comfy.setObjectInfo("UnetLoaderGGUF", { input: { required: {} } });
    comfy.setFolder("text_encoders", ["qwen_2.5_vl_7b.safetensors"]);
    comfy.setFolder("vae", ["qwen_image_vae.safetensors"]);
    comfy.setFolder("loras", ["detail-tweaker.safetensors"]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as CatalogBody;
    expect(body.models.map((m) => m.name)).toEqual(expect.arrayContaining(["sd_xl_base_1.0.safetensors", "qwen-image-2.1-Q4_K_M.gguf"]));
    expect(body.models.find((m) => m.name.endsWith(".gguf"))!.folder).toBe("unet_gguf");
    expect(body.textEncoders).toContain("qwen_2.5_vl_7b.safetensors");
    expect(body.vaes).toContain("qwen_image_vae.safetensors");
    expect(body.loras).toContain("detail-tweaker.safetensors");
    expect(body.samplers).toContain("euler");
    expect(JSON.stringify(body)).not.toMatch(/sk-|api[_-]?key/i); // no secret shapes in the catalog
  });
});
