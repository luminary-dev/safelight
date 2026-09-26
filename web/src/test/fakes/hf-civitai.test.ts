import { createHash } from "node:crypto";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { searchCivitai } from "@/lib/models/civitai";
import { searchHuggingFace } from "@/lib/models/hf";
import { hfCivitaiHandlers, sha256Of, startModelFileServer, wrongSha256Of, type FakeModelFileServer } from "./hf-civitai";

const msw = setupServer(...hfCivitaiHandlers());

beforeAll(() => msw.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => msw.resetHandlers(...hfCivitaiHandlers()));
afterAll(() => msw.close());

describe("search shapes through the real clients", () => {
  it("HF: hits resolve trees into files with LFS sizes, hashes, and kinds", async () => {
    const results = await searchHuggingFace("qwen");
    expect(results).toHaveLength(2);
    const [qwen, nsfw] = results;
    expect(qwen.id).toBe("city96/Qwen-Image-gguf");
    expect(qwen.source).toBe("hf");
    expect(qwen.files.map((f) => f.name)).toEqual(["qwen-image-Q4_K_M.gguf", "vae/qwen_image_vae.safetensors"]); // README filtered out
    expect(qwen.files[0].sizeBytes).toBe(12884901888); // LFS size wins over blob size
    expect(qwen.files[0].sha256).toBe("9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab");
    expect(qwen.files[0].downloadUrl).toContain("/resolve/main/qwen-image-Q4_K_M.gguf");
    expect(nsfw.nsfw).toBe(true); // not-for-all-audiences tag
  });

  it("HF: a gated repo (tree 401) still lists, with no files", async () => {
    msw.resetHandlers(...hfCivitaiHandlers({ hf: { treeStatus: 401 } }));
    const results = await searchHuggingFace("qwen");
    expect(results).toHaveLength(2);
    expect(results[0].files).toEqual([]);
  });

  it("HF: a search failure surfaces the status", async () => {
    msw.resetHandlers(...hfCivitaiHandlers({ hf: { status: 500 } }));
    await expect(searchHuggingFace("qwen")).rejects.toThrow(/500/);
  });

  it("Civitai: sizes from sizeKB, lowercased hashes, VAE file kind override, HTML stripped", async () => {
    const results = await searchCivitai("juggernaut");
    const jug = results[0];
    expect(jug.source).toBe("civitai");
    expect(jug.description).toBe("Photoreal SDXL checkpoint & more.");
    expect(jug.files[0].sizeBytes).toBe(Math.round(6775430.1 * 1024));
    expect(jug.files[0].sha256).toBe("c9e3e68f89b8e38689e1097d4be4573cfc4c25fa5ab05d6f13e7c17d60cdb584");
    expect(jug.files[0].kind).toBe("checkpoint");
    expect(jug.files[1].kind).toBe("vae"); // file-level VAE type overrides the model type
    expect(results[1].nsfw).toBe(true);
  });
});

describe("download file server", () => {
  const data = Buffer.from("fake model weights ".repeat(64));
  let files: FakeModelFileServer;

  beforeAll(async () => {
    files = await startModelFileServer({ "model.safetensors": data });
  });
  afterAll(async () => {
    await files.close();
  });

  it("serves the full file with a content-length, and the advertised sha matches", async () => {
    const res = await fetch(files.urlFor("model.safetensors"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(data.length));
    const body = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(body).digest("hex")).toBe(sha256Of(data));
  });

  it("wrongSha256Of is well-formed and never matches", () => {
    expect(wrongSha256Of(data)).toMatch(/^[0-9a-f]{64}$/);
    expect(wrongSha256Of(data)).not.toBe(sha256Of(data));
  });

  it("truncates a download mid-transfer", async () => {
    files.script("model.safetensors", { truncateAfter: 100 });
    const res = await fetch(files.urlFor("model.safetensors"));
    await expect(async () => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).rejects.toThrow(); // undici surfaces the violated content-length as a body read error
    files.script("model.safetensors", {});
  });

  it("serves a 206 with Content-Range for a resume, and records the Range header", async () => {
    const res = await fetch(files.urlFor("model.safetensors"), { headers: { range: "bytes=100-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-${data.length - 1}/${data.length}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(data.subarray(100))).toBe(true);
    expect(files.rangeRequests.at(-1)).toEqual({ name: "model.safetensors", range: "bytes=100-" });
  });

  it("scripts a 416 on resume", async () => {
    files.script("model.safetensors", { rangeStatus: 416 });
    const res = await fetch(files.urlFor("model.safetensors"), { headers: { range: "bytes=100-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${data.length}`);
    files.script("model.safetensors", {});
  });

  it("404s an unknown file", async () => {
    expect((await fetch(files.urlFor("nope.safetensors"))).status).toBe(404);
  });
});
