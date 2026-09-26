import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";
import { startFakeOllama, type FakeOllama } from "@/test/fakes/ollama-server";

/**
 * /api/health (TEST-BRIEF §8): the additive shape with both backends up and
 * both down — always 200, original fields intact, no key material. COMFY_URL
 * and OLLAMA_URL are captured at import time, so both fakes start first.
 */

let comfy: FakeComfy;
let ollama: FakeOllama;
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
  dir = await mkdtemp(path.join(tmpdir(), "sl-health-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "COMFY_URL", "OLLAMA_URL", "COMFY_OUTPUT_DIR", "COMFY_INPUT_DIR", ...PROVIDER_ENVS]) savedEnv.set(key, process.env[key]);
  for (const key of PROVIDER_ENVS) delete process.env[key];
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  process.env.COMFY_OUTPUT_DIR = path.join(dir, "outputs");
  process.env.COMFY_INPUT_DIR = path.join(dir, "inputs");
  mkdirSync(path.join(dir, "outputs"), { recursive: true });
  comfy = await startFakeComfy();
  ollama = await startFakeOllama();
  process.env.COMFY_URL = comfy.url;
  process.env.OLLAMA_URL = ollama.url;
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  await comfy.close();
  await ollama.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

interface Health {
  up: boolean;
  url: string;
  stats?: unknown;
  ollama: { up: boolean; url: string; models: { name: string; sizeBytes: number }[] };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  providers: { provider: string; configured: boolean; reachable: boolean }[];
}

describe("GET /api/health", () => {
  it("reports both backends up, with stats, resident models, disk and providers", async () => {
    ollama.setResident(["llama3:8b"]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.up).toBe(true);
    expect(body.url).toBe(comfy.url);
    expect(body.stats).toBeTruthy();
    expect(body.ollama).toMatchObject({ up: true, url: ollama.url });
    expect(body.ollama.models.map((m) => m.name)).toEqual(["llama3:8b"]);
    expect(body.disk?.path).toBe(path.join(dir, "outputs"));
    expect(body.disk!.freeBytes).toBeGreaterThan(0);
    expect(body.providers).toHaveLength(11);
    expect(body.providers.every((p) => p.configured === false && p.reachable === false)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/sk-|gsk_|AIza/);
  });

  it("stays 200 with the same shape when both backends are down", async () => {
    await comfy.close();
    await ollama.close();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.up).toBe(false);
    expect(body.url).toBe(comfy.url);
    expect(body.ollama).toMatchObject({ up: false, models: [] });
    expect(body.providers).toHaveLength(11);
  });
});
