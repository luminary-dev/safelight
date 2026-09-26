import { stat } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { waitForApproval } from "@/lib/agent/approvals";
import { codeSystemPrompt, codeToolDefs, executeCodeTool, type CodeAccess } from "@/lib/agent/code-tools";
import { withMcpTools } from "@/lib/agent/mcp";
import { runAgent } from "@/lib/agent/run";
import type { AgentEvent } from "@/lib/agent/tools";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";

/** Streams newline-delimited JSON events while the coding agent reads and edits files under the session's workspace folder. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[]; root?: string; approvedPaths?: string[]; clientId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = body.provider ?? "ollama";
  if (!body.model) return Response.json({ error: "Pick a chat model." }, { status: 400 });
  if (provider !== "ollama" && !PROVIDERS.includes(provider as ProviderId)) return Response.json({ error: "Unknown provider." }, { status: 400 });

  const root = typeof body.root === "string" ? body.root.trim() : "";
  if (!root || !path.isAbsolute(root)) return Response.json({ error: "Set an absolute workspace folder first." }, { status: 400 });
  if (path.resolve(root) === path.parse(root).root) return Response.json({ error: "Pick a project folder, not the whole disk." }, { status: 400 });
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return Response.json({ error: "That workspace folder does not exist." }, { status: 400 });

  const turns = await toTurns(body.messages ?? [], 30);
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const access: CodeAccess = {
        root,
        approved: (Array.isArray(body.approvedPaths) ? body.approvedPaths : []).filter((p) => typeof p === "string" && path.isAbsolute(p)),
        requestApproval: (absPath, tool) => {
          const id = crypto.randomUUID();
          emit({ type: "approval", id, path: absPath, tool });
          return waitForApproval(id);
        },
      };
      try {
        const toolset = await withMcpTools(
          { defs: codeToolDefs(), execute: (name, args) => executeCodeTool(name, args, access) },
          (label, tool) => access.requestApproval(label, tool),
        );
        await runAgent(provider as ProviderId | "ollama", body.model!, turns, {
          clientId: body.clientId ?? "code",
          emit,
          signal: request.signal,
          systemPrompt: codeSystemPrompt(root),
          budget: { maxRounds: 60 },
          toolset,
          projectId,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") emit({ type: "error", text: err instanceof Error ? err.message : "The coding agent failed." });
      } finally {
        emit({ type: "done" });
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
