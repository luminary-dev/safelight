import { describe, expect, it } from "vitest";
import { lookupTokenPrice, normalizeModel, priceCall } from "./pricing";

describe("pricing", () => {
  it("prices token usage per million tokens", () => {
    const p = priceCall({ provider: "openai", model: "gpt-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(p.cost).toBeCloseTo(11.25, 10);
    expect(p.unpriced).toBe(false);
  });

  it("prices fractional token counts", () => {
    const p = priceCall({ provider: "anthropic", model: "claude-sonnet-4-5", inputTokens: 2000, outputTokens: 500 });
    expect(p.cost).toBeCloseTo((2000 * 3 + 500 * 15) / 1_000_000, 10);
  });

  it("matches dated snapshots via longest prefix", () => {
    expect(lookupTokenPrice("claude-sonnet-4-5-20250929")).toEqual({ input: 3, output: 15 });
    // longest prefix wins: the mini must not be billed as the base model
    expect(lookupTokenPrice("gpt-5-mini-2025-08-07")).toEqual({ input: 0.25, output: 2 });
  });

  it("normalizes OpenRouter vendor-prefixed and dotted ids", () => {
    expect(normalizeModel("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(lookupTokenPrice("anthropic/claude-sonnet-4.5")).toEqual({ input: 3, output: 15 });
  });

  it("trusts the provider-reported cost when present", () => {
    const p = priceCall({ provider: "openrouter", model: "totally/unknown-model", inputTokens: 10, outputTokens: 10, providerCost: 0.0123 });
    expect(p).toEqual({ cost: 0.0123, unpriced: false });
  });

  it("flags unknown cloud models as unpriced at cost 0", () => {
    expect(priceCall({ provider: "groq", model: "mystery-model-9000", inputTokens: 100, outputTokens: 100 })).toEqual({ cost: 0, unpriced: true });
  });

  it("never bills local providers and never flags them", () => {
    expect(priceCall({ provider: "ollama", model: "qwen2.5", inputTokens: 5000, outputTokens: 5000 })).toEqual({ cost: 0, unpriced: false });
    expect(priceCall({ provider: "local", model: "qwen-image", images: 3 })).toEqual({ cost: 0, unpriced: false });
  });

  it("prices cloud images per image", () => {
    const p = priceCall({ provider: "openai", model: "gpt-image-1", images: 2 });
    expect(p.cost).toBeCloseTo(0.084, 10);
    expect(p.unpriced).toBe(false);
  });

  it("reports no usage as priced (zero cost, no flag)", () => {
    expect(priceCall({ provider: "openai", model: "mystery" })).toEqual({ cost: 0, unpriced: false });
  });
});
