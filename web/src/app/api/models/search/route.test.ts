import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hfCivitaiHandlers } from "@/test/fakes/hf-civitai";

/**
 * /api/models/search (TEST-BRIEF §8): the HF and Civitai fixtures through MSW
 * on the hubs' real hostnames, plus the failure statuses. The models root is a
 * tmpdir via COMFY_EXTRA_MODEL_PATHS, wired before the route module loads.
 */

const msw = setupServer(...hfCivitaiHandlers());

let dir: string;
let root: string;
let GET: (req: Request) => Promise<Response>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-model-search-api-"));
  root = path.join(dir, "models");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(dir, "extra_model_paths.yaml"), `comfyui:\n  base_path: ${root}\n  checkpoints: checkpoints\n`);
  for (const key of ["COMFY_EXTRA_MODEL_PATHS", "SAFELIGHT_DATA_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.COMFY_EXTRA_MODEL_PATHS = path.join(dir, "extra_model_paths.yaml");
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  msw.listen({ onUnhandledRequest: "bypass" });
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  msw.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function search(query: Record<string, string>): Promise<Response> {
  return GET(new Request(`http://localhost:3001/api/models/search?${new URLSearchParams(query)}`));
}

interface SearchBody {
  root: string;
  source: string;
  results: { id: string; source: string; files: { name: string; downloadUrl: string; sha256?: string }[] }[];
}

describe("GET /api/models/search", () => {
  it("requires a query", async () => {
    const res = await search({});
    expect(res.status).toBe(400);
    expect((await search({ q: "  " })).status).toBe(400);
  });

  it("searches Hugging Face by default and returns files with hashes and download URLs", async () => {
    const res = await search({ q: "qwen" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.source).toBe("hf");
    expect(body.root).toBe(root);
    expect(body.results[0].id).toBe("city96/Qwen-Image-gguf");
    expect(body.results[0].files[0].downloadUrl).toContain("/resolve/main/");
    expect(body.results[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("searches Civitai when asked, and treats any other source as hf", async () => {
    const civitai = (await (await search({ q: "juggernaut", source: "civitai" })).json()) as SearchBody;
    expect(civitai.source).toBe("civitai");
    expect(civitai.results[0].source).toBe("civitai");
    const fallback = (await (await search({ q: "qwen", source: "warez" })).json()) as SearchBody;
    expect(fallback.source).toBe("hf");
  });

  it("maps an upstream failure to 502 with the upstream's status in the message", async () => {
    msw.resetHandlers(...hfCivitaiHandlers({ hf: { status: 500 }, civitai: { status: 503 } }));
    const hf = await search({ q: "qwen" });
    expect(hf.status).toBe(502);
    expect(((await hf.json()) as { error: string }).error).toContain("500");
    const civitai = await search({ q: "x", source: "civitai" });
    expect(civitai.status).toBe(502);
    msw.resetHandlers(...hfCivitaiHandlers());
  });
});
