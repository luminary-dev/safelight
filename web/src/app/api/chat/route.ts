import type { NextRequest } from "next/server";
import { toTurns, type WireMessage } from "@/lib/chat-images";
import { streamChat } from "@/lib/ollama/client";
import { streamCloudChat } from "@/lib/providers";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { CHAT_SYSTEM_PROMPT } from "@/lib/providers/types";

export async function POST(request: NextRequest) {
  let body: { provider?: string; model?: string; messages?: WireMessage[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.model) return Response.json({ error: "Pick a chat model." }, { status: 400 });
  const provider = body.provider ?? "ollama";
  const system = CHAT_SYSTEM_PROMPT;
  const turns = await toTurns(body.messages ?? [], 40);
  try {
    let stream: ReadableStream<Uint8Array> | null = null;
    if (provider === "ollama") {
      stream = await streamChat(
        body.model,
        [{ role: "system", content: system }, ...turns.map((t) => ({ role: t.role, content: t.content, images: t.images?.map((i) => i.data) }))],
        request.signal,
      );
    } else if (PROVIDERS.includes(provider as ProviderId)) {
      stream = await streamCloudChat(provider as ProviderId, body.model, turns, request.signal, system);
    }
    if (!stream) return Response.json({ error: "Unknown provider." }, { status: 400 });
    return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed.";
    return Response.json({ error: /image|vision|multimodal/i.test(message) ? `${message} This model may not accept images; pick a vision-capable model.` : message }, { status: 502 });
  }
}
