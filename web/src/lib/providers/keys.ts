import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProviderId = "openai" | "anthropic" | "gemini";
export const PROVIDERS: ProviderId[] = ["openai", "anthropic", "gemini"];

export const PROVIDER_META: Record<ProviderId, { label: string; envVar: string; placeholder: string; chat: boolean; images: boolean }> = {
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-…", chat: true, images: true },
  anthropic: { label: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…", chat: true, images: false },
  gemini: { label: "Gemini", envVar: "GEMINI_API_KEY", placeholder: "AIza…", chat: true, images: true },
};

/** Keys live outside the web app, next to outputs, and are gitignored. */
const KEYS_FILE = process.env.SAFELIGHT_KEYS_FILE ?? process.env.STUDIO_KEYS_FILE ?? path.resolve(process.cwd(), "..", "data", "keys.json");

type KeyFile = Partial<Record<ProviderId, string>>;

async function readFileKeys(): Promise<KeyFile> {
  try {
    return JSON.parse(await readFile(KEYS_FILE, "utf8")) as KeyFile;
  } catch {
    return {};
  }
}

export async function getKey(provider: ProviderId): Promise<string | undefined> {
  const file = await readFileKeys();
  return file[provider] || process.env[PROVIDER_META[provider].envVar] || undefined;
}

export async function setKey(provider: ProviderId, key: string | null): Promise<void> {
  const file = await readFileKeys();
  if (key) file[provider] = key.trim();
  else delete file[provider];
  await mkdir(path.dirname(KEYS_FILE), { recursive: true });
  await writeFile(KEYS_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export interface KeyStatus {
  provider: ProviderId;
  label: string;
  configured: boolean;
  /** Last four characters, enough to recognise which key is set. */
  hint?: string;
  source?: "file" | "env";
  chat: boolean;
  images: boolean;
}

export async function keyStatuses(): Promise<KeyStatus[]> {
  const file = await readFileKeys();
  return PROVIDERS.map((p) => {
    const fromFile = file[p];
    const fromEnv = process.env[PROVIDER_META[p].envVar];
    const key = fromFile || fromEnv;
    return {
      provider: p,
      label: PROVIDER_META[p].label,
      configured: Boolean(key),
      hint: key ? `…${key.slice(-4)}` : undefined,
      source: fromFile ? "file" : fromEnv ? "env" : undefined,
      chat: PROVIDER_META[p].chat,
      images: PROVIDER_META[p].images,
    };
  });
}
