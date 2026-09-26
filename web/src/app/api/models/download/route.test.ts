import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Of, wrongSha256Of } from "@/test/fakes/hf-civitai";

/**
 * /api/models/download (TEST-BRIEF §8): start/poll/cancel against an MSW https
 * file host (the route allows https only, so the plain-http
 * startModelFileServer cannot be used at this level — that gate is itself
 * pinned below). Covers checksum mismatch, truncated transfer, the
 * insufficient-disk refusal (driven by an absurd sizeBytes against the real
 * statfs — no seam exists for faking statfsSync's named-import binding), and
 * that a traversal fileName cannot escape the models root in the tmpdir.
 */

const DATA = Buffer.from("fake model weights ".repeat(64));

/** In-flight hanging streams so the cancel case has a download that never finishes. */
const hanging: ReadableStreamDefaultController<Uint8Array>[] = [];

const msw = setupServer(
  http.get("https://files.example/ok/:name", () => new HttpResponse(new Uint8Array(DATA), { headers: { "content-type": "application/octet-stream", "content-length": String(DATA.length) } })),
  http.get("https://files.example/truncated/:name", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DATA.subarray(0, 100)));
        controller.error(new Error("connection reset"));
      },
    });
    return new HttpResponse(stream, { headers: { "content-type": "application/octet-stream", "content-length": String(DATA.length) } });
  }),
  http.get("https://files.example/hang/:name", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DATA.subarray(0, 10)));
        hanging.push(controller);
      },
    });
    return new HttpResponse(stream, { headers: { "content-type": "application/octet-stream", "content-length": String(DATA.length) } });
  }),
);

let dir: string;
let root: string;
let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-model-dl-api-"));
  root = path.join(dir, "models");
  mkdirSync(root, { recursive: true });
  const folders = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "upscale_models", "controlnet"];
  writeFileSync(path.join(dir, "extra_model_paths.yaml"), `comfyui:\n  base_path: ${root}\n${folders.map((f) => `  ${f}: ${f}`).join("\n")}\n`);
  for (const key of ["COMFY_EXTRA_MODEL_PATHS", "SAFELIGHT_DATA_DIR", "HF_TOKEN", "CIVITAI_API_TOKEN"]) prevEnv.set(key, process.env[key]);
  delete process.env.HF_TOKEN;
  delete process.env.CIVITAI_API_TOKEN;
  process.env.COMFY_EXTRA_MODEL_PATHS = path.join(dir, "extra_model_paths.yaml");
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  msw.listen({ onUnhandledRequest: "bypass" });
  ({ GET, POST, DELETE } = await import("./route"));
});

afterAll(async () => {
  for (const c of hanging) {
    try {
      c.close();
    } catch {
      /* already aborted */
    }
  }
  msw.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function start(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost:3001/api/models/download", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
}

interface Progress {
  id: string;
  file: string;
  received: number;
  total: number | null;
  state: string;
  error?: string;
}

async function progressOf(id: string): Promise<Progress | undefined> {
  const body = (await (await GET()).json()) as { downloads: Progress[] };
  return body.downloads.find((d) => d.id === id);
}

async function waitForState(id: string, states: string[], ms = 4000): Promise<Progress> {
  const t0 = Date.now();
  for (;;) {
    const p = await progressOf(id);
    if (p && states.includes(p.state)) return p;
    if (Date.now() - t0 > ms) throw new Error(`download ${id} stuck in ${p?.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const OK_URL = (name: string) => `https://files.example/ok/${name}`;

describe("validation", () => {
  it("refuses malformed JSON, missing fields, and an unknown kind with 400", async () => {
    expect((await start("{nope")).status).toBe(400);
    expect((await start({ url: OK_URL("a.safetensors"), fileName: "a.safetensors" })).status).toBe(400);
    const badKind = await start({ url: OK_URL("a.safetensors"), fileName: "a.safetensors", kind: "malware" });
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { error: string }).error).toContain("Unknown kind");
  });

  it("refuses a non-URL and any non-https scheme — the download engine never sees them", async () => {
    expect((await start({ url: "not a url", fileName: "a.safetensors", kind: "lora" })).status).toBe(400);
    const httpRes = await start({ url: "http://127.0.0.1:9/files/a.safetensors", fileName: "a.safetensors", kind: "lora" });
    expect(httpRes.status).toBe(400);
    expect(((await httpRes.json()) as { error: string }).error).toContain("https");
    expect((await start({ url: "file:///etc/passwd", fileName: "a.safetensors", kind: "lora" })).status).toBe(400);
  });

  it("refuses an absurd size with 409 before starting (disk-space gate)", async () => {
    const res = await start({ url: OK_URL("huge.safetensors"), fileName: "huge.safetensors", kind: "diffusion", sizeBytes: 1e18 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Not enough disk space");
  });
});

describe("start + poll + verify", () => {
  it("downloads into the kind's folder under the models root and verifies the sha256", async () => {
    const res = await start({ url: OK_URL("model.safetensors"), fileName: "model.safetensors", kind: "diffusion", sha256: sha256Of(DATA) });
    expect(res.status).toBe(200);
    const { id, targetDir, root: reportedRoot } = (await res.json()) as { id: string; targetDir: string; root: string };
    expect(reportedRoot).toBe(root);
    expect(targetDir).toBe(path.join(root, "diffusion_models"));

    const done = await waitForState(id, ["done", "error"]);
    expect(done.state).toBe("done");
    expect(done.received).toBe(DATA.length);
    expect(existsSync(path.join(root, "diffusion_models", "model.safetensors"))).toBe(true);
    expect(existsSync(path.join(root, "diffusion_models", "model.safetensors.part"))).toBe(false);

    // A repeat of the same file is refused while it exists.
    const dup = await start({ url: OK_URL("model.safetensors"), fileName: "model.safetensors", kind: "diffusion" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toContain("already exists");

    // DELETE on a finished row clears it from the list.
    expect((await DELETE(new Request(`http://localhost:3001/api/models/download?id=${id}`, { method: "DELETE" }))).status).toBe(200);
    expect(await progressOf(id)).toBeUndefined();
  });

  it("fails a checksum mismatch and leaves neither the file nor the .part behind", async () => {
    const res = await start({ url: OK_URL("bad-hash.safetensors"), fileName: "bad-hash.safetensors", kind: "vae", sha256: wrongSha256Of(DATA) });
    const { id } = (await res.json()) as { id: string };
    const failed = await waitForState(id, ["done", "error"]);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("Checksum mismatch");
    expect(existsSync(path.join(root, "vae", "bad-hash.safetensors"))).toBe(false);
    expect(existsSync(path.join(root, "vae", "bad-hash.safetensors.part"))).toBe(false);
  });

  it("fails a truncated transfer with an error state, cleaning up the .part", async () => {
    const res = await start({ url: "https://files.example/truncated/cut.safetensors", fileName: "cut.safetensors", kind: "checkpoint" });
    const { id } = (await res.json()) as { id: string };
    const failed = await waitForState(id, ["done", "error"]);
    expect(failed.state).toBe("error");
    expect(existsSync(path.join(root, "checkpoints", "cut.safetensors"))).toBe(false);
    expect(existsSync(path.join(root, "checkpoints", "cut.safetensors.part"))).toBe(false);
  });
});

describe("cancel", () => {
  it("DELETE aborts a live download, marks it cancelled, and removes the .part", async () => {
    const res = await start({ url: "https://files.example/hang/slow.safetensors", fileName: "slow.safetensors", kind: "lora" });
    const { id } = (await res.json()) as { id: string };
    expect((await progressOf(id))!.state).toBe("downloading");

    const del = await DELETE(new Request(`http://localhost:3001/api/models/download?id=${id}`, { method: "DELETE" }));
    expect(await del.json()).toEqual({ ok: true });
    const cancelled = await waitForState(id, ["cancelled"]);
    expect(cancelled.state).toBe("cancelled");
    const t0 = Date.now();
    while (existsSync(path.join(root, "loras", "slow.safetensors.part")) && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(path.join(root, "loras", "slow.safetensors.part"))).toBe(false);
  });

  it("DELETE without an id is 400 and with an unknown id 404", async () => {
    expect((await DELETE(new Request("http://localhost:3001/api/models/download", { method: "DELETE" }))).status).toBe(400);
    expect((await DELETE(new Request("http://localhost:3001/api/models/download?id=dl_ghost", { method: "DELETE" }))).status).toBe(404);
  });
});

describe("escape attempts", () => {
  it("a traversal fileName is flattened to its basename inside the models root", async () => {
    const res = await start({ url: OK_URL("evil.safetensors"), fileName: "../../../evil.safetensors", kind: "lora", sha256: sha256Of(DATA) });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const done = await waitForState(id, ["done", "error"]);
    expect(done.state).toBe("done");
    expect(done.file).toBe(path.join(root, "loras", "evil.safetensors"));
    expect(existsSync(path.join(root, "loras", "evil.safetensors"))).toBe(true);
    expect(existsSync(path.join(dir, "evil.safetensors"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["data", "extra_model_paths.yaml", "models"]); // nothing new beside the root
  });

  it("a fileName that reduces to nothing is refused with 409, never written", async () => {
    const res = await start({ url: OK_URL("x.safetensors"), fileName: "..", kind: "lora" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Invalid file name");
  });
});
