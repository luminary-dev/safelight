import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "./keys";
import { listCompatModels } from "./openai-compat";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCompatModels", () => {
  it.each<[ProviderId, string]>([
    ["mistral", "https://api.mistral.ai/v1/models"],
    ["deepseek", "https://api.deepseek.com/v1/models"],
    ["xai", "https://api.x.ai/v1/models"],
    ["together", "https://api.together.xyz/v1/models"],
    ["cerebras", "https://api.cerebras.ai/v1/models"],
    ["gateway", "https://ai-gateway.vercel.sh/v1/models"],
  ])("lists %s models with GET {base}/models and a Bearer header", async (provider, expectedUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listCompatModels(provider, "test-key");
    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, { headers: { authorization: "Bearer test-key" } });
  });

  it("prettifies ids for providers whose /models has no display name", async () => {
    const data = {
      data: [{ id: "mistral-large-latest" }, { id: "codestral-latest" }, { object: "model" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 })));

    const { chat, images } = await listCompatModels("mistral", "test-key");

    expect(images).toEqual([]);
    // Entries without an id are dropped.
    expect(chat.map((m) => m.id).sort()).toEqual(["codestral-latest", "mistral-large-latest"]);
    expect(chat.every((m) => m.provider === "mistral")).toBe(true);
    // Labels come from friendlyName, never the raw dashed id.
    for (const m of chat) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.label).not.toBe(m.id);
    }
  });

  it("uses Together's display_name and accepts the bare-array body shape", async () => {
    const data = [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", display_name: "Llama 3.3 70B Instruct Turbo" },
      { id: "deepseek-ai/DeepSeek-V3", display_name: "DeepSeek V3" },
      { id: "mystery/unnamed-model" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { chat } = await listCompatModels("together", "test-key");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.together.xyz/v1/models");
    expect(chat).toHaveLength(3);
    expect(chat.every((m) => m.provider === "together")).toBe(true);
    expect(chat.find((m) => m.id === "meta-llama/Llama-3.3-70B-Instruct-Turbo")?.label).toBe("Llama 3.3 70B Instruct Turbo");
    // A missing display_name falls back to the id.
    expect(chat.find((m) => m.id === "mystery/unnamed-model")?.label).toBe("mystery/unnamed-model");
    // Sorted by label.
    expect(chat.map((m) => m.label)).toEqual([...chat.map((m) => m.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("derives labels from ids for DeepSeek and xAI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }), { status: 200 })));
    const deepseek = await listCompatModels("deepseek", "sk-test");
    expect(deepseek.chat.map((m) => m.id).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(deepseek.chat.every((m) => m.provider === "deepseek" && m.label.length > 0)).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "grok-4" }, { id: "grok-3-mini" }] }), { status: 200 })));
    const xai = await listCompatModels("xai", "xai-test");
    expect(xai.chat.map((m) => m.id).sort()).toEqual(["grok-3-mini", "grok-4"]);
    expect(xai.chat.every((m) => m.provider === "xai" && m.label.length > 0)).toBe(true);
  });

  it("honours a custom base URL and strips a trailing slash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listCompatModels("mistral", "test-key", "https://gateway.example.com/mistral/v1/");
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example.com/mistral/v1/models");
  });

  it.each<[ProviderId, string]>([
    ["mistral", "Mistral answered 401."],
    ["deepseek", "DeepSeek answered 403."],
    ["xai", "xAI answered 500."],
    ["together", "Together answered 429."],
    ["cerebras", "Cerebras answered 401."],
    ["gateway", "AI Gateway answered 503."],
  ])("throws a readable error with the %s label on a bad status", async (provider, message) => {
    const status = Number(message.match(/(\d+)\.$/)![1]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));
    await expect(listCompatModels(provider, "bad-key")).rejects.toThrow(message);
  });
});
