import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { recordUsage } from "@/lib/usage/record";
import { GET } from "./route";

/**
 * /api/usage: the cost-ledger aggregation, against seeded usage_events in a
 * sandboxed database (TEST-BRIEF §8).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-usage-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function get(query = ""): Promise<Response> {
  return GET(new NextRequest(new Request(`http://localhost:3001/api/usage${query}`)));
}

interface Bucket {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  images: number;
}
interface Summary {
  days: number;
  byDay: ({ day: string } & Bucket)[];
  byProvider: ({ provider: string } & Bucket)[];
  byMode: ({ mode: string } & Bucket)[];
  totals: Bucket;
  unpricedModels: string[];
}

describe("GET /api/usage", () => {
  it("returns the empty aggregation shape on a fresh ledger", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Summary;
    expect(body.days).toBe(30);
    expect(body.byDay).toEqual([]);
    expect(body.byProvider).toEqual([]);
    expect(body.byMode).toEqual([]);
    expect(body.totals).toMatchObject({ inputTokens: 0, outputTokens: 0, images: 0 });
  });

  it("aggregates seeded events by provider and mode with exact token sums", async () => {
    const now = Date.now();
    const a = recordUsage({ provider: "openai", model: "gpt-4o-mini", mode: "chat", inputTokens: 1000, outputTokens: 500, ts: now - 1000 });
    const b = recordUsage({ provider: "openai", model: "gpt-4o-mini", mode: "chat", inputTokens: 200, outputTokens: 100, ts: now - 500 });
    recordUsage({ provider: "ollama", model: "llama3", mode: "agent", inputTokens: 50, outputTokens: 25, ts: now - 100 });

    const body = (await (await get("?days=7")).json()) as Summary;
    expect(body.days).toBe(7);
    const openai = body.byProvider.find((p) => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.inputTokens).toBe(1200);
    expect(openai!.outputTokens).toBe(600);
    expect(openai!.cost).toBeCloseTo(a.cost + b.cost, 10);
    const agent = body.byMode.find((m) => m.mode === "agent");
    expect(agent!.inputTokens).toBe(50);
    expect(body.totals.inputTokens).toBe(1250);
    expect(body.byDay.length).toBeGreaterThanOrEqual(1);
  });

  it("treats a garbage days parameter as the default, never 500", async () => {
    const res = await get("?days=banana");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Summary).days).toBe(30);
  });

  it("surfaces unpriced cloud models instead of silently costing them at zero", async () => {
    recordUsage({ provider: "openai", model: "totally-unknown-model-x", mode: "chat", inputTokens: 10, outputTokens: 10, ts: Date.now() });
    const body = (await (await get()).json()) as Summary;
    expect(body.unpricedModels).toContain("totally-unknown-model-x");
  });
});
