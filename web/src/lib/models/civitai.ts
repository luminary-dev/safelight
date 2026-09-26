import "server-only";
import { classifyKind } from "./kinds";
import type { RemoteFile, SearchResult } from "./types";

/**
 * Civitai search client. Public API; CIVITAI_API_TOKEN (optional, never
 * logged) unlocks downloads that require a logged-in account. The API's nsfw
 * flag is passed through untouched — Safelight is a local-first adult-capable
 * studio and does not filter beyond what the API returns.
 */

const CIVITAI_API = "https://civitai.com/api/v1";
const SEARCH_TYPES = ["Checkpoint", "LORA", "VAE", "Upscaler", "Controlnet"];

interface CivitaiFile {
  name: string;
  sizeKB?: number;
  downloadUrl: string;
  type?: string; // "Model" | "VAE" | "Pruned Model" | ...
  hashes?: { SHA256?: string };
}

interface CivitaiItem {
  id: number;
  name: string;
  description?: string;
  type?: string; // Checkpoint | LORA | VAE | Upscaler | Controlnet | ...
  nsfw?: boolean;
  modelVersions?: { name?: string; files?: CivitaiFile[] }[];
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function normalizeCivitaiItem(item: CivitaiItem): SearchResult {
  const version = item.modelVersions?.[0];
  const files: RemoteFile[] = (version?.files ?? []).map((f) => ({
    name: f.name,
    sizeBytes: typeof f.sizeKB === "number" ? Math.round(f.sizeKB * 1024) : null,
    downloadUrl: f.downloadUrl,
    sha256: f.hashes?.SHA256?.toLowerCase(),
    // A file marked VAE overrides the model-level type (checkpoints often ship one).
    kind: f.type === "VAE" ? "vae" : classifyKind(f.name, item.type),
  }));
  return {
    id: String(item.id),
    name: item.name,
    source: "civitai",
    description: stripHtml(item.description),
    nsfw: item.nsfw,
    files,
  };
}

export async function searchCivitai(query: string, fetchFn: typeof fetch = fetch): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query, limit: "20" });
  for (const t of SEARCH_TYPES) params.append("types", t);
  const headers: Record<string, string> = process.env.CIVITAI_API_TOKEN ? { authorization: `Bearer ${process.env.CIVITAI_API_TOKEN}` } : {};
  const res = await fetchFn(`${CIVITAI_API}/models?${params}`, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`Civitai search failed with HTTP ${res.status}.`);
  const data = (await res.json()) as { items?: CivitaiItem[] };
  return (data.items ?? []).map(normalizeCivitaiItem);
}
