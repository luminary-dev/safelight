import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/view serves rendered files from outputs/ and inputs/ and falls back to the
 * ComfyUI /view proxy (TEST-BRIEF §8, §15). The dirs are per-suite tmpdirs wired
 * through COMFY_OUTPUT_DIR/COMFY_INPUT_DIR before the route module loads, and the
 * proxy is a stubbed global fetch — nothing here touches :8188 or real outputs.
 */

const parent = mkdtempSync(path.join(tmpdir(), "sl-view-"));
const OUT = path.join(parent, "outputs");
const IN = path.join(parent, "inputs");
process.env.COMFY_OUTPUT_DIR = OUT;
process.env.COMFY_INPUT_DIR = IN;
process.env.COMFY_URL = "http://comfy.test.invalid:9";

let GET: (req: NextRequest) => Promise<Response>;
const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  mkdirSync(path.join(OUT, "sub"), { recursive: true });
  mkdirSync(IN, { recursive: true });
  writeFileSync(path.join(OUT, "render.png"), "png-bytes-render");
  writeFileSync(path.join(OUT, "sub", "nested.webp"), "webp-bytes-nested");
  writeFileSync(path.join(OUT, "data.bin"), "opaque-bytes");
  writeFileSync(path.join(IN, "source.jpg"), "jpg-bytes-source");
  // Escape targets: a secret outside both roots, reachable via a planted symlink.
  writeFileSync(path.join(parent, "secret.png"), "OUTSIDE-SECRET");
  symlinkSync(parent, path.join(OUT, "link"));
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("upstream miss", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function view(params: Record<string, string>, headers?: Record<string, string>, rawQuery?: string): Promise<Response> {
  const query = rawQuery ?? new URLSearchParams(params).toString();
  return GET(new NextRequest(new Request(`http://localhost:3001/api/view?${query}`, { headers })));
}

describe("serving local files", () => {
  it("serves an output file with the right MIME type and revalidation headers", async () => {
    const res = await view({ filename: "render.png" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(await res.text()).toBe("png-bytes-render");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a file from a subfolder", async () => {
    const res = await view({ filename: "nested.webp", subfolder: "sub" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(await res.text()).toBe("webp-bytes-nested");
  });

  it("serves inputs when type=input", async () => {
    const res = await view({ filename: "source.jpg", type: "input" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await res.text()).toBe("jpg-bytes-source");
  });

  it("coerces a bogus type to output", async () => {
    const res = await view({ filename: "render.png", type: "temp" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes-render");
  });

  it("labels an unknown extension application/octet-stream", async () => {
    const res = await view({ filename: "data.bin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers 304 with the etag on a matching If-None-Match", async () => {
    const first = await view({ filename: "render.png" });
    const etag = first.headers.get("etag")!;
    const res = await view({ filename: "render.png" }, { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("serves the body again when the etag does not match", async () => {
    const res = await view({ filename: "render.png" }, { "if-none-match": '"stale"' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes-render");
  });
});

describe("path confinement", () => {
  it("rejects .. in the filename", async () => {
    expect((await view({ filename: "../secret.png" })).status).toBe(400);
    expect((await view({ filename: ".." })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects .. in the subfolder", async () => {
    expect((await view({ filename: "secret.png", subfolder: ".." })).status).toBe(400);
    expect((await view({ filename: "secret.png", subfolder: "a/../.." })).status).toBe(400);
  });

  it("rejects a URL-encoded %2e%2e traversal — the query parser decodes it back to ..", async () => {
    const res = await view({}, undefined, "filename=%2e%2e%2fsecret.png");
    expect(res.status).toBe(400);
  });

  it("treats a double-encoded traversal as a literal name that stays confined", async () => {
    const res = await view({}, undefined, "filename=%252e%252e%252fsecret.png");
    expect(res.status).toBe(404); // no such literal file locally; the stubbed upstream misses
    expect(await res.text()).not.toContain("OUTSIDE-SECRET");
  });

  it("never serves an absolute path from the local disk", async () => {
    const res = await view({ filename: path.join(parent, "secret.png") });
    expect(res.status).toBe(404); // refused locally; only the stubbed upstream was consulted
    expect(await res.text()).not.toContain("OUTSIDE-SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("survives a null byte in the filename without serving anything", async () => {
    const res = await view({ filename: "render.png\0.txt" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("png-bytes-render");
  });

  it("refuses to follow a symlink planted inside outputs to a file outside it", async () => {
    const res = await view({ filename: "secret.png", subfolder: "link" });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("OUTSIDE-SECRET");
  });

  it("rejects a missing filename", async () => {
    expect((await view({})).status).toBe(400);
  });
});

describe("ComfyUI fallback", () => {
  it("proxies a locally missing file to the ComfyUI /view endpoint", async () => {
    fetchMock.mockResolvedValue(new Response("upstream-bytes", { status: 200, headers: { "content-type": "image/png" } }));
    const res = await view({ filename: "gone.png", subfolder: "sub" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-bytes");
    expect(res.headers.get("content-type")).toBe("image/png");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const upstream = new URL(String(fetchMock.mock.calls[0][0]));
    expect(upstream.origin).toBe("http://comfy.test.invalid:9");
    expect(upstream.pathname).toBe("/view");
    expect(upstream.searchParams.get("filename")).toBe("gone.png");
    expect(upstream.searchParams.get("subfolder")).toBe("sub");
    expect(upstream.searchParams.get("type")).toBe("output");
  });

  it("defaults a content-type-less upstream to application/octet-stream", async () => {
    const headers = new Headers();
    const res200 = new Response("x", { status: 200 });
    res200.headers.delete("content-type");
    void headers;
    fetchMock.mockResolvedValue(res200);
    const res = await view({ filename: "gone.png" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("returns 404 when the upstream also misses", async () => {
    expect((await view({ filename: "gone.png" })).status).toBe(404);
  });

  it("returns 404 when the upstream fetch itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    expect((await view({ filename: "gone.png" })).status).toBe(404);
  });
});
