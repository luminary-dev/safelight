import "server-only";
import { listCompatModels, streamCompatChat } from "./openai-compat";
import type { ChatTurn, CloudChatModel, CloudImageModel } from "./types";

/** Groq's /models only returns ids, so labels are derived with friendlyName. */
export function listGroqModels(apiKey: string, baseUrl?: string): Promise<{ chat: CloudChatModel[]; images: CloudImageModel[] }> {
  return listCompatModels("groq", apiKey, baseUrl);
}

/** Streams plain text deltas, matching the contract of streamOpenAIChat. */
export function streamGroqChat(apiKey: string, model: string, turns: ChatTurn[], signal?: AbortSignal, system?: string, baseUrl?: string): Promise<ReadableStream<Uint8Array>> {
  return streamCompatChat("groq", apiKey, model, turns, signal, system, baseUrl);
}
