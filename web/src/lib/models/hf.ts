import "server-only";
import { MODEL_FILE_EXT, classifyKind } from "./kinds";
import type { RemoteFile, SearchResult } from "./types";

/**
 * Hugging Face search client. Uses the public hub API; HF_TOKEN (optional,
 * never logged) unlocks gated repos. File sizes and sha256 hashes come from
 * the per-repo tree endpoint's LFS metadata.
 */

const HF_API = "https://huggingface.co";
const TREE_FETCH_LIMIT = 8; // repos whose file lists we resolve per search

interface HfModelHit {
  id: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
}

interface HfTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  lfs?: { oid: string; size: number };
}

function hfHeaders(): Record<string, string> {
  return process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
}

function describe(hit: HfModelHit): string {
  const bits: string[] = [];
  if (hit.pipeline_tag) bits.push(hit.pipeline_tag.replace(/-/g, " "));
  if (typeof hit.downloads === "number") bits.push(`${Intl.NumberFormat("en", { notation: "compact" }).format(hit.downloads)} downloads`);
  if (typeof hit.likes === "number") bits.push(`${hit.likes} likes`);
  return bits.join(" · ");
}

export function normalizeHfFiles(repoId: string, entries: HfTreeEntry[]): RemoteFile[] {
  return entries
    .filter((e) => e.type === "file" && MODEL_FILE_EXT.test(e.path))
    .map((e) => ({
      name: e.path,
      sizeBytes: e.lfs?.size ?? e.size ?? null,
      downloadUrl: `${HF_API}/${repoId}/resolve/main/${e.path.split("/").map(encodeURIComponent).join("/")}?download=true`,
      sha256: e.lfs?.oid,
      kind: classifyKind(e.path),
    }));
}

export function normalizeHfHit(hit: HfModelHit, files: RemoteFile[]): SearchResult {
  return {
    id: hit.id,
    name: hit.id.split("/").pop() ?? hit.id,
    source: "hf",
    description: describe(hit),
    nsfw: hit.tags?.includes("not-for-all-audiences") || undefined,
    files,
  };
}

export async function searchHuggingFace(query: string, fetchFn: typeof fetch = fetch): Promise<SearchResult[]> {
  const url = `${HF_API}/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=${TREE_FETCH_LIMIT}`;
  const res = await fetchFn(url, { headers: hfHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Hugging Face search failed with HTTP ${res.status}.`);
  const hits = (await res.json()) as HfModelHit[];

  return Promise.all(
    hits.slice(0, TREE_FETCH_LIMIT).map(async (hit) => {
      let files: RemoteFile[] = [];
      try {
        const tree = await fetchFn(`${HF_API}/api/models/${hit.id}/tree/main?recursive=true`, { headers: hfHeaders(), cache: "no-store" });
        if (tree.ok) files = normalizeHfFiles(hit.id, (await tree.json()) as HfTreeEntry[]);
      } catch {
        // A repo whose tree cannot be read still shows up, just without files.
      }
      return normalizeHfHit(hit, files);
    }),
  );
}
