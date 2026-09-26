import type { NextRequest } from "next/server";
import { waitForApproval } from "@/lib/agent/approvals";
import { DESIGN_SYSTEM_PROMPT, designToolDefs, executeDesignTool } from "@/lib/agent/design-tools";
import { withMcpTools } from "@/lib/agent/mcp";
import { startDetachedRun } from "@/lib/agent/run";
import { publishRunEvent, unsubscribeRun, type RunStreamEvent, type RunSubscriber } from "@/lib/agent/run-registry";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";

/** Streams newline-delimited JSON events while the design scout searches the web and saves themes. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[]; clientId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = body.provider ?? "ollama";
  if (!body.model) return Response.json({ error: "Pick a chat model." }, { status: 400 });
  if (provider !== "ollama" && !PROVIDERS.includes(provider as ProviderId)) return Response.json({ error: "Unknown provider." }, { status: 400 });
  const turns = await toTurns(body.messages ?? [], 30);
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined;

  // Approvals publish through the registry: persisted under the run's sequence and
  // fanned out to every attached viewer, so a card answered after a reload resolves.
  let runId = "";
  const requestApproval = (label: string, tool: string) => {
    const id = crypto.randomUUID();
    publishRunEvent(runId, { type: "approval", id, path: label, tool });
    return waitForApproval(id);
  };
  const toolset = await withMcpTools({ defs: designToolDefs(), execute: (name, args) => executeDesignTool(name, args) }, requestApproval);

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
          clientId: body.clientId ?? "design",
          systemPrompt: DESIGN_SYSTEM_PROMPT,
          budget: { maxRounds: 32 },
          toolset,
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
