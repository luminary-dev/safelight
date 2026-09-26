import "server-only";
import { assertOutboundAllowed } from "@/lib/privacy";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/secrets/vault";

export type ProviderId = "openai" | "anthropic" | "gemini" | "openrouter" | "groq" | "mistral" | "deepseek" | "xai" | "together" | "cerebras" | "gateway";
export const PROVIDERS: ProviderId[] = ["openai", "anthropic", "gemini", "openrouter", "groq", "mistral", "deepseek", "xai", "together", "cerebras", "gateway"];

export const PROVIDER_META: Record<ProviderId, { label: string; envVar: string; placeholder: string; chat: boolean; images: boolean; defaultBaseUrl: string }> = {
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-…", chat: true, images: true, defaultBaseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…", chat: true, images: false, defaultBaseUrl: "https://api.anthropic.com" },
  gemini: { label: "Gemini", envVar: "GEMINI_API_KEY", placeholder: "AIza…", chat: true, images: true, defaultBaseUrl: "https://generativelanguage.googleapis.com" },
  openrouter: { label: "OpenRouter", envVar: "OPENROUTER_API_KEY", placeholder: "sk-or-…", chat: true, images: false, defaultBaseUrl: "https://openrouter.ai/api/v1" },
  groq: { label: "Groq", envVar: "GROQ_API_KEY", placeholder: "gsk_…", chat: true, images: false, defaultBaseUrl: "https://api.groq.com/openai/v1" },
  mistral: { label: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "…", chat: true, images: false, defaultBaseUrl: "https://api.mistral.ai/v1" },
  deepseek: { label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", placeholder: "sk-…", chat: true, images: false, defaultBaseUrl: "https://api.deepseek.com/v1" },
  xai: { label: "xAI", envVar: "XAI_API_KEY", placeholder: "xai-…", chat: true, images: false, defaultBaseUrl: "https://api.x.ai/v1" },
  together: { label: "Together", envVar: "TOGETHER_API_KEY", placeholder: "…", chat: true, images: false, defaultBaseUrl: "https://api.together.xyz/v1" },
  cerebras: { label: "Cerebras", envVar: "CEREBRAS_API_KEY", placeholder: "csk-…", chat: true, images: false, defaultBaseUrl: "https://api.cerebras.ai/v1" },
  gateway: { label: "AI Gateway", envVar: "AI_GATEWAY_API_KEY", placeholder: "vck_…", chat: true, images: false, defaultBaseUrl: "https://ai-gateway.vercel.sh/v1" },
};

function encFile(): string {
  return process.env.SAFELIGHT_KEYS_FILE ?? path.join(dataDir(), "keys.enc.json");
}

/** The pre-vault plaintext location, migrated on first read and kept as *.migrated. */
function legacyFile(): string {
  return process.env.STUDIO_KEYS_FILE ?? path.join(dataDir(), "keys.json");
}

interface ProviderEntry {
  key: string;
  baseUrl?: string;
}

type KeyStore = Partial<Record<ProviderId, ProviderEntry>>;

async function readStore(): Promise<KeyStore> {
  try {
    return await decryptJson<KeyStore>(await readFile(encFile(), "utf8"));
  } catch {
    /* fall through to migration or empty */
  }
  // One-shot migration of the plaintext file into the vault.
  try {
    const legacy = JSON.parse(await readFile(legacyFile(), "utf8")) as Partial<Record<ProviderId, string>>;
    const store: KeyStore = {};
    for (const p of PROVIDERS) if (legacy[p]) store[p] = { key: legacy[p]! };
    await writeStore(store);
    await rename(legacyFile(), `${legacyFile()}.migrated`);
    return store;
  } catch {
    return {};
  }
}

async function writeStore(store: KeyStore): Promise<void> {
  const file = encFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await encryptJson(store), { mode: 0o600 });
}

export async function getKey(provider: ProviderId): Promise<string | undefined> {
  const store = await readStore();
  return store[provider]?.key || process.env[PROVIDER_META[provider].envVar] || undefined;
}

export interface ProviderConfig {
  key?: string;
  /** Custom endpoint for Azure OpenAI, vLLM, LiteLLM proxies, and similar gateways. */
  baseUrl?: string;
}

export async function getProviderConfig(provider: ProviderId): Promise<ProviderConfig> {
  const store = await readStore();
  const entry = store[provider];
  const envBase = process.env[`SAFELIGHT_${provider.toUpperCase()}_BASE_URL`];
  return { key: entry?.key || process.env[PROVIDER_META[provider].envVar] || undefined, baseUrl: envBase || entry?.baseUrl || undefined };
}

export async function setKey(provider: ProviderId, key: string | null, baseUrl?: string | null): Promise<void> {
  const store = await readStore();
  if (key) store[provider] = { key: key.trim(), ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}) };
  else if (baseUrl !== undefined && store[provider]) {
    // Key untouched; only the base URL changes.
    if (baseUrl?.trim()) store[provider]!.baseUrl = baseUrl.trim();
    else delete store[provider]!.baseUrl;
  } else delete store[provider];
  await writeStore(store);
}

export interface KeyStatus {
  provider: ProviderId;
  label: string;
  configured: boolean;
  /** Last four characters, enough to recognise which key is set. */
  hint?: string;
  source?: "vault" | "env";
  baseUrl?: string;
  chat: boolean;
  images: boolean;
}

export async function keyStatuses(): Promise<KeyStatus[]> {
  const store = await readStore();
  return PROVIDERS.map((p) => {
    const entry = store[p];
    const fromEnv = process.env[PROVIDER_META[p].envVar];
    const key = entry?.key || fromEnv;
    return {
      provider: p,
      label: PROVIDER_META[p].label,
      configured: Boolean(key),
      hint: key ? `…${key.slice(-4)}` : undefined,
      source: entry?.key ? "vault" : fromEnv ? "env" : undefined,
      baseUrl: entry?.baseUrl,
      chat: PROVIDER_META[p].chat,
      images: PROVIDER_META[p].images,
    };
  });
}

export interface KeyValidation {
  ok: boolean;
  message: string;
}

/** One cheap authenticated call so the Keys dialog can say "works" or "wrong key" at save time. */
export async function validateKey(provider: ProviderId, key: string, baseUrl?: string): Promise<KeyValidation> {
  assertOutboundAllowed("key validation");
  const base = (baseUrl || PROVIDER_META[provider].defaultBaseUrl).replace(/\/$/, "");
  const init: RequestInit & { signal: AbortSignal } = { signal: AbortSignal.timeout(8000) };
  try {
    let res: Response;
    // Every provider except Anthropic and Gemini speaks the OpenAI wire format, so they all validate the same way.
    if (provider !== "anthropic" && provider !== "gemini") res = await fetch(`${base}/models`, { ...init, headers: { authorization: `Bearer ${key}` } });
    else if (provider === "anthropic") res = await fetch(`${base}/v1/models`, { ...init, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    else res = await fetch(`${base}/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, init);
    if (res.ok) return { ok: true, message: "Key works." };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "The provider rejected this key." };
    if (res.status === 429) return { ok: true, message: "Key works, but the account is rate-limited or out of quota." };
    return { ok: false, message: `The provider answered ${res.status}.` };
  } catch {
    return { ok: false, message: "Could not reach the provider to check the key." };
  }
}
