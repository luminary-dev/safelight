import { readFileSync, statfsSync } from "node:fs";
import { isComfyUp, systemStats, COMFY_URL } from "@/lib/comfy/client";
import { OLLAMA_URL } from "@/lib/ollama/client";
import { getProviderConfig, PROVIDER_META, PROVIDERS, validateKey, type ProviderId } from "@/lib/providers/keys";
import { OUTPUT_DIR } from "@/lib/safelight-files";

/**
 * Health payload. The Sidebar polls this, so the original fields (up, url,
 * stats) keep their exact shape; everything else is additive: Ollama resident
 * models, disk free for the outputs volume, and per-provider configured /
 * reachable booleans. Reachability calls the provider, so it is cached for
 * five minutes — never re-checked on every poll.
 */

interface OllamaHealth {
  up: boolean;
  url: string;
  /** Models currently resident in memory (from /api/ps). */
  models: { name: string; sizeBytes: number; vramBytes: number }[];
}

async function ollamaHealth(): Promise<OllamaHealth> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: false, url: OLLAMA_URL, models: [] };
    const data = (await res.json()) as { models?: { name: string; size?: number; size_vram?: number }[] };
    return {
      up: true,
      url: OLLAMA_URL,
      models: (data.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0, vramBytes: m.size_vram ?? 0 })),
    };
  } catch {
    return { up: false, url: OLLAMA_URL, models: [] };
  }
}

function diskHealth(): { path: string; freeBytes: number; totalBytes: number } | null {
  try {
    const s = statfsSync(OUTPUT_DIR);
    return { path: OUTPUT_DIR, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

interface ProviderHealth {
  provider: ProviderId;
  label: string;
  configured: boolean;
  /** Only meaningful when configured; checked at most every five minutes. */
  reachable: boolean;
}

const PROVIDER_CACHE_MS = 5 * 60 * 1000;
let providerCache: { at: number; data: ProviderHealth[] } | null = null;

async function providerHealth(): Promise<ProviderHealth[]> {
  if (providerCache && Date.now() - providerCache.at < PROVIDER_CACHE_MS) return providerCache.data;
  const data = await Promise.all(
    PROVIDERS.map(async (p): Promise<ProviderHealth> => {
      const { key, baseUrl } = await getProviderConfig(p);
      if (!key) return { provider: p, label: PROVIDER_META[p].label, configured: false, reachable: false };
      const check = await validateKey(p, key, baseUrl).catch(() => ({ ok: false }));
      return { provider: p, label: PROVIDER_META[p].label, configured: true, reachable: check.ok };
    }),
  );
  providerCache = { at: Date.now(), data };
  return data;
}

/**
 * Which build this server is running. The desktop shell refuses to attach to a
 * Safelight whose build differs from the one it bundles — a lingering orphaned
 * server would otherwise serve stale route code forever. Stamped by
 * desktop/assemble-web.mjs; a dev server reports "dev".
 */
function serverBuild(): string {
  for (const f of ["SAFELIGHT_BUILD_ID", ".next/BUILD_ID"]) {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      /* next candidate */
    }
  }
  return "dev";
}
const BUILD = serverBuild();

export async function GET() {
  const [up, ollama, providers] = await Promise.all([isComfyUp(), ollamaHealth(), providerHealth()]);
  const disk = diskHealth();
  if (!up) return Response.json({ up: false, url: COMFY_URL, build: BUILD, ollama, disk, providers }, { status: 200 });
  const stats = await systemStats().catch(() => null);
  return Response.json({ up: true, url: COMFY_URL, build: BUILD, stats, ollama, disk, providers });
}
