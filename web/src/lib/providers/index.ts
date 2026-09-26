import "server-only";
import { friendlyName } from "@/lib/friendly-names";
import { streamAnthropicChat, listAnthropicModels } from "./anthropic";
import { generateGeminiImages, listGeminiModels, streamGeminiChat } from "./gemini";
import { getProviderConfig, PROVIDER_META, PROVIDERS, type ProviderId } from "./keys";
import { generateOpenAIImages, listOpenAIModels, streamOpenAIChat } from "./openai";
import type { ChatTurn, CloudChatModel, CloudImageModel, CloudImageRequest, GeneratedImage } from "./types";

export interface CloudCatalog {
  chat: (CloudChatModel & { tags: string[] })[];
  images: (CloudImageModel & { tags: string[] })[];
  errors: Partial<Record<ProviderId, string>>;
}

const cache = new Map<ProviderId, { at: number; value: { chat: CloudChatModel[]; images: CloudImageModel[] } }>();
const TTL = 5 * 60 * 1000;

async function listFor(provider: ProviderId, key: string, baseUrl?: string) {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: { chat: CloudChatModel[]; images: CloudImageModel[] };
  switch (provider) {
    case "openai":
      value = await listOpenAIModels(key, baseUrl);
      break;
    case "anthropic":
      value = { chat: await listAnthropicModels(key, baseUrl), images: [] };
      break;
    case "gemini":
      value = await listGeminiModels(key, baseUrl);
      break;
  }
  cache.set(provider, { at: Date.now(), value });
  return value;
}

export function invalidateCloudCatalog() {
  cache.clear();
}

export async function cloudCatalog(): Promise<CloudCatalog> {
  const out: CloudCatalog = { chat: [], images: [], errors: {} };
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const { key, baseUrl } = await getProviderConfig(provider);
      if (!key) return;
      try {
        const { chat, images } = await listFor(provider, key, baseUrl);
        // Anthropic returns curated display names; other providers only return ids, so derive readable labels.
        out.chat.push(...chat.map((m) => ({ ...m, ...friendlyName(m.id), label: provider === "anthropic" && m.label ? m.label : friendlyName(m.id).label })));
        out.images.push(...images.map((m) => ({ ...m, ...friendlyName(m.id), label: friendlyName(m.id).label })));
      } catch (err) {
        out.errors[provider] = err instanceof Error ? err.message : `${PROVIDER_META[provider].label} failed`;
      }
    }),
  );
  const order = (p: ProviderId) => PROVIDERS.indexOf(p);
  out.chat.sort((a, b) => order(a.provider) - order(b.provider) || a.label.localeCompare(b.label));
  out.images.sort((a, b) => order(a.provider) - order(b.provider) || a.label.localeCompare(b.label));
  return out;
}

export async function streamCloudChat(provider: ProviderId, model: string, turns: ChatTurn[], signal?: AbortSignal, system?: string): Promise<ReadableStream<Uint8Array>> {
  const { key, baseUrl } = await getProviderConfig(provider);
  if (!key) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  switch (provider) {
    case "openai":
      return streamOpenAIChat(key, model, turns, signal, system, baseUrl);
    case "anthropic":
      return streamAnthropicChat(key, model, turns, signal, system, baseUrl);
    case "gemini":
      return streamGeminiChat(key, model, turns, system, baseUrl);
  }
}

export async function generateCloudImages(provider: ProviderId, model: string, req: CloudImageRequest): Promise<GeneratedImage[]> {
  const { key, baseUrl } = await getProviderConfig(provider);
  if (!key) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  switch (provider) {
    case "openai":
      return generateOpenAIImages(key, model, req, baseUrl);
    case "gemini":
      return generateGeminiImages(key, model, req, baseUrl);
    case "anthropic":
      throw new Error("Anthropic models do not generate images. Use them in Chat.");
  }
}
