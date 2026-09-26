import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOllama, type FakeOllama } from "@/test/fakes/ollama-server";

/**
 * /api/chat/models (TEST-BRIEF §8): Ollama tags including the tools/vision
 * capabilities from the fake's /api/show, and a clean offline shape. No cloud
 * keys exist in the sandbox, so the cloud catalog stays empty and off-network.
 */

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
  dir = await mkdtemp(path.join(tmpdir(), "sl-chat-models-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "OLLAMA_URL", ...PROVIDER_ENVS]) savedEnv.set(key, process.env[key]);
  for (const key of PROVIDER_ENVS) delete process.env[key];
  process.env.SAFELIGHT_DATA_DIR = dir;
  ollama = await startFakeOllama();
  process.env.OLLAMA_URL = ollama.url;
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  await ollama.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

interface Entry {
  provider: string;
  id: string;
  label: string;
  tags: string[];
  vision: boolean;
}

describe("GET /api/chat/models", () => {
  it("lists Ollama models with tools/vision tags taken from /api/show", async () => {
    ollama.setModels([
      { name: "qwen2.5:7b", capabilities: ["completion", "tools"], details: { parameter_size: "7.6B", quantization_level: "Q4_K_M" } },
      { name: "llava:13b", capabilities: ["completion", "vision"] },
      { name: "plain:3b", capabilities: ["completion"] },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ollamaUp: boolean; models: Entry[]; cloudErrors: Record<string, string> };
    expect(body.ollamaUp).toBe(true);
    expect(body.cloudErrors).toEqual({});
    const byId = new Map(body.models.map((m) => [m.id, m]));
    expect(byId.get("qwen2.5:7b")!.tags).toContain("tools");
    expect(byId.get("qwen2.5:7b")!.tags).toContain("Q4_K_M");
    expect(byId.get("llava:13b")!.vision).toBe(true);
    expect(byId.get("llava:13b")!.tags).toContain("vision");
    expect(byId.get("plain:3b")!.vision).toBe(false);
    expect(byId.get("plain:3b")!.tags).not.toContain("tools");
    expect(body.models.every((m) => m.provider === "ollama")).toBe(true);
  });

  it("reports ollamaUp:false with an empty list when Ollama is unreachable", async () => {
    await ollama.close();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ollamaUp: boolean; models: Entry[] };
    expect(body.ollamaUp).toBe(false);
    expect(body.models).toEqual([]);
  });
});
