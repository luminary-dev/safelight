import type { NextRequest } from "next/server";
import { waitForApproval } from "@/lib/agent/approvals";
import { withMcpTools } from "@/lib/agent/mcp";
import { runAgent } from "@/lib/agent/run";
import { executeTool, TOOLS, type AgentEvent } from "@/lib/agent/tools";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";

/** Streams newline-delimited JSON events while the agent works through its tool loop. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[]; preferredModel?: string; clientId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = body.provider ?? "ollama";
  if (!body.model) return Response.json({ error: "Pick a chat model." }, { status: 400 });
  if (provider !== "ollama" && !PROVIDERS.includes(provider as ProviderId)) return Response.json({ error: "Unknown provider." }, { status: 400 });
  const turns = await toTurns(body.messages ?? [], 30);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const requestApproval = (label: string, tool: string) => {
        const id = crypto.randomUUID();
        emit({ type: "approval", id, path: label, tool });
        return waitForApproval(id);
      };
      try {
        const toolset = await withMcpTools({ defs: TOOLS, execute: executeTool }, requestApproval);
        await runAgent(provider as ProviderId | "ollama", body.model!, turns, {
          clientId: body.clientId ?? "agent",
          preferredModel: body.preferredModel,
          emit,
          signal: request.signal,
          toolset,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") emit({ type: "error", text: err instanceof Error ? err.message : "Agent failed." });
      } finally {
        emit({ type: "done" });
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
