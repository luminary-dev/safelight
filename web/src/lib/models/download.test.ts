import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { authHeadersFor, cancelDownload, listDownloads, startDownload } from "./download";

const tmp = mkdtempSync(path.join(os.tmpdir(), "safelight-dl-"));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const PAYLOAD = Buffer.from("safelight model bytes ".repeat(1000));
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function streamOf(buf: Buffer, chunkSize = 4096): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buf.length) return controller.close();
      controller.enqueue(new Uint8Array(buf.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
}

function stubFetchWith(body: () => ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body(), { status: 200, headers })),
  );
}

async function waitFor(id: string, states: string[], timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const row = listDownloads().find((d) => d.id === id);
    if (row && states.includes(row.state)) return row;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${states.join("/")}; got ${row?.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("startDownload", () => {
  it("streams to .part, verifies sha256, renames on completion and books progress", async () => {
    stubFetchWith(() => streamOf(PAYLOAD), { "content-length": String(PAYLOAD.length) });
    const targetDir = path.join(tmp, "new", "diffusion_models"); // created on demand
    const { id } = startDownload({ url: "https://example.com/model.gguf", targetDir, fileName: "model.gguf", sizeBytes: PAYLOAD.length, sha256: PAYLOAD_SHA });

    const row = await waitFor(id, ["done", "error"]);
    expect(row.state).toBe("done");
    expect(row.received).toBe(PAYLOAD.length);
    expect(row.total).toBe(PAYLOAD.length);
    expect(row.file).toBe(path.join(targetDir, "model.gguf"));
    expect(existsSync(row.file)).toBe(true);
    expect(existsSync(`${row.file}.part`)).toBe(false);
    expect(readFileSync(row.file)).toEqual(PAYLOAD);
  });

  it("refuses to overwrite an existing file", () => {
    stubFetchWith(() => streamOf(PAYLOAD));
    const targetDir = path.join(tmp, "new", "diffusion_models");
    expect(() => startDownload({ url: "https://example.com/model.gguf", targetDir, fileName: "model.gguf" })).toThrow(/already exists/);
  });

  it("fails on checksum mismatch and removes the .part file", async () => {
    stubFetchWith(() => streamOf(PAYLOAD));
    const targetDir = path.join(tmp, "sha");
    const { id } = startDownload({ url: "https://example.com/bad.gguf", targetDir, fileName: "bad.gguf", sha256: "0".repeat(64) });
    const row = await waitFor(id, ["done", "error"]);
    expect(row.state).toBe("error");
    expect(row.error).toMatch(/checksum/i);
    expect(existsSync(path.join(targetDir, "bad.gguf"))).toBe(false);
    expect(existsSync(path.join(targetDir, "bad.gguf.part"))).toBe(false);
  });

  it("rejects downloads that do not fit with 2 GB headroom", () => {
    stubFetchWith(() => streamOf(PAYLOAD));
    expect(() => startDownload({ url: "https://example.com/huge.gguf", targetDir: tmp, fileName: "huge.gguf", sizeBytes: 2 ** 53 })).toThrow(/disk space/i);
    expect(listDownloads().find((d) => d.file.endsWith("huge.gguf"))).toBeUndefined();
  });

  it("rejects path-traversal file names", () => {
    stubFetchWith(() => streamOf(PAYLOAD));
    expect(() => startDownload({ url: "https://example.com/x.gguf", targetDir: tmp, fileName: "..", sizeBytes: 1 })).toThrow(/invalid file name/i);
  });

  it("cancel aborts the stream, marks cancelled and removes the .part file", async () => {
    // A stream that never ends on its own: cancel must cut it off.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const endless = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
            return new Promise((r) => setTimeout(r, 5));
          },
        });
        return new Response(endless, { status: 200 });
      }),
    );
    const targetDir = path.join(tmp, "cancel");
    const { id } = startDownload({ url: "https://example.com/slow.gguf", targetDir, fileName: "slow.gguf" });
    await waitFor(id, ["downloading"]);
    await new Promise((r) => setTimeout(r, 30)); // let some bytes land
    expect(cancelDownload(id)).toBe(true);
    const row = await waitFor(id, ["cancelled"]);
    expect(row.state).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 50)); // give cleanup a beat
    expect(existsSync(path.join(targetDir, "slow.gguf"))).toBe(false);
    expect(existsSync(path.join(targetDir, "slow.gguf.part"))).toBe(false);
  });

  it("reports HTTP failures as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const { id } = startDownload({ url: "https://example.com/gone.gguf", targetDir: path.join(tmp, "http"), fileName: "gone.gguf" });
    const row = await waitFor(id, ["error"]);
    expect(row.error).toContain("403");
  });
});

describe("authHeadersFor", () => {
  it("adds tokens only for the matching hosts and never otherwise", () => {
    vi.stubEnv("HF_TOKEN", "hf-secret");
    vi.stubEnv("CIVITAI_API_TOKEN", "civ-secret");
    expect(authHeadersFor("https://huggingface.co/x/y/resolve/main/a.gguf")).toEqual({ authorization: "Bearer hf-secret" });
    expect(authHeadersFor("https://civitai.com/api/download/models/1")).toEqual({ authorization: "Bearer civ-secret" });
    expect(authHeadersFor("https://github.com/some/release.pth")).toEqual({});
    expect(authHeadersFor("https://evil-huggingface.co.attacker.com/a")).toEqual({});
    expect(authHeadersFor("not a url")).toEqual({});
  });

  it("sends nothing when no tokens are set", () => {
    vi.stubEnv("HF_TOKEN", "");
    vi.stubEnv("CIVITAI_API_TOKEN", "");
    expect(authHeadersFor("https://huggingface.co/a/b")).toEqual({});
  });
});
