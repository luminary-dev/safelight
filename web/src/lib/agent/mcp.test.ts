import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import type { ToolContext } from "./tools";
import { deleteMcpServer, findSseResponse, listMcpServers, namespacedTool, parseNamespacedTool, saveMcpServer, withMcpTools, type McpServerConfig } from "./mcp";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-mcp-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  for (const s of listMcpServers()) deleteMcpServer(s.id); // also closes pooled connections
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("tool namespacing", () => {
  it("round-trips server and tool names", () => {
    expect(namespacedTool("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(parseNamespacedTool("mcp__github__create_issue")).toEqual({ serverId: "github", tool: "create_issue" });
    expect(parseNamespacedTool("mcp__fs__read__file")).toEqual({ serverId: "fs", tool: "read__file" });
  });

  it("rejects names that are not namespaced MCP tools", () => {
    expect(parseNamespacedTool("generate_image")).toBeNull();
    expect(parseNamespacedTool("mcp__NoCaps__x")).toBeNull();
    expect(parseNamespacedTool("mcp__missing-tool__")).toBeNull();
  });
});

describe("findSseResponse", () => {
  it("picks the event with the matching id out of a stream", () => {
    const body = ["event: message", 'data: {"jsonrpc":"2.0","id":7,"result":{"ok":false}}', "", "data: not json", "", 'data: {"jsonrpc":"2.0","id":9,"result":{"ok":true}}', ""].join("\n");
    expect(findSseResponse(body, 9)?.result).toEqual({ ok: true });
    expect(findSseResponse(body, 7)?.result).toEqual({ ok: false });
    expect(findSseResponse(body, 8)).toBeNull();
  });

  it("joins multi-line data fields", () => {
    const body = 'data: {"jsonrpc":"2.0",\ndata: "id":1,"result":42}\n\n';
    expect(findSseResponse(body, 1)?.result).toBe(42);
  });
});

describe("server config store", () => {
  it("round-trips, upserts by id and deletes", () => {
    saveMcpServer({ id: "fs", name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "server"], enabled: true });
    saveMcpServer({ id: "web", name: "Web", transport: "http", url: "https://example.com/mcp", enabled: false });
    expect(listMcpServers()).toHaveLength(2);
    saveMcpServer({ id: "fs", name: "Files", transport: "stdio", command: "npx", args: [], enabled: false });
    const fs = listMcpServers().find((s) => s.id === "fs");
    expect(fs?.name).toBe("Files");
    expect(fs?.enabled).toBe(false);
    deleteMcpServer("fs");
    expect(listMcpServers().map((s) => s.id)).toEqual(["web"]);
  });

  it("rejects bad ids, empty commands and non-http urls", () => {
    expect(() => saveMcpServer({ id: "Bad Id", name: "x", transport: "stdio", command: "y", enabled: true })).toThrow(/id/);
    expect(() => saveMcpServer({ id: "a", name: "x", transport: "stdio", command: " ", enabled: true })).toThrow(/command/);
    expect(() => saveMcpServer({ id: "a", name: "x", transport: "http", url: "file:///etc/passwd", enabled: true })).toThrow(/http/);
    expect(() => saveMcpServer({ id: "a", name: "x", transport: "http", url: "not a url", enabled: true })).toThrow();
  });
});

// A complete MCP server in one inline node script: newline-delimited JSON-RPC on stdio,
// one read-only tool (echo) and one mutating tool (mutate, no annotations).
const FAKE_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } });
  else if (msg.method === 'tools/list') reply({ tools: [
    { name: 'echo', description: 'Echoes text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'mutate', description: 'Changes something.', inputSchema: { type: 'object', properties: {} } },
  ] });
  else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') reply({ content: [{ type: 'text', text: 'echo: ' + (msg.params.arguments.text ?? '') }] });
    else reply({ content: [{ type: 'text', text: 'mutated' }] });
  }
});
`;

function fakeServerConfig(): McpServerConfig {
  return { id: "fake", name: "Fake", transport: "stdio", command: process.execPath, args: ["-e", FAKE_SERVER], enabled: true };
}

const BASE = {
  defs: [{ name: "base_tool", description: "b", parameters: {} }],
  execute: vi.fn(async () => ({ result: "base" })),
};

const CTX = { clientId: "t", emit: () => undefined } as unknown as ToolContext;

describe("withMcpTools over a live stdio server", () => {
  it("returns the base toolset untouched when no server is enabled", async () => {
    const merged = await withMcpTools(BASE, async () => true);
    expect(merged).toBe(BASE);
  });

  it("merges namespaced tools and calls a read-only tool without asking", async () => {
    saveMcpServer(fakeServerConfig());
    const ask = vi.fn(async () => true);
    const merged = await withMcpTools(BASE, ask);
    expect(merged.defs.map((d) => d.name)).toEqual(["base_tool", "mcp__fake__echo", "mcp__fake__mutate"]);
    expect(merged.defs[1].description).toContain("[Fake via MCP]");
    const out = await merged.execute("mcp__fake__echo", { text: "hi" }, CTX, "t1");
    expect(out.result).toEqual({ output: "echo: hi" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before a mutating tool and refuses on deny", async () => {
    saveMcpServer(fakeServerConfig());
    const deny = vi.fn(async () => false);
    const merged = await withMcpTools(BASE, deny);
    await expect(merged.execute("mcp__fake__mutate", {}, CTX, "t2")).rejects.toThrow(/declined/);
    expect(deny).toHaveBeenCalledWith(expect.stringContaining("Fake · mutate"), "mcp_tool");

    const allow = vi.fn(async () => true);
    const merged2 = await withMcpTools(BASE, allow);
    const out = await merged2.execute("mcp__fake__mutate", {}, CTX, "t3");
    expect(out.result).toEqual({ output: "mutated" });
  });

  it("passes non-MCP tools through to the base toolset", async () => {
    saveMcpServer(fakeServerConfig());
    const merged = await withMcpTools(BASE, async () => true);
    const out = await merged.execute("base_tool", {}, CTX, "t4");
    expect(out.result).toBe("base");
  });

  it("skips a server that cannot start instead of failing the run", async () => {
    saveMcpServer({ id: "dead", name: "Dead", transport: "stdio", command: "/nonexistent-binary-xyz", enabled: true });
    const merged = await withMcpTools(BASE, async () => true);
    expect(merged.defs.map((d) => d.name)).toEqual(["base_tool"]);
  });
});
