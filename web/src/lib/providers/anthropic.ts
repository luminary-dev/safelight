import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, CloudChatModel } from "./types";
import { CHAT_SYSTEM_PROMPT } from "./types";

function client(apiKey: string) {
  return new Anthropic({ apiKey });
}

export async function listAnthropicModels(apiKey: string): Promise<CloudChatModel[]> {
  const models: CloudChatModel[] = [];
  for await (const m of client(apiKey).models.list()) {
    models.push({ provider: "anthropic", id: m.id, label: m.display_name ?? m.id });
  }
  return models;
}

type ImageMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function toAnthropicMessages(turns: ChatTurn[]): Anthropic.MessageParam[] {
  return turns.map((t) => {
    if (t.role === "assistant" || !t.images?.length) return { role: t.role, content: t.content };
    const blocks: Anthropic.ContentBlockParam[] = [
      ...t.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: (img.mime as ImageMedia) ?? "image/png", data: img.data } })),
      { type: "text" as const, text: t.content || "Describe this image." },
    ];
    return { role: "user", content: blocks };
  });
}

export async function streamAnthropicChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system: string = CHAT_SYSTEM_PROMPT): Promise<ReadableStream<Uint8Array>> {
  const messages = toAnthropicMessages(turns);
  const stream = client(apiKey).messages.stream(
    {
      model,
      max_tokens: 8000,
      system,
      messages,
    },
    { signal },
  );
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(encoder.encode("\n[The model declined this request.]"));
        }
        controller.close();
      } catch (err) {
        const message = err instanceof Anthropic.APIError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : "stream error";
        controller.enqueue(encoder.encode(`\n[${message}]`));
        controller.close();
      }
    },
  });
}
