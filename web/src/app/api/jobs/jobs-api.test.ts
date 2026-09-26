import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";

/**
 * /api/jobs, /api/jobs/[id], /api/interrupt against the ComfyUI fake
 * (TEST-BRIEF §8): status polling, cancel (dequeue), re-queue to the front,
 * queue clearing, and interrupt. COMFY_URL is captured at import time, so the
 * fake starts before the routes load.
 */

let comfy: FakeComfy;
let dir: string;
let JOBS_DELETE: () => Promise<Response>;
let JOB_GET: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let JOB_DELETE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let JOB_POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let INTERRUPT: () => Promise<Response>;
let queuePrompt: (graph: Record<string, unknown>, clientId: string, opts?: { front?: boolean; promptId?: string }) => Promise<{ prompt_id: string }>;
const prevEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-jobs-api-"));
  for (const key of ["SAFELIGHT_DATA_DIR", "COMFY_URL", "COMFY_OUTPUT_DIR", "COMFY_INPUT_DIR"]) prevEnv.set(key, process.env[key]);
  process.env.SAFELIGHT_DATA_DIR = path.join(dir, "data");
  process.env.COMFY_OUTPUT_DIR = path.join(dir, "outputs");
  process.env.COMFY_INPUT_DIR = path.join(dir, "inputs");
  comfy = await startFakeComfy();
  process.env.COMFY_URL = comfy.url;
  ({ DELETE: JOBS_DELETE } = await import("./route"));
  ({ GET: JOB_GET, DELETE: JOB_DELETE, POST: JOB_POST } = await import("./[id]/route"));
  ({ POST: INTERRUPT } = await import("../interrupt/route"));
  ({ queuePrompt } = await import("@/lib/comfy/client"));
});

afterAll(async () => {
  await comfy.close();
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

/** After a restart, undici may still hold keep-alive sockets to the old server; drain them. */
async function waitComfyUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${comfy.url}/system_stats`);
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
    } catch {
      /* dead pooled socket — retry */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("fake ComfyUI did not come back after restart");
}

beforeEach(async () => {
  await comfy.restart();
  await waitComfyUp();
});

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(`http://localhost:3001${url}`, init) as unknown as NextRequest;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id]", () => {
  it("reports a completed job with its outputs", async () => {
    const { prompt_id } = await queuePrompt({ "1": { class_type: "SaveImage", inputs: {} } }, "test");
    const res = await JOB_GET(req(`/api/jobs/${prompt_id}`), ctx(prompt_id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; state: string; outputs: { filename: string }[] };
    expect(body.state).toBe("done");
    expect(body.outputs[0].filename).toMatch(/\.png$/);
  });

  it("reports a queued job, and an unknown id as a vanished error — not a 500", async () => {
    comfy.setAutoComplete(false);
    const { prompt_id } = await queuePrompt({}, "test");
    const queued = (await (await JOB_GET(req(`/api/jobs/${prompt_id}`), ctx(prompt_id))).json()) as { state: string };
    expect(queued.state).toBe("queued");
    const gone = await JOB_GET(req("/api/jobs/ghost"), ctx("ghost"));
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { state: string; error: string }).state).toBe("error");
  });

  it("surfaces the executing node's failure message", async () => {
    comfy.queueThenHistoryError("CUDA out of memory");
    const { prompt_id } = await queuePrompt({}, "test");
    const body = (await (await JOB_GET(req(`/api/jobs/${prompt_id}`), ctx(prompt_id))).json()) as { state: string; error: string };
    expect(body.state).toBe("error");
    expect(body.error).toContain("CUDA out of memory");
  });

  it("answers 502 when ComfyUI is unreachable", async () => {
    await comfy.close();
    try {
      const res = await JOB_GET(req("/api/jobs/x"), ctx("x"));
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    } finally {
      await comfy.restart();
      await waitComfyUp();
    }
  });
});

describe("DELETE /api/jobs/[id] and /api/jobs", () => {
  it("dequeues a pending job and clears the whole pending queue", async () => {
    comfy.setAutoComplete(false);
    const a = await queuePrompt({}, "test");
    const b = await queuePrompt({}, "test");
    const cancelled = await JOB_DELETE(req(`/api/jobs/${a.prompt_id}`, { method: "DELETE" }), ctx(a.prompt_id));
    expect(await cancelled.json()).toEqual({ ok: true, action: "dequeued" });

    void b;
    const cleared = await JOBS_DELETE();
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { cleared: number }).cleared).toBe(1);
  });

  it("cancelling an unknown job is a no-op, not an error", async () => {
    const res = await JOB_DELETE(req("/api/jobs/ghost", { method: "DELETE" }), ctx("ghost"));
    expect(await res.json()).toEqual({ ok: true, action: "noop" });
  });
});

describe("POST /api/jobs/[id] (front)", () => {
  it("re-queues a pending job at the front keeping its id", async () => {
    comfy.setAutoComplete(false);
    const a = await queuePrompt({}, "test");
    const b = await queuePrompt({}, "test");
    void a;
    const res = await JOB_POST(req(`/api/jobs/${b.prompt_id}`, { method: "POST", body: JSON.stringify({ action: "front" }) }), ctx(b.prompt_id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("an unknown action is 400; a job no longer waiting reports ok:false with a reason", async () => {
    const bad = await JOB_POST(req("/api/jobs/x", { method: "POST", body: JSON.stringify({ action: "teleport" }) }), ctx("x"));
    expect(bad.status).toBe(400);
    const malformed = await JOB_POST(req("/api/jobs/x", { method: "POST", body: "{oops" }), ctx("x"));
    expect(malformed.status).toBe(400); // malformed body → empty action → 400
    const gone = await JOB_POST(req("/api/jobs/ghost", { method: "POST", body: JSON.stringify({ action: "front" }) }), ctx("ghost"));
    const body = (await gone.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/not waiting/);
  });
});

describe("POST /api/interrupt", () => {
  it("forwards the interrupt to ComfyUI", async () => {
    const res = await INTERRUPT();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(comfy.requests.some((r) => r.method === "POST" && r.path === "/interrupt")).toBe(true);
  });

  it("answers 502 when ComfyUI is unreachable — regression: this used to throw a 500", async () => {
    await comfy.close();
    try {
      const res = await INTERRUPT();
      expect(res.status).toBe(502);
    } finally {
      await comfy.restart();
      await waitComfyUp();
    }
  });
});
