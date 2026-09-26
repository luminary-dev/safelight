import "server-only";
import { COMFY_URL } from "@/lib/comfy/client";
import type { Blueprint, BlueprintStatus } from "./types";

/** What the gate checks against: which node classes and model files the backend actually has. */
export interface Installed {
  nodeClasses: Set<string>;
  /** Model files as ComfyUI lists them, plus bare basenames for subfolder-agnostic matching. */
  modelFiles: Set<string>;
}

/**
 * Pure gating: a blueprint is ready only when every node class and model file it bakes in is
 * installed. Honest by design — on most machines the video/audio models are absent, and the
 * missing lists are exactly what the model manager needs to fetch.
 */
export function computeStatus(spec: Pick<Blueprint, "requiredNodeClasses" | "requiredModels">, installed: Installed | null): BlueprintStatus {
  if (!installed) return { status: "unknown", missingNodeClasses: [], missingModels: [] };
  const missingNodeClasses = spec.requiredNodeClasses.filter((c) => !installed.nodeClasses.has(c));
  const missingModels = spec.requiredModels.filter((m) => {
    const base = m.split(/[\\/]/).pop() ?? m;
    return !installed.modelFiles.has(m) && !installed.modelFiles.has(base);
  });
  return {
    status: missingNodeClasses.length === 0 && missingModels.length === 0 ? "ready" : "missing",
    missingNodeClasses,
    missingModels,
  };
}

async function comfyJson<T>(path: string): Promise<T> {
  const res = await fetch(`${COMFY_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ComfyUI ${path} failed with ${res.status}`);
  return (await res.json()) as T;
}

async function fetchInstalled(): Promise<Installed> {
  // /object_info without a class returns every registered node; one call gates all blueprints.
  const info = await comfyJson<Record<string, unknown>>("/object_info");
  const nodeClasses = new Set(Object.keys(info));

  const modelFiles = new Set<string>();
  let folders: string[] = [];
  try {
    folders = await comfyJson<string[]>("/models");
  } catch {
    folders = [];
  }
  const lists = await Promise.all(
    folders.map(async (folder) => {
      try {
        return await comfyJson<string[]>(`/models/${encodeURIComponent(folder)}`);
      } catch {
        return [] as string[];
      }
    }),
  );
  for (const list of lists) {
    for (const name of list) {
      modelFiles.add(name);
      const base = name.split(/[\\/]/).pop();
      if (base) modelFiles.add(base);
    }
  }
  return { nodeClasses, modelFiles };
}

let cache: { at: number; installed: Installed } | null = null;
const TTL_MS = 5 * 60_000;

/** Fetches (and briefly caches) what the backend has installed. Null when ComfyUI is offline. */
export async function getInstalled(): Promise<Installed | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.installed;
  try {
    const installed = await fetchInstalled();
    cache = { at: Date.now(), installed };
    return installed;
  } catch {
    return null;
  }
}

/** Test hook / manual refresh. */
export function resetInstalledCache(): void {
  cache = null;
}
