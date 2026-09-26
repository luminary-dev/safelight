import "server-only";
import { listCompatModels, streamCompatChat } from "./openai-compat";
import type { ChatTurn, CloudChatModel, CloudImageModel } from "./types";

/**
 * OpenRouter lists hundreds of models; the picker has search, so include them all
 * and use the API's human-written "name" as the label when present.
 */
export function listOpenRouterModels(apiKey: string, baseUrl?: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  return listCompatModels("openrouter", apiKey, baseUrl);
}

/** Streams plain text deltas, matching the contract of streamOpenAIChat. */
export function streamOpenRouterChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system?: string, baseUrl?: string): Promise<ReadableStream<Uint8Array>> {
  return streamCompatChat("openrouter", apiKey, model, turns, signal, system, baseUrl);
}
