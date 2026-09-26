import type { NextRequest } from "next/server";
import { waitForApproval } from "@/lib/agent/approvals";
import { withMcpTools } from "@/lib/agent/mcp";
import { AGENT_SYSTEM_PROMPT, runAgent } from "@/lib/agent/run";
import { executeTool, TOOLS, type AgentEvent } from "@/lib/agent/tools";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";

interface WireParams {
  temperature?: unknown;
  topP?: unknown;
  maxTokens?: unknown;
}

/** Clamps client-sent sampling params to sane ranges; anything non-numeric is dropped. */
function sanitizeParams(p: WireParams | undefined): { temperature?: number; topP?: number; maxTokens?: number } | undefined {
  if (!p || typeof p !== "object") return undefined;
  const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const out = {
    temperature: clamp(p.temperature, 0, 2),
    topP: clamp(p.topP, 0, 1),
    maxTokens: (() => {
      const v = clamp(p.maxTokens, 1, 1_000_000);
      return v === undefined ? undefined : Math.floor(v);
    })(),
  };
  return out.temperature !== undefined || out.topP !== undefined || out.maxTokens !== undefined ? out : undefined;
}

/** Streams newline-delimited JSON events while the agent works through its tool loop. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[]; preferredModel?: string; clientId?: string; system?: string; params?: WireParams; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = body.provider ?? "ollama";
  if (!body.model) return Response.json({ error: "Pick a chat model." }, { status: 400 });
  if (provider !== "ollama" && !PROVIDERS.includes(provider as ProviderId)) return Response.json({ error: "Unknown provider." }, { status: 400 });
  const turns = await toTurns(body.messages ?? [], 30);
  const params = sanitizeParams(body.params);
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined;
  // The per-session system prompt is appended to the default so agent instructions survive.
  const systemPrompt = typeof body.system === "string" && body.system.trim() ? `${AGENT_SYSTEM_PROMPT}\n\n${body.system.trim()}` : undefined;

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
          systemPrompt,
          emit,
          signal: request.signal,
          toolset,
          params,
          projectId,
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
