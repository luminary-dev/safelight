import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMcpServer } from "@/lib/agent/mcp";
import { resetDbForTests } from "@/lib/db";
import { setSetting } from "@/lib/db/settings";
import { listDownloads, startDownload } from "@/lib/models/download";
import { cloudCatalog, invalidateCloudCatalog, streamCloudChat } from "@/lib/providers";
import { validateKey } from "@/lib/providers/keys";
import { searchWeb } from "@/lib/search/chain";
import { sha256Of, startModelFileServer } from "@/test/fakes/hf-civitai";
import { assertOutboundAllowed, invalidateLocalOnlyCache, isLocalOnly, isLoopbackUrl } from "./privacy";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-priv-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
  invalidateLocalOnlyCache();
});

afterEach(async () => {
  resetDbForTests();
  invalidateLocalOnlyCache();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("isLoopbackUrl", () => {
  it.each(["http://localhost:8188/prompt", "http://127.0.0.1/x", "http://127.5.5.5/", "http://[::1]:3000/", "http://foo.localhost/"])("loopback: %s", (u) => {
    expect(isLoopbackUrl(u)).toBe(true);
  });
  it.each(["https://api.openai.com/v1", "http://192.168.1.4/", "https://localhost.evil.com/", "not a url"])("not loopback: %s", (u) => {
    expect(isLoopbackUrl(u)).toBe(false);
  });
});

describe("assertOutboundAllowed", () => {
  it("allows everything when the switch is off", () => {
    expect(isLocalOnly()).toBe(false);
    expect(() => assertOutboundAllowed("cloud chat")).not.toThrow();
    expect(() => assertOutboundAllowed("model downloading", "https://huggingface.co/x")).not.toThrow();
  });

  it("blocks outbound features when on, naming the feature", () => {
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    expect(() => assertOutboundAllowed("web search")).toThrow(/Local only is on — web search is disabled/);
    expect(() => assertOutboundAllowed("model downloading", "https://civitai.com/api")).toThrow(/model downloading/);
  });

  it("keeps loopback targets working while on", () => {
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    expect(() => assertOutboundAllowed("remote MCP servers", "http://localhost:9000/mcp")).not.toThrow();
    expect(() => assertOutboundAllowed("remote MCP servers", "https://mcp.example.com")).toThrow();
  });

  it("the read cache drops on invalidate", () => {
    expect(isLocalOnly()).toBe(false);
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    expect(isLocalOnly()).toBe(true);
  });
});

/**
 * THE ABSOLUTE (TEST-BRIEF §10): with Local only ON, no outbound request is
 * made AT ALL. fetch is intercepted at the boundary: any non-loopback call
 * fails the test by name, loopback passes through to the real implementation
 * because local servers are the product. This proves the switch as an
 * absolute, not a preference — features either refuse loudly or work locally,
 * and in both cases zero bytes head for the internet.
 */
describe("local-only is absolute: no outbound fetch, ever", () => {
  const realFetch = globalThis.fetch;
  let outbound: string[];

  beforeEach(() => {
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    invalidateCloudCatalog();
    outbound = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (isLoopbackUrl(url)) return realFetch(input, init);
        outbound.push(url);
        throw new Error(`OUTBOUND CALL ESCAPED THE LOCAL-ONLY SWITCH: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("web search refuses before any provider is contacted", async () => {
    // Force keyed providers on so a missing guard would actually dial out.
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    vi.stubEnv("TAVILY_API_KEY", "test-key");
    await expect(searchWeb("anything at all")).rejects.toThrow(/Local only is on — web search is disabled/);
    expect(outbound).toEqual([]);
  });

  it("the provider catalog is empty instead of calling every configured provider (regression: it used to dial out)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-real");
    const catalog = await cloudCatalog();
    expect(catalog).toEqual({ chat: [], images: [], errors: {} });
    expect(outbound).toEqual([]);
  });

  it("cloud chat refuses before the provider request is built", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    await expect(streamCloudChat("openai", "gpt-5", [{ role: "user", content: "hi" }])).rejects.toThrow(/Local only is on — cloud chat is disabled/);
    expect(outbound).toEqual([]);
  });

  it("key validation refuses without touching the provider", async () => {
    await expect(validateKey("openai", "sk-test-not-real")).rejects.toThrow(/Local only is on — key validation is disabled/);
    expect(outbound).toEqual([]);
  });

  it("a model download to the internet refuses synchronously and books nothing", () => {
    expect(() => startDownload({ url: "https://huggingface.co/x/y/resolve/main/m.gguf", targetDir: path.join(dir, "models"), fileName: "m.gguf", sizeBytes: 8 })).toThrow(
      /Local only is on — model downloading is disabled/,
    );
    expect(listDownloads().find((d) => d.file.endsWith("m.gguf"))).toBeUndefined();
    expect(outbound).toEqual([]);
  });

  it("a remote MCP server refuses before its first JSON-RPC message", async () => {
    await expect(probeMcpServer({ id: "remote", name: "Remote", transport: "http", url: "https://mcp.example.com/mcp", enabled: true })).rejects.toThrow(
      /Local only is on — remote MCP servers is disabled/,
    );
    expect(outbound).toEqual([]);
  });

  it("loopback still works end-to-end: a local model file server download completes with the switch on", async () => {
    const payload = Buffer.from("local model bytes ".repeat(64));
    const files = await startModelFileServer({ "local.gguf": payload });
    try {
      const targetDir = path.join(dir, "models", "loopback");
      const { id } = startDownload({ url: files.urlFor("local.gguf"), targetDir, fileName: "local.gguf", sizeBytes: payload.length, sha256: sha256Of(payload) });
      const start = Date.now();
      for (;;) {
        const row = listDownloads().find((d) => d.id === id);
        if (row && (row.state === "done" || row.state === "error")) {
          expect(row.state).toBe("done");
          break;
        }
        if (Date.now() - start > 5000) throw new Error(`download never settled: ${row?.state}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(path.join(targetDir, "local.gguf"))).toBe(true);
      expect(outbound).toEqual([]);
    } finally {
      await files.close();
    }
  });
});
