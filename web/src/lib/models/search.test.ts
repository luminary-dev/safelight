import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCivitaiItem, searchCivitai } from "./civitai";
import { normalizeHfFiles, searchHuggingFace } from "./hf";

afterEach(() => {
  vi.unstubAllEnvs();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Hugging Face normalization", () => {
  it("maps tree entries to files with lfs sha256 and resolve URLs", () => {
    const files = normalizeHfFiles("city96/Qwen-GGUF", [
      { type: "file", path: "qwen-image-Q4_K_M.gguf", size: 123, lfs: { oid: "a".repeat(64), size: 12_000_000_000 } },
      { type: "file", path: "text_encoders/qwen3-vl-te-Q5.gguf", lfs: { oid: "b".repeat(64), size: 5_000_000_000 } },
      { type: "file", path: "README.md" },
      { type: "directory", path: "vae" },
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      name: "qwen-image-Q4_K_M.gguf",
      sizeBytes: 12_000_000_000,
      downloadUrl: "https://huggingface.co/city96/Qwen-GGUF/resolve/main/qwen-image-Q4_K_M.gguf?download=true",
      sha256: "a".repeat(64),
      kind: "diffusion",
    });
    expect(files[1].kind).toBe("text_encoder");
    expect(files[1].downloadUrl).toContain("/resolve/main/text_encoders/qwen3-vl-te-Q5.gguf");
  });

  it("searches with filter=gguf and resolves each repo tree", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/models?")) return json([{ id: "city96/Qwen-GGUF", pipeline_tag: "text-to-image", downloads: 1200, likes: 7 }]);
      return json([{ type: "file", path: "model-Q4_0.gguf", lfs: { oid: "c".repeat(64), size: 9 } }]);
    }) as unknown as typeof fetch;

    const results = await searchHuggingFace("qwen image", fetchFn);
    expect(calls[0]).toContain("search=qwen%20image");
    expect(calls[0]).toContain("filter=gguf");
    expect(calls[1]).toContain("/api/models/city96/Qwen-GGUF/tree/main");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "city96/Qwen-GGUF", name: "Qwen-GGUF", source: "hf" });
    expect(results[0].description).toContain("text to image");
    expect(results[0].files[0].sha256).toBe("c".repeat(64));
  });
});

describe("Civitai normalization", () => {
  it("normalizes items to the shared shape and passes nsfw through", () => {
    const result = normalizeCivitaiItem({
      id: 42,
      name: "Some Checkpoint",
      description: "<p>Great &amp; <b>bold</b></p>",
      type: "Checkpoint",
      nsfw: true,
      modelVersions: [
        {
          files: [
            { name: "some_checkpoint.safetensors", sizeKB: 1024, downloadUrl: "https://civitai.com/api/download/models/42", hashes: { SHA256: "ABC123DEF" }, type: "Model" },
            { name: "some.vae.safetensors", sizeKB: 100, downloadUrl: "https://civitai.com/api/download/models/43", type: "VAE" },
          ],
        },
      ],
    });
    expect(result).toMatchObject({ id: "42", name: "Some Checkpoint", source: "civitai", nsfw: true, description: "Great & bold" });
    expect(result.files[0]).toMatchObject({ sizeBytes: 1024 * 1024, sha256: "abc123def", kind: "checkpoint" });
    expect(result.files[1].kind).toBe("vae");
  });

  it("queries the models endpoint with types and query params", async () => {
    let seen = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return json({ items: [{ id: 1, name: "A LoRA", type: "LORA", nsfw: false, modelVersions: [{ files: [{ name: "a.safetensors", sizeKB: 10, downloadUrl: "https://x/y" }] }] }] });
    }) as unknown as typeof fetch;

    const results = await searchCivitai("cats", fetchFn);
    expect(seen).toContain("civitai.com/api/v1/models?");
    expect(seen).toContain("query=cats");
    expect(seen).toContain("types=Checkpoint");
    expect(seen).toContain("types=LORA");
    expect(results[0].files[0].kind).toBe("lora");
  });

  it("sends the token as a header only when set, and search still works without one", async () => {
    vi.stubEnv("CIVITAI_API_TOKEN", "secret-token");
    let headers: Record<string, string> | undefined;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return json({ items: [] });
    }) as unknown as typeof fetch;
    await searchCivitai("x", fetchFn);
    expect(headers?.authorization).toBe("Bearer secret-token");
  });
});
