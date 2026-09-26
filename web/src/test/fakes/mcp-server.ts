import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@/lib/agent/mcp";
import { sendJson, startFakeServer, type FakeServer } from "./http";

/**
 * MCP fakes, both transports:
 *
 * stdio — mcpStdioConfig(behavior) returns a McpServerConfig that spawns
 * ./mcp-stdio.cjs as a real child process (node is always on PATH in tests).
 *
 * http — startHttpMcp(behavior) is an in-process streamable-HTTP MCP endpoint.
 *
 * Behaviors (shared vocabulary):
 *   "ok"             echo (readOnlyHint: true) and wipe_data (destructive, no readOnlyHint)
 *   "invalid-schema" tools/list returns a tool whose inputSchema is a bare string
 *   "die-mid-call"   the server dies on tools/call: the child exits / the socket is destroyed
 *   "silent"         never answers (forces the caller's timeout)
 */

export type McpBehavior = "ok" | "invalid-schema" | "die-mid-call" | "silent";

export const MCP_STDIO_SCRIPT = fileURLToPath(new URL("./mcp-stdio.cjs", import.meta.url));

/** A ready McpServerConfig for the stdio fake, usable with probeMcpServer/callMcpTool. */
export function mcpStdioConfig(behavior: McpBehavior = "ok", id = "fake-stdio"): McpServerConfig {
  return { id, name: `Fake stdio MCP (${behavior})`, transport: "stdio", command: process.execPath, args: [MCP_STDIO_SCRIPT, behavior], enabled: true };
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const TOOLS: Record<string, unknown[]> = {
  ok: [
    {
      name: "echo",
      description: "Echoes text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "wipe_data",
      description: "Deletes everything. Destructive, and deliberately missing readOnlyHint.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  "invalid-schema": [{ name: "broken", description: "This tool's schema is garbage.", inputSchema: "definitely-not-a-json-schema" }],
};

export interface FakeHttpMcp extends FakeServer {
  /** McpServerConfig pointing at this server. */
  config(id?: string): McpServerConfig;
  /** tools/call requests seen: [toolName, args]. */
  calls: { name: string; args: Record<string, unknown> }[];
}

export async function startHttpMcp(behavior: McpBehavior = "ok"): Promise<FakeHttpMcp> {
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  const base = await startFakeServer((req, res, body) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    if (behavior === "silent") return; // leave the request hanging until the client times out
    const msg = JSON.parse(body.toString("utf8") || "{}") as RpcRequest;
    if (msg.id === undefined) {
      res.writeHead(202).end(); // notification
      return;
    }
    const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result }, { "mcp-session-id": "fake-session-1" });

    if (msg.method === "initialize") {
      reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-http", version: "0.0.1" } });
      return;
    }
    if (msg.method === "tools/list") {
      reply({ tools: TOOLS[behavior] ?? TOOLS.ok });
      return;
    }
    if (msg.method === "tools/call") {
      if (behavior === "die-mid-call") {
        res.destroy(); // connection dies with no response
        return;
      }
      const name = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      calls.push({ name, args });
      if (name === "echo") {
        reply({ content: [{ type: "text", text: String(args.text) }] });
        return;
      }
      if (name === "wipe_data") {
        reply({ content: [{ type: "text", text: "wiped (not really)" }] });
        return;
      }
      sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  });

  return {
    ...base,
    calls,
    config: (id = "fake-http") => ({ id, name: `Fake HTTP MCP (${behavior})`, transport: "http", url: base.url, enabled: true }),
  };
}
