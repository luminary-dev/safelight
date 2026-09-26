import "server-only";
import { readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { folderForKind, hasHeadroom } from "./kinds";
import type { FileKind } from "./types";

/**
 * Resolves where downloaded models must land so ComfyUI actually sees them.
 * Source of truth is comfyui/extra_model_paths.yaml (the shared ~/models tree);
 * folders it does not map fall back to the vendored comfyui/models directory.
 */

const REPO_ROOT = path.resolve(process.cwd(), "..");
const EXTRA_PATHS_FILE = process.env.COMFY_EXTRA_MODEL_PATHS ?? path.join(REPO_ROOT, "comfyui", "extra_model_paths.yaml");
const DEFAULT_MODELS_DIR = path.join(REPO_ROOT, "comfyui", "models");

export interface ParsedExtraPaths {
  basePath?: string;
  /** folder key → list of subpaths (relative to basePath) in yaml order. */
  map: Record<string, string[]>;
}

/**
 * Minimal parser for ComfyUI's extra_model_paths.yaml shape: one or more
 * top-level sections whose entries are `key: value` or `key: |` block lists.
 * Good enough for the file we ship; not a general YAML parser.
 */
export function parseExtraModelPaths(yaml: string): ParsedExtraPaths {
  const out: ParsedExtraPaths = { map: {} };
  let currentKey: string | null = null; // key collecting block-scalar lines
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      currentKey = null; // a new top-level section
      continue;
    }
    const m = line.trim().match(/^([\w.-]+):\s*(.*)$/);
    if (m && indent <= 2) {
      const [, key, value] = m;
      currentKey = null;
      if (value === "|" || value === "") {
        currentKey = key;
        out.map[key] ??= [];
      } else if (key === "base_path") {
        out.basePath ??= value;
      } else {
        (out.map[key] ??= []).push(value);
      }
    } else if (currentKey) {
      out.map[currentKey].push(line.trim());
    }
  }
  return out;
}

/**
 * Picks the download destination among a folder key's mapped subpaths:
 * prefer the generic one whose basename equals the key (e.g. "diffusion_models"
 * over a model-specific bundle dir), else the first entry.
 */
export function pickSubpath(key: string, subpaths: string[]): string | undefined {
  return subpaths.find((s) => s === key) ?? subpaths.find((s) => path.basename(s) === key) ?? subpaths[0];
}

export interface ModelPaths {
  /** The shared models root shown in the UI. */
  root: string;
  /** folder key → absolute directory downloads land in. */
  dirs: Record<string, string>;
}

let cached: ModelPaths | null = null;

export function resolveModelPaths(): ModelPaths {
  if (cached) return cached;
  let parsed: ParsedExtraPaths = { map: {} };
  try {
    parsed = parseExtraModelPaths(readFileSync(EXTRA_PATHS_FILE, "utf8"));
  } catch {
    // No extra paths file: everything goes to the vendored ComfyUI models dir.
  }
  const base = parsed.basePath ?? DEFAULT_MODELS_DIR;
  const dirs: Record<string, string> = {};
  for (const [key, subpaths] of Object.entries(parsed.map)) {
    const sub = pickSubpath(key, subpaths);
    if (sub) dirs[key] = path.join(base, sub);
  }
  cached = { root: parsed.basePath ?? DEFAULT_MODELS_DIR, dirs };
  return cached;
}

/** Absolute directory a file of this kind must be saved into. */
export function targetDirForKind(kind: FileKind): string | null {
  const folder = folderForKind(kind);
  if (!folder) return null;
  const { dirs } = resolveModelPaths();
  // Folders the yaml does not map (e.g. upscale_models) live in ComfyUI's own tree.
  return dirs[folder] ?? path.join(DEFAULT_MODELS_DIR, folder);
}

/** Free bytes on the volume holding `dir` (walks up to the nearest existing dir). */
export function freeBytesFor(dir: string): number {
  let probe = dir;
  for (let i = 0; i < 20; i += 1) {
    try {
      const s = statfsSync(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return 0;
}

/** Disk-space gate: size + 2 GB headroom must fit before a download starts. */
export function checkDiskSpace(dir: string, sizeBytes: number | null | undefined): { ok: boolean; freeBytes: number } {
  const freeBytes = freeBytesFor(dir);
  return { ok: hasHeadroom(freeBytes, sizeBytes), freeBytes };
}
