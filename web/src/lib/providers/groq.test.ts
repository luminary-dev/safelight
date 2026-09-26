import { afterEach, describe, expect, it, vi } from "vitest";
import { listGroqModels } from "./groq";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listGroqModels", () => {
  it("parses the catalog and derives friendly labels from ids", async () => {
    const data = {
      data: [
        { id: "llama-3.3-70b-versatile", object: "model" },
        { id: "gemma2-9b-it", object: "model" },
        { id: "whisper-large-v3", object: "model" },
        { object: "model" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { chat, images } = await listGroqModels("gsk_test");

    expect(fetchMock).toHaveBeenCalledWith("https://api.groq.com/openai/v1/models", { headers: { authorization: "Bearer gsk_test" } });
    expect(images).toEqual([]);
    // All ids are included (entries without an id are dropped).
    expect(chat.map((m) => m.id).sort()).toEqual(["gemma2-9b-it", "llama-3.3-70b-versatile", "whisper-large-v3"]);
    expect(chat.every((m) => m.provider === "groq")).toBe(true);
    // Labels are prettified, never the raw id with dashes.
    const llama = chat.find((m) => m.id === "llama-3.3-70b-versatile")!;
    expect(llama.label.length).toBeGreaterThan(0);
    expect(llama.label).not.toBe(llama.id);
  });

  it("honours a custom base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listGroqModels("gsk_test", "https://gateway.example.com/groq/v1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example.com/groq/v1/models");
  });

  it("throws a readable error on a bad status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));
    await expect(listGroqModels("gsk_bad")).rejects.toThrow("Groq answered 403.");
  });
});
