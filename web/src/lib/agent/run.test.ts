import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import type { ChatTurn } from "@/lib/providers/types";
import { runAgent } from "./run";
import { DELEGATE_TOOL_NAME } from "./subagent";
import type { ToolContext } from "./tools";

/**
 * Loop-level tests for run.ts: sampling params reach each provider's request,
 * the notes/delegate merges gate correctly, and the image-usage hook prices on
 * the raw model id. Provider SDKs are stubbed; the request bodies are captured.
 */

const captured = vi.hoisted(() => ({
  openai: [] as Record<string, unknown>[],
  anthropic: [] as Record<string, unknown>[],
  gemini: [] as Record<string, unknown>[],
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          captured.openai.push(body);
          return { choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    };
  }
  return { default: MockOpenAI, toFile: () => undefined };
});

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: async (body: Record<string, unknown>) => {
        captured.anthropic.push(body);
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  }
  return { default: MockAnthropic };
});

vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    models = {
      generateContent: async (req: Record<string, unknown>) => {
        captured.gemini.push(req);
        return { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      },
    };
  }
  return { GoogleGenAI: MockGoogleGenAI, Modality: { TEXT: "TEXT", IMAGE: "IMAGE" } };
});

vi.mock("@/lib/providers/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/keys")>();
  return { ...actual, getKey: async () => "test-key", getProviderConfig: async () => ({ key: "test-key", baseUrl: "" }) };
});

const TURNS: ChatTurn[] = [{ role: "user", content: "hi" }];
const PARAMS = { temperature: 0.2, topP: 0.9, maxTokens: 512 };

let dir: string;
let ollamaBodies: Record<string, unknown>[];
let ollamaReplies: unknown[];

function ctxOf(overrides: Partial<ToolContext> = {}): ToolContext {
  return { clientId: "agent", emit: () => {}, ...overrides };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-run-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
  captured.openai.length = 0;
  captured.anthropic.length = 0;
  captured.gemini.length = 0;
  ollamaBodies = [];
  ollamaReplies = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    ollamaBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const reply = ollamaReplies.shift() ?? { message: { role: "assistant", content: "ok" } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function toolNamesOf(body: Record<string, unknown>): string[] {
  return (body.tools as { function: { name: string } }[]).map((t) => t.function.name);
}

describe("sampling params per runner", () => {
  it("openai-compat: temperature/top_p/max_completion_tokens only when set", async () => {
    await runAgent("openai", "gpt-5-mini", TURNS, ctxOf());
    expect(captured.openai[0]).not.toHaveProperty("temperature");
    expect(captured.openai[0]).not.toHaveProperty("top_p");
    expect(captured.openai[0]).not.toHaveProperty("max_completion_tokens");

    await runAgent("openai", "gpt-5-mini", TURNS, ctxOf({ params: PARAMS }));
    expect(captured.openai[1]).toMatchObject({ temperature: 0.2, top_p: 0.9, max_completion_tokens: 512 });

    await runAgent("openai", "gpt-5-mini", TURNS, ctxOf({ params: { topP: 0.5 } }));
    expect(captured.openai[2]).not.toHaveProperty("temperature");
    expect(captured.openai[2]).toMatchObject({ top_p: 0.5 });
  });

  it("anthropic: temperature/top_p when set, max_tokens replacing the 4000 default", async () => {
    await runAgent("anthropic", "claude-haiku-4-5", TURNS, ctxOf());
    expect(captured.anthropic[0]).toMatchObject({ max_tokens: 4000 });
    expect(captured.anthropic[0]).not.toHaveProperty("temperature");
    expect(captured.anthropic[0]).not.toHaveProperty("top_p");

    await runAgent("anthropic", "claude-haiku-4-5", TURNS, ctxOf({ params: PARAMS }));
    expect(captured.anthropic[1]).toMatchObject({ max_tokens: 512, temperature: 0.2, top_p: 0.9 });
  });

  it("gemini: generation config fields only when set", async () => {
    await runAgent("gemini", "gemini-3-flash", TURNS, ctxOf());
    const config0 = captured.gemini[0].config as Record<string, unknown>;
    expect(config0).not.toHaveProperty("temperature");
    expect(config0).not.toHaveProperty("topP");
    expect(config0).not.toHaveProperty("maxOutputTokens");

    await runAgent("gemini", "gemini-3-flash", TURNS, ctxOf({ params: PARAMS }));
    expect(captured.gemini[1].config).toMatchObject({ temperature: 0.2, topP: 0.9, maxOutputTokens: 512 });
  });

  it("ollama: options block only when set, with num_predict for maxTokens", async () => {
    await runAgent("ollama", "qwen2.5", TURNS, ctxOf());
    expect(ollamaBodies[0]).not.toHaveProperty("options");

    await runAgent("ollama", "qwen2.5", TURNS, ctxOf({ params: PARAMS }));
    expect(ollamaBodies[1].options).toEqual({ temperature: 0.2, top_p: 0.9, num_predict: 512 });
  });
});

describe("toolset merging (notes + delegate)", () => {
  const fakeToolset: NonNullable<ToolContext["toolset"]> = {
    defs: [{ name: "fake_tool", description: "x", parameters: {} }],
    execute: async () => ({ result: {} }),
  };
  const studioLikeToolset: NonNullable<ToolContext["toolset"]> = {
    defs: [{ name: "generate_image", description: "x", parameters: {} }],
    execute: async () => ({ result: {} }),
  };

  it("adds the notes tools to the default toolset only when projectId is set", async () => {
    await runAgent("ollama", "m", TURNS, ctxOf());
    expect(toolNamesOf(ollamaBodies[0])).not.toContain("read_project_notes");

    await runAgent("ollama", "m", TURNS, ctxOf({ projectId: "p1" }));
    const names = toolNamesOf(ollamaBodies[1]);
    expect(names).toContain("generate_image"); // default studio set is intact
    expect(names).toContain("read_project_notes");
    expect(names).toContain("append_project_note");
    expect(names).not.toContain(DELEGATE_TOOL_NAME); // studio never delegates to itself
  });

  it("adds notes and delegate_task to an override (non-studio) toolset", async () => {
    await runAgent("ollama", "m", TURNS, ctxOf({ clientId: "code", toolset: fakeToolset, projectId: "p1" }));
    const names = toolNamesOf(ollamaBodies[0]);
    expect(names).toEqual(["fake_tool", "read_project_notes", "append_project_note", DELEGATE_TOOL_NAME]);
  });

  it("withholds delegate_task from studio-shaped overrides and from sub-agent runs", async () => {
    await runAgent("ollama", "m", TURNS, ctxOf({ clientId: "agent", toolset: studioLikeToolset }));
    expect(toolNamesOf(ollamaBodies[0])).not.toContain(DELEGATE_TOOL_NAME);

    await runAgent("ollama", "m", TURNS, ctxOf({ clientId: "code:sub", toolset: fakeToolset }));
    expect(toolNamesOf(ollamaBodies[1])).not.toContain(DELEGATE_TOOL_NAME);
  });

  it("withholds the notes tools from every toolset when no projectId is set", async () => {
    await runAgent("ollama", "m", TURNS, ctxOf({ clientId: "code", toolset: fakeToolset }));
    const names = toolNamesOf(ollamaBodies[0]);
    expect(names).toEqual(["fake_tool", DELEGATE_TOOL_NAME]);
  });
});

describe("image usage pricing", () => {
  it("prices generate_image results on the raw modelId, not the friendly label", async () => {
    ollamaReplies.push(
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "generate_image", arguments: { prompt: "cube" } } }] } },
      { message: { role: "assistant", content: "done" } },
    );
    const toolset: NonNullable<ToolContext["toolset"]> = {
      defs: [{ name: "generate_image", description: "x", parameters: {} }],
      execute: async () => ({
        result: { images: ["cloud/openai_a_1.png"], seed: 1, model: "GPT Image 1 Mini", modelId: "gpt-image-1-mini" },
        images: [{ filename: "openai_a_1.png", subfolder: "cloud", type: "output" }],
      }),
    };
    await runAgent("ollama", "m", TURNS, ctxOf({ toolset }));

    const row = getDb().prepare("SELECT provider, model, images, cost FROM usage_events WHERE images > 0").get() as {
      provider: string;
      model: string;
      images: number;
      cost: number;
    };
    expect(row).toMatchObject({ provider: "openai", model: "gpt-image-1-mini", images: 1 });
    expect(row.cost).toBeCloseTo(0.011, 5); // resolves in the pricing table because it is the raw id
  });

  it("falls back to the friendly label when a result has no modelId", async () => {
    ollamaReplies.push(
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "generate_image", arguments: { prompt: "cube" } } }] } },
      { message: { role: "assistant", content: "done" } },
    );
    const toolset: NonNullable<ToolContext["toolset"]> = {
      defs: [{ name: "generate_image", description: "x", parameters: {} }],
      execute: async () => ({
        result: { images: ["cloud/openai_a_1.png"], seed: 1, model: "GPT Image 1 Mini" },
        images: [{ filename: "openai_a_1.png", subfolder: "cloud", type: "output" }],
      }),
    };
    await runAgent("ollama", "m", TURNS, ctxOf({ toolset }));
    const row = getDb().prepare("SELECT model FROM usage_events WHERE images > 0").get() as { model: string };
    expect(row.model).toBe("GPT Image 1 Mini");
  });
});
