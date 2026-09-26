import "server-only";
import { assertOutboundAllowed } from "@/lib/privacy";
import { friendlyName } from "@/lib/friendly-names";
import { streamAnthropicChat, listAnthropicModels } from "./anthropic";
import { generateGeminiImages, listGeminiModels, streamGeminiChat } from "./gemini";
import { listGroqModels, streamGroqChat } from "./groq";
import { getProviderConfig, PROVIDER_META, PROVIDERS, type ProviderId } from "./keys";
import { generateOpenAIImages, listOpenAIModels, streamOpenAIChat } from "./openai";
import { listCompatModels, streamCompatChat } from "./openai-compat";
import { listOpenRouterModels, streamOpenRouterChat } from "./openrouter";
import type { ChatTurn, CloudChatModel, CloudImageModel, CloudImageRequest, GeneratedImage } from "./types";

/** Only OpenAI and Gemini serve image models; every other provider returns an empty image list. */
export type CloudImageProvider = Extract<ProviderId, "openai" | "gemini">;

export interface CloudCatalog {
  chat: (CloudChatModel & { tags: string[] })[];
  images: (Omit<CloudImageModel, "provider"> & { provider: CloudImageProvider; tags: string[] })[];
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
    case "openrouter":
      value = await listOpenRouterModels(key, baseUrl);
      break;
    case "groq":
      value = await listGroqModels(key, baseUrl);
      break;
    case "mistral":
    case "deepseek":
    case "xai":
    case "together":
    case "cerebras":
    case "gateway":
      value = await listCompatModels(provider, key, baseUrl);
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
  // BUG FIX: this was the one outbound feature without a local-only guard — with
  // the master switch on and a key configured, listing models still called every
  // provider. Local only means the cloud catalog is simply empty (local models
  // keep working); the guard logs the refusal like every other blocked feature.
  try {
    assertOutboundAllowed("provider catalog");
  } catch {
    return out;
  }
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const { key, baseUrl } = await getProviderConfig(provider);
      if (!key) return;
      try {
        const { chat, images } = await listFor(provider, key, baseUrl);
        // Anthropic, OpenRouter, and Together return curated display names; other providers only return ids, so derive readable labels.
        const curated = provider === "anthropic" || provider === "openrouter" || provider === "together";
        out.chat.push(...chat.map((m) => ({ ...m, ...friendlyName(m.id), label: curated && m.label ? m.label : friendlyName(m.id).label })));
        // Safe narrowing: the openai/gemini adapters only ever emit their own provider id, and the rest return no image models.
        out.images.push(...images.map((m) => ({ ...m, provider: m.provider as CloudImageProvider, ...friendlyName(m.id), label: friendlyName(m.id).label })));
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
  assertOutboundAllowed("cloud chat");
  const { key, baseUrl } = await getProviderConfig(provider);
  if (!key) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  switch (provider) {
    case "openai":
      return streamOpenAIChat(key, model, turns, signal, system, baseUrl);
    case "anthropic":
      return streamAnthropicChat(key, model, turns, signal, system, baseUrl);
    case "gemini":
      return streamGeminiChat(key, model, turns, system, baseUrl);
    case "openrouter":
      return streamOpenRouterChat(key, model, turns, signal, system, baseUrl);
    case "groq":
      return streamGroqChat(key, model, turns, signal, system, baseUrl);
    case "mistral":
    case "deepseek":
    case "xai":
    case "together":
    case "cerebras":
    case "gateway":
      return streamCompatChat(provider, key, model, turns, signal, system, baseUrl);
  }
}

export async function generateCloudImages(provider: ProviderId, model: string, req: CloudImageRequest): Promise<GeneratedImage[]> {
  assertOutboundAllowed("cloud image generation");
  const { key, baseUrl } = await getProviderConfig(provider);
  if (!key) throw new Error(`No ${PROVIDER_META[provider].label} API key configured.`);
  switch (provider) {
    case "openai":
      return generateOpenAIImages(key, model, req, baseUrl);
    case "gemini":
      return generateGeminiImages(key, model, req, baseUrl);
    case "anthropic":
    case "openrouter":
    case "groq":
    case "mistral":
    case "deepseek":
    case "xai":
    case "together":
    case "cerebras":
    case "gateway":
      throw new Error(`${PROVIDER_META[provider].label} models do not generate images. Use them in Chat.`);
  }
}
