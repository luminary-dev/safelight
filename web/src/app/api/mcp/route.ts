import type { NextRequest } from "next/server";
import { deleteMcpServer, listMcpServers, probeMcpServer, saveMcpServer, type McpServerConfig, type McpTool } from "@/lib/agent/mcp";

export const runtime = "nodejs";

interface ServerView extends McpServerConfig {
  status: "ok" | "error" | "off";
  tools: Pick<McpTool, "name" | "description" | "readOnly">[];
  error?: string;
}

/** Lists configured MCP servers; enabled ones are probed live for their tools. */
export async function GET() {
  const servers = await Promise.all(
    listMcpServers().map(async (cfg): Promise<ServerView> => {
      if (!cfg.enabled) return { ...cfg, status: "off", tools: [] };
      try {
        const tools = await probeMcpServer(cfg);
        return { ...cfg, status: "ok", tools: tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })) };
      } catch (err) {
        return { ...cfg, status: "error", tools: [], error: err instanceof Error ? err.message : "Could not reach the server." };
      }
    }),
  );
  return Response.json({ servers });
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "server"
  );
}

/** Adds or updates a server. Args may arrive as a shell-ish string; it is split on whitespace. */
export async function POST(request: NextRequest) {
  let body: { id?: string; name?: string; transport?: string; command?: string; args?: string[] | string; url?: string; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const transport = body.transport === "http" ? "http" : body.transport === "stdio" ? "stdio" : null;
  if (!transport) return Response.json({ error: "Transport must be stdio or http." }, { status: 400 });
  const name = (body.name ?? "").trim();
  if (!name) return Response.json({ error: "Give the server a name." }, { status: 400 });
  const args = Array.isArray(body.args) ? body.args.map(String) : typeof body.args === "string" ? body.args.split(/\s+/).filter(Boolean) : [];
  const cfg: McpServerConfig = {
    id: body.id?.trim() || slugify(name),
    name,
    transport,
    ...(transport === "stdio" ? { command: (body.command ?? "").trim(), args } : {}),
    ...(transport === "http" ? { url: (body.url ?? "").trim() } : {}),
    enabled: body.enabled !== false,
  };
  try {
    saveMcpServer(cfg);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not save the server." }, { status: 400 });
  }
  return Response.json({ ok: true, id: cfg.id });
}

/** Toggles a server on or off. */
export async function PATCH(request: NextRequest) {
  let body: { id?: string; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const server = listMcpServers().find((s) => s.id === body.id);
  if (!server) return Response.json({ error: "No such server." }, { status: 404 });
  saveMcpServer({ ...server, enabled: Boolean(body.enabled) });
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Pass ?id=." }, { status: 400 });
  deleteMcpServer(id);
  return Response.json({ ok: true });
}
