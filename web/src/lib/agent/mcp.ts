import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getSetting, setSetting } from "@/lib/db/settings";
import type { ToolContext, ToolDef } from "./tools";
import type { JobOutput } from "@/lib/comfy/types";

/**
 * A minimal MCP client: user-configured servers (stdio or HTTP) whose tools join any agent
 * mode's toolset under the namespace mcp__<server>__<tool>. Tools a server does not mark
 * read-only require the user's Allow in the chat before each call.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** stdio: the executable and its arguments, run with a scrubbed environment. */
  command?: string;
  args?: string[];
  /** http: the streamable-HTTP endpoint. */
  url?: string;
  enabled: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** From the server's annotations; read-only tools skip the approval prompt. */
  readOnly: boolean;
}

const SETTINGS_KEY = "mcp_servers";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function listMcpServers(): McpServerConfig[] {
  const raw = getSetting<unknown>(SETTINGS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is McpServerConfig => {
    const c = s as McpServerConfig;
    return Boolean(c && typeof c.id === "string" && ID_RE.test(c.id) && typeof c.name === "string" && (c.transport === "stdio" || c.transport === "http"));
  });
}

export function saveMcpServer(cfg: McpServerConfig): void {
  if (!ID_RE.test(cfg.id)) throw new Error("Server id must be 1–32 lowercase letters, digits or dashes.");
  if (!cfg.name.trim()) throw new Error("Give the server a name.");
  if (cfg.transport === "stdio" && !cfg.command?.trim()) throw new Error("A stdio server needs a command.");
  if (cfg.transport === "http") {
    const url = new URL(cfg.url ?? ""); // throws on garbage
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("An HTTP server needs an http(s) URL.");
  }
  const rest = listMcpServers().filter((s) => s.id !== cfg.id);
  setSetting(SETTINGS_KEY, [...rest, cfg]);
  dropConnection(cfg.id);
}

export function deleteMcpServer(id: string): void {
  setSetting(
    SETTINGS_KEY,
    listMcpServers().filter((s) => s.id !== id),
  );
  dropConnection(id);
}

// ---------------------------------------------------------------------------
// JSON-RPC transports

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Transport {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): void;
  readonly alive: boolean;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "safelight", version: "0.1.0" };

/** Newline-delimited JSON-RPC over a spawned process; the child sees only PATH/HOME/LANG. */
class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  alive = true;

  constructor(command: string, args: string[]) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } as unknown as NodeJS.ProcessEnv;
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.fail(new Error(`MCP server failed to start: ${err.message}`)));
    this.child.on("exit", (code) => this.fail(new Error(`MCP server exited${code !== null ? ` with code ${code}` : ""}.`)));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        continue; // servers sometimes log to stdout; skip non-JSON lines
      }
      if (typeof msg.id !== "number") continue; // notification from the server
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
  }

  private fail(err: Error) {
    this.alive = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("MCP server connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }

  close() {
    this.alive = false;
    this.child.kill();
  }
}

/** Streamable HTTP: one POST per message; responses arrive as JSON or a short SSE stream. */
class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId: string | null = null;
  alive = true;

  constructor(private url: string) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!res.ok) throw new Error(`MCP server answered ${res.status} for ${method}.`);
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const msg = type.includes("text/event-stream") ? findSseResponse(text, id) : (JSON.parse(text) as RpcResponse);
    if (!msg) throw new Error(`MCP server sent no response for ${method}.`);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => undefined);
  }

  close() {
    this.alive = false;
  }
}

/** Picks the JSON-RPC response with the matching id out of an SSE body. */
export function findSseResponse(body: string, id: number): RpcResponse | null {
  for (const event of body.split(/\n\n/)) {
    const data = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcResponse;
      if (msg.id === id) return msg;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connection pool

interface Live {
  transport: Transport;
  tools: McpTool[];
  fingerprint: string;
  lastUsed: number;
}

const pool = new Map<string, Live>();
const IDLE_MS = 5 * 60 * 1000;
let reaper: ReturnType<typeof setInterval> | null = null;

function fingerprintOf(cfg: McpServerConfig): string {
  return JSON.stringify([cfg.transport, cfg.command, cfg.args, cfg.url]);
}

function dropConnection(id: string) {
  const live = pool.get(id);
  if (live) {
    live.transport.close();
    pool.delete(id);
  }
}

function reap() {
  const now = Date.now();
  for (const [id, live] of pool) {
    if (now - live.lastUsed > IDLE_MS || !live.transport.alive) dropConnection(id);
  }
  if (pool.size === 0 && reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

async function connect(cfg: McpServerConfig): Promise<Live> {
  const existing = pool.get(cfg.id);
  if (existing && existing.transport.alive && existing.fingerprint === fingerprintOf(cfg)) {
    existing.lastUsed = Date.now();
    return existing;
  }
  dropConnection(cfg.id);
  const transport: Transport = cfg.transport === "stdio" ? new StdioTransport(cfg.command!, cfg.args ?? []) : new HttpTransport(cfg.url!);
  try {
    await transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 15000);
    await transport.notify("notifications/initialized");
    const listed = (await transport.request("tools/list", {}, 15000)) as { tools?: RawTool[] };
    const tools: McpTool[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      readOnly: t.annotations?.readOnlyHint === true,
    }));
    const live: Live = { transport, tools, fingerprint: fingerprintOf(cfg), lastUsed: Date.now() };
    pool.set(cfg.id, live);
    if (!reaper) reaper = setInterval(reap, 60000);
    return live;
  } catch (err) {
    transport.close();
    throw err;
  }
}

/** Connects (or reuses a connection) and lists tools; used by the management UI. */
export async function probeMcpServer(cfg: McpServerConfig): Promise<McpTool[]> {
  return (await connect(cfg)).tools;
}

interface CallContent {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export async function callMcpTool(cfg: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
  const live = await connect(cfg);
  live.lastUsed = Date.now();
  const result = (await live.transport.request("tools/call", { name: tool, arguments: args }, 120000)) as CallContent;
  const text = (result.content ?? [])
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[${c.type} content]`))
    .join("\n")
    .trim();
  if (result.isError) throw new Error(text || `${tool} reported an error.`);
  return text || "(no output)";
}

// ---------------------------------------------------------------------------
// Toolset merging

export const MCP_SEP = "__";

export function namespacedTool(serverId: string, tool: string): string {
  return `mcp${MCP_SEP}${serverId}${MCP_SEP}${tool}`;
}

export function parseNamespacedTool(name: string): { serverId: string; tool: string } | null {
  const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(name);
  return m ? { serverId: m[1], tool: m[2] } : null;
}

type Toolset = NonNullable<ToolContext["toolset"]>;

const CLIP = 30000;

/**
 * Appends every enabled MCP server's tools to a base toolset. Servers that fail to connect
 * are skipped so a dead server never blocks the agent. Tools without a read-only annotation
 * go through `requestApproval` before every call.
 */
export async function withMcpTools(base: Toolset, requestApproval: (label: string, tool: string) => Promise<boolean>): Promise<Toolset> {
  const servers = listMcpServers().filter((s) => s.enabled);
  if (servers.length === 0) return base;

  const defs: ToolDef[] = [];
  const meta = new Map<string, { cfg: McpServerConfig; tool: McpTool }>();
  await Promise.all(
    servers.map(async (cfg) => {
      try {
        for (const tool of await probeMcpServer(cfg)) {
          const name = namespacedTool(cfg.id, tool.name);
          defs.push({ name, description: `[${cfg.name} via MCP] ${tool.description}`.slice(0, 1024), parameters: tool.inputSchema });
          meta.set(name, { cfg, tool });
        }
      } catch {
        // Unreachable server: its tools simply do not appear this run.
      }
    }),
  );
  if (defs.length === 0) return base;

  const execute: Toolset["execute"] = async (name, args, ctx, id): Promise<{ result: unknown; images?: JobOutput[]; note?: string }> => {
    const entry = meta.get(name);
    if (!entry) return base.execute(name, args, ctx, id);
    const { cfg, tool } = entry;
    if (!tool.readOnly) {
      const argText = JSON.stringify(args);
      const label = `${cfg.name} · ${tool.name}(${argText.length > 300 ? argText.slice(0, 300) + "…" : argText})`;
      const ok = await requestApproval(label, "mcp_tool");
      if (!ok) throw new Error(`You declined the ${tool.name} call on ${cfg.name}.`);
    }
    const output = await callMcpTool(cfg, tool.name, args);
    const clipped = output.length > CLIP ? output.slice(0, CLIP) + `\n… clipped ${output.length - CLIP} characters` : output;
    return { result: { output: clipped }, note: cfg.name };
  };

  return { defs: [...base.defs, ...defs], execute };
}
