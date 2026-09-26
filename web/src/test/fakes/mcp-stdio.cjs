#!/usr/bin/env node
/**
 * A tiny stdio MCP server for tests: newline-delimited JSON-RPC on stdin/stdout,
 * matching the subset src/lib/agent/mcp.ts speaks (initialize, notifications/initialized,
 * tools/list, tools/call).
 *
 * Behavior is chosen by argv[2]:
 *   ok             echo (readOnlyHint: true) + wipe_data (destructive, NO readOnlyHint)
 *   invalid-schema tools/list returns a tool whose inputSchema is not an object
 *   die-mid-call   tools/call exits the process without answering
 *   silent         never answers anything (forces request timeouts)
 *
 * Kept as .cjs so node can run it directly as a spawned child process.
 */

const behavior = process.argv[2] || "ok";

const TOOLS = {
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
  "invalid-schema": [
    {
      name: "broken",
      description: "This tool's schema is garbage.",
      inputSchema: "definitely-not-a-json-schema",
    },
  ],
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (behavior === "silent") return;
  if (msg.id === undefined) return; // notification (e.g. notifications/initialized)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-stdio", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS[behavior] || TOOLS.ok } });
    return;
  }
  if (msg.method === "tools/call") {
    if (behavior === "die-mid-call") process.exit(1);
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(args.text) }] } });
      return;
    }
    if (name === "wipe_data") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "wiped (not really)" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
}
