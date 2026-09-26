import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "@/lib/comfy/types";

/**
 * POST /api/generate: sweep fan-out, preflight, and the swap-guard warning.
 * queueLocal and the estimator are mocked; sanitize/sweep math stays real.
 */

const mocks = vi.hoisted(() => ({
  queueLocal: vi.fn(),
  estimateLocalFootprint: vi.fn(),
  cancelJob: vi.fn(async () => "dequeued" as const),
  expandPromptText: vi.fn((text: string, seed: number) => {
    void seed;
    return text;
  }),
}));

vi.mock("@/lib/generate-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/generate-core")>()),
  queueLocal: mocks.queueLocal,
  estimateLocalFootprint: mocks.estimateLocalFootprint,
}));
vi.mock("@/lib/comfy/client", () => ({ cancelJob: mocks.cancelJob }));
vi.mock("@/lib/prompts", () => ({ expandPromptText: mocks.expandPromptText }));

import { POST } from "./route";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request("http://localhost/api/generate", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest);
}

const MODEL = { model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" }, prompt: "a bird", seed: 500 };

beforeEach(() => {
  let n = 0;
  mocks.queueLocal.mockReset().mockImplementation(async () => ({ id: `job-${(n += 1)}`, graph: {}, freed: [] }));
  mocks.estimateLocalFootprint.mockReset().mockResolvedValue({ willSwap: false, warning: null });
  mocks.cancelJob.mockClear();
  mocks.expandPromptText.mockClear();
});

describe("sweep fan-out", () => {
  it("queues one job per seed-sweep point and returns the group", async () => {
    const res = await post({ ...MODEL, sweep: { kind: "seed", count: 3 } });
    const data = (await res.json()) as { group: string; ids: string[]; points: { id: string; seed: number; label: string }[]; state: string };
    expect(res.status).toBe(200);
    expect(mocks.queueLocal).toHaveBeenCalledTimes(3);
    expect(data.ids).toEqual(["job-1", "job-2", "job-3"]);
    expect(data.group).toMatch(/[0-9a-f-]{36}/);
    expect(data.state).toBe("queued");
    const seeds = mocks.queueLocal.mock.calls.map(([req]) => (req as GenerateRequest).seed);
    expect(seeds[0]).toBe(500);
    expect(new Set(seeds).size).toBe(3);
    // Every point renders one image, and the sidecar carries the group.
    for (const [req, , opts] of mocks.queueLocal.mock.calls as [GenerateRequest, string, { sidecarExtra?: { sweep?: { group: string; kind: string } } }][]) {
      expect(req.batch).toBe(1);
      expect(opts.sidecarExtra?.sweep?.group).toBe(data.group);
      expect(opts.sidecarExtra?.sweep?.kind).toBe("seed");
    }
    expect(data.points.map((p) => p.seed)).toEqual(seeds);
  });

  it("queues one job per cfg value with the base seed", async () => {
    const res = await post({ ...MODEL, sweep: { kind: "cfg", values: [1, 2.5, 4] } });
    expect(res.status).toBe(200);
    const cfgs = mocks.queueLocal.mock.calls.map(([req]) => (req as GenerateRequest).cfg);
    expect(cfgs).toEqual([1, 2.5, 4]);
    expect(mocks.queueLocal.mock.calls.every(([req]) => (req as GenerateRequest).seed === 500)).toBe(true);
  });

  it("expands wildcards per job so a seed sweep can vary them", async () => {
    await post({ ...MODEL, prompt: "a {red|blue} bird", sweep: { kind: "seed", count: 2 } });
    const promptCalls = mocks.expandPromptText.mock.calls.filter(([text]) => text === "a {red|blue} bird");
    expect(promptCalls).toHaveLength(2);
    const [seedA, seedB] = promptCalls.map(([, seed]) => seed);
    expect(seedA).not.toBe(seedB);
  });

  it("rejects sweeps on cloud models, img2img, and bad specs", async () => {
    expect((await post({ ...MODEL, model: { name: "gpt-image-1", folder: "cloud", provider: "openai" }, sweep: { kind: "seed", count: 3 } })).status).toBe(400);
    expect((await post({ ...MODEL, mode: "img2img", images: ["a.png"], sweep: { kind: "seed", count: 3 } })).status).toBe(400);
    expect((await post({ ...MODEL, sweep: { kind: "cfg", values: [1] } })).status).toBe(400);
    expect(mocks.queueLocal).not.toHaveBeenCalled();
  });

  it("withdraws already-queued points when a later one fails", async () => {
    mocks.queueLocal.mockImplementationOnce(async () => ({ id: "job-a", graph: {}, freed: [] })).mockImplementationOnce(async () => {
      throw new Error("ComfyUI fell over");
    });
    const res = await post({ ...MODEL, sweep: { kind: "seed", count: 3 } });
    expect(res.status).toBe(502);
    expect(mocks.cancelJob).toHaveBeenCalledWith("job-a");
  });

  it("passes the swap warning through on a sweep", async () => {
    mocks.estimateLocalFootprint.mockResolvedValue({ willSwap: true, warning: "~19 GB needed, 9 GB free" });
    const data = (await (await post({ ...MODEL, sweep: { kind: "seed", count: 2 } })).json()) as { warning?: string };
    expect(data.warning).toMatch(/19 GB needed/);
  });
});

describe("preflight", () => {
  it("returns the estimate without queueing", async () => {
    mocks.estimateLocalFootprint.mockResolvedValue({ willSwap: true, warning: "~19 GB needed, 9 GB free", neededBytes: 1, freeBytes: 2 });
    const res = await post({ ...MODEL, preflight: true });
    const data = (await res.json()) as { preflight: boolean; warning: string };
    expect(res.status).toBe(200);
    expect(data.preflight).toBe(true);
    expect(data.warning).toMatch(/likely swap|GB needed/);
    expect(mocks.queueLocal).not.toHaveBeenCalled();
  });

  it("is a no-op verdict for cloud models", async () => {
    const res = await post({ ...MODEL, model: { name: "gpt-image-1", folder: "cloud", provider: "openai" }, preflight: true });
    const data = (await res.json()) as { willSwap: boolean; warning: null };
    expect(data.willSwap).toBe(false);
    expect(data.warning).toBeNull();
    expect(mocks.estimateLocalFootprint).not.toHaveBeenCalled();
  });
});

describe("single local render", () => {
  it("queues once, expands wildcards, and attaches the warning when the estimate says swap", async () => {
    mocks.estimateLocalFootprint.mockResolvedValue({ willSwap: true, warning: "~19 GB needed, 9 GB free — this render will likely swap" });
    const res = await post({ ...MODEL, prompt: "a {red|blue} bird" });
    const data = (await res.json()) as { id: string; warning?: string };
    expect(res.status).toBe(200);
    expect(data.id).toBe("job-1");
    expect(data.warning).toMatch(/likely swap/);
    expect(mocks.queueLocal).toHaveBeenCalledTimes(1);
    expect(mocks.expandPromptText).toHaveBeenCalledWith("a {red|blue} bird", 500);
  });

  it("still queues when the estimator itself fails", async () => {
    mocks.estimateLocalFootprint.mockRejectedValue(new Error("comfy down"));
    const res = await post(MODEL);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warning?: string }).warning).toBeUndefined();
  });
});
