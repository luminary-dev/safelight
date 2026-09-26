import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStreamText as readAll } from "./http";
import { startFakeOllama, type FakeOllama } from "./ollama-server";

let ollama: FakeOllama;

/** Imports the real client pointed at the fake (OLLAMA_URL is read at module load). */
async function clientAt(url: string) {
  vi.resetModules();
  vi.stubEnv("OLLAMA_URL", url);
  return import("@/lib/ollama/client");
}

beforeEach(async () => {
  ollama = await startFakeOllama();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ollama.close();
});

describe("fake Ollama through the real client", () => {
  it("lists tags and per-model capabilities from /api/show", async () => {
    ollama.setModels([
      { name: "llava:13b", capabilities: ["completion", "vision"] },
      { name: "qwen3:8b", capabilities: ["completion", "tools"] },
      { name: "plain:7b", capabilities: ["completion"] }, // the no-tools model
    ]);
    const { listOllamaModels } = await clientAt(ollama.url);
    const models = await listOllamaModels();
    expect(models.map((m) => m.name)).toEqual(["llava:13b", "qwen3:8b", "plain:7b"]);
    expect(models[0].capabilities).toEqual(["completion", "vision"]);
    expect(models[1].capabilities).toContain("tools");
    expect(models[2].capabilities).not.toContain("tools");
  });

  it("streams NDJSON chat deltas, reassembled across arbitrary chunk boundaries", async () => {
    ollama.scriptChat(["Hel", "lo ", "world"], { chunkBytes: 7 });
    const { streamChat } = await clientAt(ollama.url);
    const text = await readAll(await streamChat("qwen3:8b", [{ role: "user", content: "hi" }]));
    expect(text).toBe("Hello world");
    expect(ollama.chatRequests[0]).toMatchObject({ model: "qwen3:8b", stream: true });
  });

  it("surfaces a mid-stream error line the way the client renders it", async () => {
    ollama.scriptChat(["partial"], { errorAfter: "model crashed" });
    const { streamChat } = await clientAt(ollama.url);
    const text = await readAll(await streamChat("qwen3:8b", [{ role: "user", content: "hi" }]));
    expect(text).toBe("partial\n[model crashed]");
  });

  it("truncates a stream abruptly: partial text arrives, no done line, no hang", async () => {
    ollama.scriptChat(["one", "two", "three"], { truncateAfter: 2 });
    const { streamChat } = await clientAt(ollama.url);
    const text = await readAll(await streamChat("qwen3:8b", [{ role: "user", content: "hi" }]));
    expect(text).toBe("onetwo");
  });

  it("answers a scripted HTTP error status on /api/chat", async () => {
    ollama.scriptChat([], { status: 500 });
    const { streamChat } = await clientAt(ollama.url);
    await expect(streamChat("qwen3:8b", [{ role: "user", content: "hi" }])).rejects.toThrow(/500/);
  });

  it("unloads resident models via /api/generate keep_alive: 0", async () => {
    ollama.setResident(["qwen3:8b", "llava:13b"]);
    const { unloadOllamaModels } = await clientAt(ollama.url);
    const names = await unloadOllamaModels();
    expect(names.sort()).toEqual(["llava:13b", "qwen3:8b"]);
    expect(ollama.unloads.map((u) => u.model).sort()).toEqual(["llava:13b", "qwen3:8b"]);
    // The fake evicts on unload, like the real server.
    const ps = (await (await fetch(`${ollama.url}/api/ps`)).json()) as { models: unknown[] };
    expect(ps.models).toEqual([]);
  });

  it("goes offline on close(): tags reject, unload degrades to []", async () => {
    const { listOllamaModels, unloadOllamaModels } = await clientAt(ollama.url);
    await ollama.close();
    await expect(listOllamaModels()).rejects.toThrow();
    expect(await unloadOllamaModels()).toEqual([]); // best-effort contract: never throws
  });
});
