import type { NextRequest } from "next/server";
import { waitForApproval } from "@/lib/agent/approvals";
import { withMcpTools } from "@/lib/agent/mcp";
import { AGENT_SYSTEM_PROMPT, startDetachedRun } from "@/lib/agent/run";
import { publishRunEvent, unsubscribeRun, type RunStreamEvent, type RunSubscriber } from "@/lib/agent/run-registry";
import { executeTool, TOOLS } from "@/lib/agent/tools";
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

/**
 * Starts a DETACHED agent run and streams its newline-delimited JSON events.
 * The run lives in the run registry, not in this request: when the client
 * disconnects the response merely unsubscribes and the run continues server-side
 * (re-attach via GET /api/runs/[id]/stream, cancel via POST /api/runs/[id]/stop).
 * The first line is a dedicated `{type:"run", id}` event carrying the run id.
 */
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

  // Approval events publish through the registry so they persist under the run's
  // sequence and reach every attached viewer; runId is assigned before any tool runs.
  let runId = "";
  const requestApproval = (label: string, tool: string) => {
    const id = crypto.randomUUID();
    publishRunEvent(runId, { type: "approval", id, path: label, tool });
    return waitForApproval(id);
  };
  const toolset = await withMcpTools({ defs: TOOLS, execute: executeTool }, requestApproval);

  const encoder = new TextEncoder();
  let subscriber: RunSubscriber | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (e: RunStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      const finish = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      subscriber = {
        event: (e) => send(e),
        end: () => {
          send({ type: "done" });
          finish();
        },
      };
      runId = startDetachedRun(
        provider as ProviderId | "ollama",
        body.model!,
        turns,
        {
          clientId: body.clientId ?? "agent",
          preferredModel: body.preferredModel,
          systemPrompt,
          toolset,
          params,
          projectId,
        },
        { subscriber },
      );
      send({ type: "run", id: runId });
      // A client disconnect only detaches this view; the run keeps going server-side.
      request.signal.addEventListener("abort", () => {
        if (subscriber) unsubscribeRun(runId, subscriber);
        finish();
      });
    },
    cancel() {
      if (subscriber) unsubscribeRun(runId, subscriber);
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
