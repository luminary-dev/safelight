import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/fixtures/db";
import { createProviderMsw } from "@/test/msw/providers";
import { cloudCatalog, generateCloudImages, invalidateCloudCatalog, streamCloudChat } from "./index";
import type { ProviderId } from "./keys";

/**
 * The provider index (cloudCatalog and dispatch) against MSW: aggregation
 * across keyed providers, label curation, per-provider error isolation, the
 * five-minute listing cache, and the no-key / no-image-support error paths.
 */

const keyed = vi.hoisted(() => new Map<string, string>());

vi.mock("./keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keys")>();
  return {
    ...actual,
    getKey: async (p: ProviderId) => keyed.get(p),
    getProviderConfig: async (p: ProviderId) => ({ key: keyed.get(p), baseUrl: undefined }),
  };
});

const msw = createProviderMsw();
let db: TestDb;

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
beforeEach(async () => {
  db = await makeTestDb(); // privacy's localOnly switch reads settings from the sandboxed db
  keyed.clear();
  invalidateCloudCatalog();
});
afterEach(async () => {
  msw.reset();
  await db.cleanup();
});
afterAll(() => msw.server.close());

describe("cloudCatalog", () => {
  it("aggregates only the keyed providers, in provider order, with no errors on the happy path", async () => {
    keyed.set("openai", "sk-test");
    keyed.set("anthropic", "sk-ant-test");
    keyed.set("gemini", "AIza-test");
    const catalog = await cloudCatalog();
    const providers = [...new Set(catalog.chat.map((m) => m.provider))];
    expect(providers).toEqual(["openai", "anthropic", "gemini"]); // PROVIDERS order
    expect(catalog.images.map((m) => m.provider).sort()).toEqual(["gemini", "openai", "openai"]);
    expect(catalog.errors).toEqual({});
  });

  it("keeps Anthropic's curated display names and derives friendly labels for id-only providers", async () => {
    keyed.set("openai", "sk-test");
    keyed.set("anthropic", "sk-ant-test");
    const catalog = await cloudCatalog();
    expect(catalog.chat.find((m) => m.id === "claude-sonnet-4-5")?.label).toBe("Claude Sonnet 4.5");
    // OpenAI's /models returns bare ids; the label must be the derived friendly name.
    expect(catalog.chat.find((m) => m.id === "gpt-4o")?.label).toBe("GPT-4o");
  });

  it("a provider with no key is skipped without a wire request", async () => {
    let requests = 0;
    msw.server.events.on("request:start", () => requests++);
    const catalog = await cloudCatalog();
    expect(requests).toBe(0);
    expect(catalog.chat).toEqual([]);
    expect(catalog.images).toEqual([]);
  });

  it("one failing provider lands in errors without poisoning the others", async () => {
    keyed.set("openai", "sk-test");
    keyed.set("groq", "gsk-test");
    msw.script("groq", { modelsError: { status: 500 } });
    const catalog = await cloudCatalog();
    expect(catalog.errors.groq).toMatch(/500/);
    expect(catalog.errors.openai).toBeUndefined();
    expect(catalog.chat.some((m) => m.provider === "openai")).toBe(true);
    expect(catalog.chat.some((m) => m.provider === "groq")).toBe(false);
  });

  it("caches listings for the TTL: a second call makes no wire request, invalidate refetches", async () => {
    keyed.set("openai", "sk-test");
    let requests = 0;
    msw.server.events.on("request:start", () => requests++);
    await cloudCatalog();
    const afterFirst = requests;
    expect(afterFirst).toBeGreaterThan(0);
    await cloudCatalog();
    expect(requests).toBe(afterFirst); // served from cache
    invalidateCloudCatalog();
    await cloudCatalog();
    expect(requests).toBeGreaterThan(afterFirst);
  });

  it("a failed listing is NOT cached: the next call retries the provider", async () => {
    keyed.set("openai", "sk-test");
    // 401: the one listing error the OpenAI SDK does not retry (retries stall under MSW).
    msw.script("openai", { modelsError: { status: 401 } });
    const failed = await cloudCatalog();
    expect(failed.errors.openai).toBeDefined();
    msw.reset();
    const ok = await cloudCatalog();
    expect(ok.errors).toEqual({});
    expect(ok.chat.some((m) => m.provider === "openai")).toBe(true);
  });
});

describe("dispatch guards", () => {
  it("streamCloudChat without a key names the provider", async () => {
    await expect(streamCloudChat("anthropic", "claude-sonnet-4-5", [{ role: "user", content: "hi" }])).rejects.toThrow(/No Anthropic API key configured/);
  });

  it("generateCloudImages refuses chat-only providers with a pointer to Chat", async () => {
    keyed.set("groq", "gsk-test");
    await expect(generateCloudImages("groq", "llama-3.3-70b-versatile", { prompt: "x", width: 1024, height: 1024, count: 1, images: [] })).rejects.toThrow(
      /Groq models do not generate images\. Use them in Chat\./,
    );
  });

  it("streamCloudChat dispatches a keyed provider to the right adapter", async () => {
    keyed.set("openai", "sk-test");
    msw.script("openai", { chatDeltas: ["ok"] });
    const stream = await streamCloudChat("openai", "gpt-4o", [{ role: "user", content: "hi" }]);
    expect(stream).toBeInstanceOf(ReadableStream);
    await stream.cancel();
  });
});
