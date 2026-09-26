import "server-only";
import OpenAI from "openai";
import { friendlyName } from "@/lib/friendly-names";
import { toOpenAIMessages } from "./openai";
import type { ChatTurn, CloudChatModel, CloudImageModel } from "./types";
import { CHAT_SYSTEM_PROMPT } from "./types";

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

interface GroqModelEntry {
  id?: string;
}

/** Groq's /models only returns ids, so labels are derived with friendlyName. */
export async function listGroqModels(apiKey: string, baseUrl?: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Groq answered ${res.status}.`);
  const body = (await res.json()) as { data?: GroqModelEntry[] };
  const chat = (body.data ?? [])
    .filter((m): m is GroqModelEntry & { id: string } => Boolean(m.id))
    .map((m) => ({ provider: "groq" as const, id: m.id, label: friendlyName(m.id).label }));
  chat.sort((a, b) => a.label.localeCompare(b.label));
  return { chat, images: [] };
}

/** Streams plain text deltas, matching the contract of streamOpenAIChat. */
export async function streamGroqChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system: string = CHAT_SYSTEM_PROMPT, baseUrl?: string): Promise<ReadableStream<Uint8Array>> {
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
