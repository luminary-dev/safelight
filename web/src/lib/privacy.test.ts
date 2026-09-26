import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { setSetting } from "@/lib/db/settings";
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
