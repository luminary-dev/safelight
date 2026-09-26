import "server-only";
import OpenAI from "openai";
import { toOpenAIMessages } from "./openai";
import type { ChatTurn, CloudChatModel, CloudImageModel } from "./types";
import { CHAT_SYSTEM_PROMPT } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterModelEntry {
  id?: string;
  name?: string;
}

/**
 * OpenRouter lists hundreds of models; the picker has search, so include them all
 * and use the API's human-written "name" as the label when present.
 */
export async function listOpenRouterModels(apiKey: string, baseUrl?: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}.`);
  const body = (await res.json()) as { data?: OpenRouterModelEntry[] };
  const chat = (body.data ?? [])
    .filter((m): m is OpenRouterModelEntry & { id: string } => Boolean(m.id))
    .map((m) => ({ provider: "openrouter" as const, id: m.id, label: m.name?.trim() || m.id }));
  chat.sort((a, b) => a.label.localeCompare(b.label));
  return { chat, images: [] };
}

/** Streams plain text deltas, matching the contract of streamOpenAIChat. */
export async function streamOpenRouterChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system: string = CHAT_SYSTEM_PROMPT, baseUrl?: string): Promise<ReadableStream<Uint8Array>> {
  const client = new OpenAI({ apiKey, baseURL: baseUrl || DEFAULT_BASE_URL });
  const stream = await client.chat.completions.create(
    {
      model,
      stream: true,
      messages: [{ role: "system", content: system }, ...toOpenAIMessages(turns)],
    },
    { signal },
  );
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        }
        controller.close();
      } catch (err) {
        controller.enqueue(encoder.encode(`\n[${err instanceof Error ? err.message : "stream error"}]`));
        controller.close();
      }
    },
  });
}
