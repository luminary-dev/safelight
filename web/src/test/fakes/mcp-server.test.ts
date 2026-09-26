import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MCP_STDIO_SCRIPT, mcpStdioConfig, startHttpMcp } from "./mcp-server";

/**
 * Self-tests speak raw JSON-RPC (fetch / child process) so they need no
 * database — lib/agent/mcp.ts stores server configs in SQLite, which is
 * Tier 4's business, not the fake's.
 */

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  result?: {
    tools?: { name: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean } }[];
    content?: { type: string; text: string }[];
    serverInfo?: { name: string };
  };
  error?: { code: number; message: string };
}

/** Minimal NDJSON JSON-RPC client over a spawned stdio server. */
function stdioClient(behavior: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [MCP_STDIO_SCRIPT, behavior], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<number, (msg: Rpc) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Rpc;
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 0;
  return {
    child,
    request(method: string, params: Record<string, unknown> = {}, timeoutMs = 2000): Promise<Rpc> {
      const id = ++nextId;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    exited: new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
    kill: () => child.kill(),
  };
}

async function rpc(url: string, method: string, params: Record<string, unknown> = {}, id = 1): Promise<Rpc> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as Rpc;
}

describe("stdio MCP fake", () => {
  it("initializes, lists a read-only echo and a destructive tool without readOnlyHint, and calls both", async () => {
    const client = stdioClient("ok");
    try {
      const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      expect(init.result?.serverInfo?.name).toBe("fake-mcp-stdio");
      const list = await client.request("tools/list");
      const tools = list.result?.tools ?? [];
      expect(tools.map((t) => t.name)).toEqual(["echo", "wipe_data"]);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[1].annotations).toBeUndefined(); // destructive tool: no hint → approval required
      const call = await client.request("tools/call", { name: "echo", arguments: { text: "hello" } });
      expect(call.result?.content).toEqual([{ type: "text", text: "hello" }]);
      const wipe = await client.request("tools/call", { name: "wipe_data", arguments: {} });
      expect(wipe.result?.content?.[0].text).toContain("wiped");
    } finally {
      client.kill();
    }
  });

  it("invalid-schema behavior returns a tool whose inputSchema is not an object", async () => {
    const client = stdioClient("invalid-schema");
    try {
      const list = await client.request("tools/list");
      expect(list.result?.tools?.[0].inputSchema).toBe("definitely-not-a-json-schema");
    } finally {
      client.kill();
    }
  });

  it("die-mid-call behavior exits the process on tools/call without answering", async () => {
    const client = stdioClient("die-mid-call");
    try {
      await client.request("tools/list");
      await expect(client.request("tools/call", { name: "echo", arguments: { text: "x" } }, 1500)).rejects.toThrow(/timeout/);
      expect(await client.exited).toBe(1);
    } finally {
      client.kill();
    }
  });

  it("mcpStdioConfig produces a spawnable stdio McpServerConfig", () => {
    const cfg = mcpStdioConfig("ok", "my-fake");
    expect(cfg).toMatchObject({ id: "my-fake", transport: "stdio", command: process.execPath, enabled: true });
    expect(cfg.args?.[0]).toMatch(/mcp-stdio\.cjs$/);
  });
});

describe("HTTP MCP fake", () => {
  it("initializes with a session id, lists tools, calls echo, records calls", async () => {
    const mcp = await startHttpMcp("ok");
    try {
      const res = await fetch(mcp.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.headers.get("mcp-session-id")).toBe("fake-session-1");
      const list = await rpc(mcp.url, "tools/list");
      expect(list.result?.tools?.map((t) => t.name)).toEqual(["echo", "wipe_data"]);
      const call = await rpc(mcp.url, "tools/call", { name: "echo", arguments: { text: "hi" } });
      expect(call.result?.content).toEqual([{ type: "text", text: "hi" }]);
      expect(mcp.calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
    } finally {
      await mcp.close();
    }
  });

  it("die-mid-call destroys the connection on tools/call", async () => {
    const mcp = await startHttpMcp("die-mid-call");
    try {
      expect((await rpc(mcp.url, "tools/list")).result?.tools?.length).toBeGreaterThan(0);
      await expect(rpc(mcp.url, "tools/call", { name: "echo", arguments: {} })).rejects.toThrow();
    } finally {
      await mcp.close();
    }
  });

  it("invalid-schema behavior serves the broken tool", async () => {
    const mcp = await startHttpMcp("invalid-schema");
    try {
      const list = await rpc(mcp.url, "tools/list");
      expect(list.result?.tools?.[0].inputSchema).toBe("definitely-not-a-json-schema");
    } finally {
      await mcp.close();
    }
  });

  it("silent behavior leaves the request hanging until the caller's own timeout", async () => {
    const mcp = await startHttpMcp("silent");
    try {
      await expect(
        fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), signal: AbortSignal.timeout(300) }),
      ).rejects.toThrow();
    } finally {
      await mcp.close();
    }
  });
});
