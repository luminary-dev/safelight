import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listAnthropicModels, streamAnthropicChat } from "@/lib/providers/anthropic";
import { generateGeminiImages, listGeminiModels, streamGeminiChat } from "@/lib/providers/gemini";
import { listGroqModels } from "@/lib/providers/groq";
import { generateOpenAIImages, listOpenAIModels, streamOpenAIChat } from "@/lib/providers/openai";
import { listCompatModels, streamCompatChat } from "@/lib/providers/openai-compat";
import { listOpenRouterModels } from "@/lib/providers/openrouter";
import { readStreamText as readAll } from "../fakes/http";
import { createProviderMsw } from "./providers";

/**
 * Proves the fixtures speak each SDK's wire format by driving the REAL
 * adapters in src/lib/providers/* against MSW. If an SDK upgrade changes how
 * a shape parses, these fail — that is the fixtures' job (TEST-BRIEF §5).
 */

const msw = createProviderMsw({ compatBaseUrl: "https://llm.internal.example/v1" });

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => msw.reset());
afterAll(() => msw.server.close());

/** Collects the SSE data payloads of a raw streaming endpoint. */
async function sseData(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((d) => d && d !== "[DONE]");
}

describe("OpenAI handlers through the real adapter", () => {
  it("lists models: chat filtered of snapshots/audio/legacy, images split with edit flags", async () => {
    const { chat, images } = await listOpenAIModels("sk-test");
    expect(chat.map((m) => m.id)).toEqual(["gpt-4.1", "gpt-4o", "o3"]);
    expect(images).toEqual([
      { provider: "openai", id: "dall-e-3", label: "dall-e-3", edit: false },
      { provider: "openai", id: "gpt-image-1", label: "gpt-image-1", edit: true },
    ]);
  });

  it("streams text deltas", async () => {
    msw.script("openai", { chatDeltas: ["Sea", " glass"] });
    expect(await readAll(await streamOpenAIChat("sk-test", "gpt-4o", [{ role: "user", content: "hi" }]))).toBe("Sea glass");
  });

  it("streams a tool call whose fragments reassemble into the scripted args", async () => {
    msw.script("openai", { toolCall: { name: "generate_image", args: { prompt: "a lighthouse", count: 2 } } });
    const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
    const chunks = (await sseData(res)).map((d) => JSON.parse(d) as { choices: { delta: { tool_calls?: { function: { name?: string; arguments: string } }[] }; finish_reason: string | null }[] });
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    expect(calls[0].function.name).toBe("generate_image");
    expect(JSON.parse(calls.map((c) => c.function.arguments).join(""))).toEqual({ prompt: "a lighthouse", count: 2 });
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns decodable image bytes", async () => {
    const images = await generateOpenAIImages("sk-test", "gpt-image-1", { prompt: "x", width: 1024, height: 1024, count: 1, images: [] });
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/png");
    // PNG magic bytes prove the b64 payload decodes to a real image header.
    expect([...images[0].bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("answers a scripted 401 / 429-with-Retry-After / 500 on the raw wire", async () => {
    for (const status of [401, 429, 500] as const) {
      msw.script("openai", { chatError: { status, retryAfter: status === 429 ? 7 : undefined } });
      const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
      expect(res.status).toBe(status);
      if (status === 429) expect(res.headers.get("retry-after")).toBe("7");
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain(String(status));
    }
  });
});

describe("Anthropic handlers through the real adapter", () => {
  it("lists models with display names", async () => {
    const models = await listAnthropicModels("sk-ant-test");
    expect(models[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" });
    expect(models).toHaveLength(3);
  });

  it("streams text deltas through the SDK's event protocol", async () => {
    msw.script("anthropic", { chatDeltas: ["Hi", " there"] });
    expect(await readAll(await streamAnthropicChat("sk-ant-test", "claude-sonnet-4-5", [{ role: "user", content: "hi" }]))).toBe("Hi there");
  });

  it("streams a tool_use block with input_json_delta fragments on the raw wire", async () => {
    msw.script("anthropic", { toolCall: { name: "edit_image", args: { instruction: "make it dusk" } } });
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    const events = (await res.text()).split("\n\n").filter(Boolean);
    const types = events.map((e) => /event: (\S+)/.exec(e)?.[1]);
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    const partials = events
      .filter((e) => e.includes("input_json_delta"))
      .map((e) => (JSON.parse(e.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as { delta: { partial_json: string } }).delta.partial_json);
    expect(JSON.parse(partials.join(""))).toEqual({ instruction: "make it dusk" });
  });

  it("maps a scripted 401 into the adapter's in-stream error text", async () => {
    msw.script("anthropic", { chatError: { status: 401 } });
    const text = await readAll(await streamAnthropicChat("sk-ant-test", "claude-sonnet-4-5", [{ role: "user", content: "hi" }]));
    expect(text).toMatch(/\[401: .*\]/);
  });
});

describe("Gemini handlers through the real adapter", () => {
  it("splits chat and image models, dropping non-gemini and non-chat entries", async () => {
    const { chat, images } = await listGeminiModels("AIza-test");
    expect(chat).toEqual([{ provider: "gemini", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
    expect(images).toEqual([{ provider: "gemini", id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", edit: true }]);
  });

  it("streams text deltas", async () => {
    msw.script("gemini", { chatDeltas: ["One", " two"] });
    expect(await readAll(await streamGeminiChat("AIza-test", "gemini-2.5-pro", [{ role: "user", content: "hi" }]))).toBe("One two");
  });

  it("returns a generated image from inlineData", async () => {
    const images = await generateGeminiImages("AIza-test", "gemini-2.5-flash-image", { prompt: "x", width: 1024, height: 1024, count: 1, images: [] });
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/png");
    expect([...images[0].bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("OpenAI-compatible handlers (Groq, OpenRouter, generic shim)", () => {
  it("Groq: ids only, labels derived (friendlyName), sorted by label", async () => {
    const { chat } = await listGroqModels("gsk-test");
    expect(chat.map((m) => m.id)).toContain("llama-3.3-70b-versatile");
    const labels = chat.map((m) => m.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("OpenRouter: uses the API's human-written name as the label", async () => {
    const { chat } = await listOpenRouterModels("sk-or-test");
    expect(chat.find((m) => m.id === "anthropic/claude-sonnet-4.5")?.label).toBe("Anthropic: Claude Sonnet 4.5");
  });

  it("the generic shim streams for any custom base URL", async () => {
    msw.script("compat", { chatDeltas: ["local ", "model"] });
    const { chat } = await listCompatModels("gateway", "key", "https://llm.internal.example/v1");
    expect(chat.length).toBeGreaterThan(0);
    const text = await readAll(await streamCompatChat("gateway", "key", "m", [{ role: "user", content: "hi" }], undefined, undefined, "https://llm.internal.example/v1"));
    expect(text).toBe("local model");
  });

  it("compat providers surface scripted model-list errors with the provider label", async () => {
    msw.script("groq", { modelsError: { status: 500 } });
    await expect(listGroqModels("gsk-test")).rejects.toThrow(/Groq answered 500/);
  });
});
