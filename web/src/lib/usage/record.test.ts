import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { recordUsage, spentSince, usageSummary } from "./record";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-usage-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime(); // local noon, Sep 26 2026
const DAY = 24 * 60 * 60 * 1000;

describe("usage ledger", () => {
  it("computes and stores the cost on insert", () => {
    const billed = recordUsage({ provider: "openai", model: "gpt-5", mode: "agent", inputTokens: 1_000_000, outputTokens: 0, ts: NOW });
    expect(billed.cost).toBeCloseTo(1.25, 10);
    expect(spentSince(NOW - 1, NOW)).toBeCloseTo(1.25, 10);
  });

  it("excludes local providers from spend sums", () => {
    recordUsage({ provider: "ollama", model: "qwen2.5", mode: "agent", inputTokens: 9_999_999, outputTokens: 9_999_999, ts: NOW });
    recordUsage({ provider: "anthropic", model: "claude-haiku-4-5", mode: "agent", inputTokens: 1_000_000, outputTokens: 0, ts: NOW });
    expect(spentSince(NOW - 1, NOW)).toBeCloseTo(1, 10);
  });

  it("aggregates by day, provider, and mode with totals", () => {
    recordUsage({ provider: "openai", model: "gpt-5", mode: "agent", inputTokens: 1_000_000, outputTokens: 0, ts: NOW - 2 * DAY });
    recordUsage({ provider: "openai", model: "gpt-5", mode: "code", inputTokens: 0, outputTokens: 1_000_000, ts: NOW });
    recordUsage({ provider: "anthropic", model: "claude-sonnet-4-5", mode: "agent", inputTokens: 1_000_000, outputTokens: 0, images: 0, ts: NOW });
    recordUsage({ provider: "local", model: "qwen-image", mode: "agent", images: 2, ts: NOW });
    recordUsage({ provider: "openai", model: "gpt-5", mode: "agent", inputTokens: 1_000_000, outputTokens: 0, ts: NOW - 40 * DAY }); // outside window

    const s = usageSummary(30, NOW);
    expect(s.days).toBe(30);
    expect(s.totals.cost).toBeCloseTo(1.25 + 10 + 3, 10);
    expect(s.totals.inputTokens).toBe(2_000_000);
    expect(s.totals.outputTokens).toBe(1_000_000);
    expect(s.totals.images).toBe(2);

    expect(s.byDay).toHaveLength(2);
    expect(s.byDay[0].day < s.byDay[1].day).toBe(true);
    expect(s.byDay[1].cost).toBeCloseTo(13, 10);

    const openai = s.byProvider.find((p) => p.provider === "openai")!;
    expect(openai.cost).toBeCloseTo(11.25, 10);
    const local = s.byProvider.find((p) => p.provider === "local")!;
    expect(local.images).toBe(2);

    const agent = s.byMode.find((m) => m.mode === "agent")!;
    expect(agent.cost).toBeCloseTo(1.25 + 3, 10);
    const code = s.byMode.find((m) => m.mode === "code")!;
    expect(code.cost).toBeCloseTo(10, 10);
  });

  it("lists unpriced cloud models but not local ones", () => {
    recordUsage({ provider: "groq", model: "mystery-model-9000", mode: "agent", inputTokens: 100, outputTokens: 100, ts: NOW });
    recordUsage({ provider: "ollama", model: "qwen2.5", mode: "agent", inputTokens: 100, outputTokens: 100, ts: NOW });
    recordUsage({ provider: "openai", model: "gpt-5", mode: "agent", inputTokens: 100, outputTokens: 100, ts: NOW });
    const s = usageSummary(30, NOW);
    expect(s.unpricedModels).toEqual(["mystery-model-9000"]);
  });
});
