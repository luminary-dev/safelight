import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_META, PROVIDERS, validateKey, type ProviderId } from "./keys";

describe("PROVIDER_META", () => {
  it("has a complete entry for every ProviderId", () => {
    for (const p of PROVIDERS) {
      const meta = PROVIDER_META[p];
      expect(meta, `meta for ${p}`).toBeDefined();
      expect(meta.label.length, `label for ${p}`).toBeGreaterThan(0);
      expect(meta.envVar, `envVar for ${p}`).toMatch(/^[A-Z0-9_]+$/);
      expect(meta.placeholder.length, `placeholder for ${p}`).toBeGreaterThan(0);
      expect(typeof meta.chat, `chat for ${p}`).toBe("boolean");
      expect(typeof meta.images, `images for ${p}`).toBe("boolean");
      expect(() => new URL(meta.defaultBaseUrl), `defaultBaseUrl for ${p}`).not.toThrow();
      expect(meta.defaultBaseUrl.startsWith("https://"), `https base for ${p}`).toBe(true);
      expect(meta.defaultBaseUrl.endsWith("/"), `no trailing slash for ${p}`).toBe(false);
    }
  });

  it("covers every PROVIDER_META key in the PROVIDERS list", () => {
    expect(new Set(Object.keys(PROVIDER_META))).toEqual(new Set(PROVIDERS));
  });

  it("configures the new OpenAI-compatible providers", () => {
    expect(PROVIDER_META.openrouter).toEqual({
      label: "OpenRouter",
      envVar: "OPENROUTER_API_KEY",
      placeholder: "sk-or-…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    });
    expect(PROVIDER_META.groq).toEqual({
      label: "Groq",
      envVar: "GROQ_API_KEY",
      placeholder: "gsk_…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://api.groq.com/openai/v1",
    });
    expect(PROVIDER_META.mistral).toEqual({
      label: "Mistral",
      envVar: "MISTRAL_API_KEY",
      placeholder: "…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://api.mistral.ai/v1",
    });
    expect(PROVIDER_META.deepseek).toEqual({
      label: "DeepSeek",
      envVar: "DEEPSEEK_API_KEY",
      placeholder: "sk-…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://api.deepseek.com/v1",
    });
    expect(PROVIDER_META.xai).toEqual({
      label: "xAI",
      envVar: "XAI_API_KEY",
      placeholder: "xai-…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://api.x.ai/v1",
    });
    expect(PROVIDER_META.together).toEqual({
      label: "Together",
      envVar: "TOGETHER_API_KEY",
      placeholder: "…",
      chat: true,
      images: false,
      defaultBaseUrl: "https://api.together.xyz/v1",
    });
  });

  it("marks every chat-only provider images: false", () => {
    for (const p of ["openrouter", "groq", "mistral", "deepseek", "xai", "together"] as const) {
      expect(PROVIDER_META[p].chat, `chat for ${p}`).toBe(true);
      expect(PROVIDER_META[p].images, `images for ${p}`).toBe(false);
    }
  });
});

describe("validateKey for OpenAI-compatible providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[ProviderId, string]>([
    ["openrouter", "https://openrouter.ai/api/v1/models"],
    ["groq", "https://api.groq.com/openai/v1/models"],
    ["mistral", "https://api.mistral.ai/v1/models"],
    ["deepseek", "https://api.deepseek.com/v1/models"],
    ["xai", "https://api.x.ai/v1/models"],
    ["together", "https://api.together.xyz/v1/models"],
  ])("checks %s with GET {base}/models and a Bearer header", async (provider, expectedUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await validateKey(provider, "test-key");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(expectedUrl);
    expect(init.headers.authorization).toBe("Bearer test-key");
  });

  it("reports a rejected key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const result = await validateKey("groq", "bad-key");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected/);
  });

  it("respects a custom base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await validateKey("openrouter", "test-key", "https://proxy.example.com/v1/");
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example.com/v1/models");
  });
});
