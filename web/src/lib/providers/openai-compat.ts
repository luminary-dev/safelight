import "server-only";
import OpenAI from "openai";
import { friendlyName } from "@/lib/friendly-names";
import { PROVIDER_META, type ProviderId } from "./keys";
import { toOpenAIMessages } from "./openai";
import type { ChatTurn, CloudChatModel, CloudImageModel } from "./types";
import { CHAT_SYSTEM_PROMPT } from "./types";

/**
 * One generic adapter for every provider that speaks the OpenAI wire format:
 * GET {base}/models with a Bearer key, and streaming chat completions.
 * The base URL and label come from PROVIDER_META, so adding a provider is
 * a PROVIDER_META entry plus the dispatch lines in index.ts.
 */

interface CompatModelEntry {
  id?: string;
  /** OpenRouter's human-written label. */
  name?: string;
  /** Together's human-written label. */
  display_name?: string;
}

/** Providers whose /models returns a curated human name worth showing verbatim; the rest prettify ids. */
const API_NAMED: ReadonlySet<ProviderId> = new Set<ProviderId>(["openrouter", "together"]);

export async function listCompatModels(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  const { label, defaultBaseUrl } = PROVIDER_META[provider];
  const base = (baseUrl || defaultBaseUrl).replace(/\/$/, "");
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`${label} answered ${res.status}.`);
  // Together returns a bare array; everyone else wraps the list in { data: [...] }.
  const body = (await res.json()) as CompatModelEntry[] | { data?: CompatModelEntry[] };
  const entries = Array.isArray(body) ? body : (body.data ?? []);
  const chat = entries
    .filter((m): m is CompatModelEntry & { id: string } => Boolean(m.id))
    .map((m) => ({
      provider,
      id: m.id,
      label: API_NAMED.has(provider) ? m.display_name?.trim() || m.name?.trim() || m.id : friendlyName(m.id).label,
    }));
  chat.sort((a, b) => a.label.localeCompare(b.label));
  return { chat, images: [] };
}

/** Streams plain text deltas, matching the contract of streamOpenAIChat. */
export async function streamCompatChat(provider: ProviderId, apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system: string = CHAT_SYSTEM_PROMPT, baseUrl?: string): Promise<ReadableStream<Uint8Array>> {
  const client = new OpenAI({ apiKey, baseURL: baseUrl || PROVIDER_META[provider].defaultBaseUrl });
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
