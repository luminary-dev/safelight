import { afterEach, describe, expect, it, vi } from "vitest";
import { listOpenRouterModels } from "./openrouter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listOpenRouterModels", () => {
  it("parses the catalog, labels from the API name, and keeps everything", async () => {
    const data = {
      data: [
        { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5" },
        { id: "meta-llama/llama-3.3-70b-instruct", name: "Meta: Llama 3.3 70B Instruct" },
        { id: "mystery/no-name-model" },
        { name: "entry without an id is dropped" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { chat, images } = await listOpenRouterModels("sk-or-test");

    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", { headers: { authorization: "Bearer sk-or-test" } });
    expect(images).toEqual([]);
    expect(chat).toHaveLength(3);
    expect(chat.every((m) => m.provider === "openrouter")).toBe(true);
    expect(chat.find((m) => m.id === "anthropic/claude-sonnet-4.5")?.label).toBe("Anthropic: Claude Sonnet 4.5");
    // A missing name falls back to the id.
    expect(chat.find((m) => m.id === "mystery/no-name-model")?.label).toBe("mystery/no-name-model");
    // Sorted by label.
    expect(chat.map((m) => m.label)).toEqual([...chat.map((m) => m.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("does not cap a large catalog", async () => {
    const data = { data: Array.from({ length: 350 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}` })) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 })));
    const { chat } = await listOpenRouterModels("sk-or-test");
    expect(chat).toHaveLength(350);
  });

  it("honours a custom base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listOpenRouterModels("sk-or-test", "https://gateway.example.com/or/v1/");
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example.com/or/v1/models");
  });

  it("throws a readable error on a bad status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(listOpenRouterModels("sk-or-bad")).rejects.toThrow("OpenRouter answered 401.");
  });
});
