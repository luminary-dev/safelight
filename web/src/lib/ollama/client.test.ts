import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStreamText as readAll } from "@/test/fakes/http";
import { startFakeOllama, type FakeOllama } from "@/test/fakes/ollama-server";

/**
 * lib/ollama/client.ts against the fake Ollama server (TEST-BRIEF §6):
 * tag listing, per-model capability fetch and its cache, capability failure
 * degrading to [], NDJSON stream reassembly across chunk boundaries, the
 * mid-stream error line, a truncated stream, and unloadOllamaModels'
 * best-effort contract when /api/ps is down.
 */

let ollama: FakeOllama;

/** OLLAMA_URL is read at module load, so every test imports a fresh client pointed at the fake. */
async function clientAt(url: string) {
  vi.resetModules();
  vi.stubEnv("OLLAMA_URL", url);
  return import("./client");
}

beforeEach(async () => {
  ollama = await startFakeOllama();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await ollama.close();
});

describe("listOllamaModels", () => {
  it("returns tags with size and details, and fetches capabilities per model from /api/show", async () => {
    ollama.setModels([
      { name: "llava:13b", size: 8_000_000_000, details: { parameter_size: "13B", family: "llama" }, capabilities: ["completion", "vision"] },
      { name: "qwen3:8b", capabilities: ["completion", "tools"] },
    ]);
    const { listOllamaModels } = await clientAt(ollama.url);
    const models = await listOllamaModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ name: "llava:13b", size: 8_000_000_000, details: { parameter_size: "13B" }, capabilities: ["completion", "vision"] });
    expect(models[1].capabilities).toEqual(["completion", "tools"]);
  });

  it("throws with the status when /api/tags itself fails", async () => {
    const { listOllamaModels } = await clientAt(ollama.url);
    await ollama.close();
    await expect(listOllamaModels()).rejects.toThrow();
  });

  it("caches capabilities per model name: a second listing never re-asks /api/show", async () => {
    ollama.setModels([{ name: "qwen3:8b", capabilities: ["completion", "tools"] }]);
    const client = await clientAt(ollama.url);
    await client.listOllamaModels();

    // Same name, different capabilities on the server: the cache must win.
    ollama.setModels([
      { name: "qwen3:8b", capabilities: ["completion"] },
      { name: "new:1b", capabilities: ["completion", "vision"] },
    ]);
    const models = await client.listOllamaModels();
    expect(models.find((m) => m.name === "qwen3:8b")!.capabilities).toEqual(["completion", "tools"]); // cached
    expect(models.find((m) => m.name === "new:1b")!.capabilities).toEqual(["completion", "vision"]); // fetched fresh
  });

  it("a failing capability fetch degrades that model to [] instead of failing the listing", async () => {
    ollama.setModels([{ name: "qwen3:8b", capabilities: ["completion", "tools"] }]);
    const client = await clientAt(ollama.url);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/show")) return Promise.reject(new Error("show exploded"));
      return realFetch(input, init);
    });
    const models = await client.listOllamaModels();
    expect(models).toHaveLength(1);
    expect(models[0].capabilities).toEqual([]);
  });

  it("a failed capability fetch is not cached: the next listing retries and succeeds", async () => {
    ollama.setModels([{ name: "qwen3:8b", capabilities: ["completion", "tools"] }]);
    const client = await clientAt(ollama.url);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/show")) return Promise.reject(new Error("show exploded"));
      return realFetch(input, init);
    });
    await client.listOllamaModels();
    vi.unstubAllGlobals();
    const models = await client.listOllamaModels();
    expect(models[0].capabilities).toEqual(["completion", "tools"]);
  });
});

describe("streamChat", () => {
  it("reassembles NDJSON deltas split mid-line and mid-UTF-8-character (chunkBytes 3)", async () => {
    // "héllo 🌊" spans multi-byte sequences, so 3-byte chunks split both JSON lines and characters.
    ollama.scriptChat(["hé", "llo ", "🌊"], { chunkBytes: 3 });
    const { streamChat } = await clientAt(ollama.url);
    const text = await readAll(await streamChat("qwen3:8b", [{ role: "user", content: "hi" }]));
    expect(text).toBe("héllo 🌊");
  });

  it("sends model, messages, and stream: true on the wire", async () => {
    ollama.scriptChat(["ok"]);
    const { streamChat } = await clientAt(ollama.url);
    await readAll(await streamChat("qwen3:8b", [{ role: "system", content: "be brief" }, { role: "user", content: "hi", images: ["aGk="] }]));
    expect(ollama.chatRequests[0]).toMatchObject({
      model: "qwen3:8b",
      stream: true,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi", images: ["aGk="] },
      ],
    });
  });

  it("renders a mid-stream error line as bracketed text after the partial output", async () => {
    ollama.scriptChat(["partial"], { errorAfter: "model crashed" });
    const { streamChat } = await clientAt(ollama.url);
    expect(await readAll(await streamChat("m", [{ role: "user", content: "hi" }]))).toBe("partial\n[model crashed]");
  });

  it("a truncated stream (no done line) still resolves with the partial text and no hang", async () => {
    ollama.scriptChat(["one", "two", "three"], { truncateAfter: 2, chunkBytes: 5 });
    const { streamChat } = await clientAt(ollama.url);
    expect(await readAll(await streamChat("m", [{ role: "user", content: "hi" }]))).toBe("onetwo");
  });

  it("throws the response body text on an HTTP error status", async () => {
    ollama.scriptChat([], { status: 500 });
    const { streamChat } = await clientAt(ollama.url);
    await expect(streamChat("m", [{ role: "user", content: "hi" }])).rejects.toThrow(/500/);
  });

  it("propagates an already-aborted signal instead of opening a stream", async () => {
    const { streamChat } = await clientAt(ollama.url);
    const controller = new AbortController();
    controller.abort();
    await expect(streamChat("m", [{ role: "user", content: "hi" }], controller.signal)).rejects.toThrow();
    expect(ollama.chatRequests).toHaveLength(0);
  });
});

describe("unloadOllamaModels", () => {
  it("asks every resident model to unload via keep_alive: 0 and returns their names", async () => {
    ollama.setResident(["qwen3:8b", "llava:13b"]);
    const { unloadOllamaModels } = await clientAt(ollama.url);
    const names = await unloadOllamaModels();
    expect(names.sort()).toEqual(["llava:13b", "qwen3:8b"]);
    expect(ollama.unloads.map((u) => u.model).sort()).toEqual(["llava:13b", "qwen3:8b"]);
  });

  it("returns [] when nothing is resident", async () => {
    const { unloadOllamaModels } = await clientAt(ollama.url);
    expect(await unloadOllamaModels()).toEqual([]);
    expect(ollama.unloads).toHaveLength(0);
  });

  it("best effort: /api/ps unreachable (server down) returns [] and never throws", async () => {
    const { unloadOllamaModels } = await clientAt(ollama.url);
    await ollama.close();
    expect(await unloadOllamaModels()).toEqual([]);
  });

  it("best effort: /api/ps answering an error status returns []", async () => {
    const client = await clientAt(ollama.url);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/ps")) return Promise.resolve(new Response("busy", { status: 503 }));
      return realFetch(input, init);
    });
    expect(await client.unloadOllamaModels()).toEqual([]);
  });

  it("best effort: a failing unload POST for one model does not fail the others", async () => {
    ollama.setResident(["a:1b", "b:1b"]);
    const client = await clientAt(ollama.url);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/generate") && String(init?.body).includes("a:1b")) return Promise.reject(new Error("gone"));
      return realFetch(input, init);
    });
    expect((await client.unloadOllamaModels()).sort()).toEqual(["a:1b", "b:1b"]);
    expect(ollama.unloads.map((u) => u.model)).toEqual(["b:1b"]);
  });
});
