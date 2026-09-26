import type { NextRequest } from "next/server";
import { DESIGN_SYSTEM_PROMPT, designToolDefs, executeDesignTool } from "@/lib/agent/design-tools";
import { runAgent } from "@/lib/agent/run";
import type { AgentEvent } from "@/lib/agent/tools";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";

/** Streams newline-delimited JSON events while the design scout searches the web and saves themes. */
export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[]; clientId?: string };
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
      try {
        await runAgent(provider as ProviderId | "ollama", body.model!, turns, {
          clientId: body.clientId ?? "design",
          emit,
          signal: request.signal,
          systemPrompt: DESIGN_SYSTEM_PROMPT,
          budget: { maxRounds: 32 },
          toolset: { defs: designToolDefs(), execute: (name, args) => executeDesignTool(name, args) },
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") emit({ type: "error", text: err instanceof Error ? err.message : "The design scout failed." });
      } finally {
        emit({ type: "done" });
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
