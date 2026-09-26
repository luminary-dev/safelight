import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * /api/blueprints, /api/blueprints/[id], /api/blueprints/[id]/run
 * (TEST-BRIEF §8): BLUEPRINTS_DIR is a tmpdir with three real fixtures plus one
 * malformed file; readiness gating runs against the ComfyUI fake's /object_info
 * and model folders. Offline tests run FIRST — the gating cache only fills on a
 * successful probe, so order matters inside this file.
 */

const FIXTURES = path.resolve(__dirname, "../../../lib/blueprints/fixtures");
const NAMES = ["Image Blur", "Text to Image (Z-Image-Turbo)", "Image to Video (Wan 2.2)"] as const;

let comfy: FakeComfy;
let dir: string;
let LIST: () => Promise<Response>;
let ONE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let RUN: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-blueprints-api-"));
  const bpDir = path.join(dir, "blueprints");
  mkdirSync(bpDir, { recursive: true });
  for (const name of NAMES) copyFileSync(path.join(FIXTURES, `${name}.json`), path.join(bpDir, `${name}.json`));
  writeFileSync(path.join(bpDir, "Broken.json"), "{ this is not json");

  for (const key of ["SAFELIGHT_DATA_DIR", "COMFY_URL", "OLLAMA_URL", "BLUEPRINTS_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  process.env.BLUEPRINTS_DIR = bpDir;
  process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unload call is best-effort; keep it offline
  comfy = await startFakeComfy();
  await comfy.close(); // offline scenarios run first
  process.env.COMFY_URL = comfy.url;
  ({ GET: LIST } = await import("./route"));
  ({ GET: ONE } = await import("./[id]/route"));
  ({ POST: RUN } = await import("./[id]/run/route"));
});

afterAll(async () => {
  await comfy.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(`http://localhost:3001${url}`, init) as unknown as NextRequest;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function run(id: string, body: unknown): Promise<Response> {
  return RUN(req(`/api/blueprints/${id}/run`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(id));
}

interface ListedBlueprint {
  id: string;
  name: string;
  status: string;
  missingNodeClasses: string[];
  missingModels: string[];
  requiredModels: string[];
  requiredNodeClasses: string[];
  inputs: { key: string; kind: string; required?: boolean }[];
}

describe("while ComfyUI is offline", () => {
  it("lists every parseable blueprint as unknown, with the malformed file in failures", async () => {
    const res = await LIST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { online: boolean; blueprints: ListedBlueprint[]; failures: { file: string }[] };
    expect(body.online).toBe(false);
    expect(body.blueprints.map((b) => b.id).sort()).toEqual(["image-blur", "image-to-video-wan-2-2", "text-to-image-z-image-turbo"]);
    expect(body.blueprints.every((b) => b.status === "unknown")).toBe(true);
    expect(body.failures.map((f) => f.file)).toEqual(["Broken.json"]);
  });

  it("refuses to run with 502 — blueprints need the local backend", async () => {
    const res = await run("image-blur", { values: {} });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/offline/i);
  });
});

describe("with ComfyUI up", () => {
  beforeAll(async () => {
    await comfy.restart();
    // Give the fake every node class the fixtures execute, but no model files:
    // z-image/wan gate on missing models, image-blur (no models) becomes ready.
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${comfy.url}/system_stats`)).ok) break;
      } catch {
        /* stale keep-alive socket — retry */
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // Read specs straight from the registry: the route would probe gating and
    // prime its five-minute installed cache before the classes are registered.
    const { getRegistry } = await import("@/lib/blueprints/registry");
    const { blueprints } = await getRegistry();
    for (const bp of blueprints) {
      for (const cls of bp.spec.requiredNodeClasses) comfy.setObjectInfo(cls, { input: { required: {} } });
    }
  });

  it("gates a blueprint whose models are absent as missing, with the exact lists", async () => {
    const res = await ONE(req("/api/blueprints/text-to-image-z-image-turbo"), ctx("text-to-image-z-image-turbo"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListedBlueprint & { online: boolean };
    expect(body.online).toBe(true);
    expect(body.status).toBe("missing");
    expect(body.missingNodeClasses).toEqual([]);
    expect(body.missingModels).toEqual(body.requiredModels);
    expect(body.missingModels).toContain("z_image_turbo_bf16.safetensors");
  });

  it("404s on an unknown blueprint id, for both GET and run", async () => {
    expect((await ONE(req("/api/blueprints/no-such"), ctx("no-such"))).status).toBe(404);
    expect((await run("no-such", { values: {} })).status).toBe(404);
  });

  it("run rejects malformed JSON with 400", async () => {
    expect((await run("image-blur", "{nope")).status).toBe(400);
  });

  it("run answers 409 with the exact missing lists for a gated blueprint", async () => {
    const res = await run("text-to-image-z-image-turbo", { values: {} });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; missingModels: string[]; missingNodeClasses: string[] };
    expect(body.missingNodeClasses).toEqual([]);
    expect(body.missingModels).toContain("z_image_turbo_bf16.safetensors");
    expect(body.error).toContain("missing models");
  });

  it("run refuses missing required inputs and unknown input keys with 400", async () => {
    const spec = (await (await ONE(req("/api/blueprints/image-blur"), ctx("image-blur"))).json()) as ListedBlueprint;
    const imageInput = spec.inputs.find((i) => i.kind === "image")!;
    expect(imageInput.required).toBe(true);

    const missing = await run("image-blur", { values: {} });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBeTruthy();

    const unknown = await run("image-blur", { values: { bogusKey: 1 } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/Unknown input/);
  });

  it("queues a ready blueprint on ComfyUI and returns the prompt id", async () => {
    const spec = (await (await ONE(req("/api/blueprints/image-blur"), ctx("image-blur"))).json()) as ListedBlueprint & { status: string };
    expect(spec.status).toBe("ready"); // no models required, all node classes installed
    const imageKey = spec.inputs.find((i) => i.kind === "image")!.key;

    const res = await run("image-blur", { values: { [imageKey]: "safelight/photo.png" }, clientId: "test-client" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; state: string; blueprint: string; freedChatModels: string[] };
    expect(body.state).toBe("queued");
    expect(body.blueprint).toBe("image-blur");
    expect(body.id).toMatch(/^fake-prompt-/);
    expect(body.freedChatModels).toEqual([]); // Ollama offline → best-effort unload freed nothing
    expect(comfy.requests.some((r) => r.method === "POST" && r.path === "/prompt")).toBe(true);
  });
});
