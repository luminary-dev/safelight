import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileKind } from "./types";

/**
 * Placement mapping end-to-end (TEST-BRIEF §10): a real extra_model_paths.yaml
 * on disk drives kind → absolute download directory. The module resolves the
 * yaml path and caches at load, so every case imports a fresh instance.
 */

let dir: string;

async function pathsWithYaml(yaml: string | null) {
  vi.resetModules();
  if (yaml === null) {
    process.env.COMFY_EXTRA_MODEL_PATHS = path.join(dir, "does-not-exist.yaml");
  } else {
    const file = path.join(dir, "extra_model_paths.yaml");
    writeFileSync(file, yaml);
    process.env.COMFY_EXTRA_MODEL_PATHS = file;
  }
  return await import("./paths");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sl-place-"));
});

afterEach(() => {
  delete process.env.COMFY_EXTRA_MODEL_PATHS;
  rmSync(dir, { recursive: true, force: true });
});

const YAML = `studio_models:
  base_path: /shared/models
  diffusion_models: |
    Some-Bundle-GGUF
    diffusion_models
  text_encoders: |
    Some-Bundle-GGUF/text_encoders
    text_encoders
  vae: vae
  checkpoints: checkpoints
  loras: loras
`;

describe("targetDirForKind", () => {
  it("routes every mapped kind into the shared tree, preferring the generic subfolder over bundle dirs", async () => {
    const p = await pathsWithYaml(YAML);
    const expected: Partial<Record<FileKind, string>> = {
      diffusion: "/shared/models/diffusion_models",
      text_encoder: "/shared/models/text_encoders",
      vae: "/shared/models/vae",
      checkpoint: "/shared/models/checkpoints",
      lora: "/shared/models/loras",
    };
    for (const [kind, wanted] of Object.entries(expected)) {
      expect(p.targetDirForKind(kind as FileKind), kind).toBe(wanted);
    }
  });

  it("kinds the yaml does not map land in the vendored ComfyUI tree, and 'unknown' gets no directory at all", async () => {
    const p = await pathsWithYaml(YAML);
    const upscale = p.targetDirForKind("upscale");
    expect(upscale).toMatch(/comfyui\/models\/upscale_models$/);
    expect(path.isAbsolute(upscale!)).toBe(true);
    expect(p.targetDirForKind("controlnet")).toMatch(/comfyui\/models\/controlnet$/);
    expect(p.targetDirForKind("unknown")).toBeNull();
  });

  it("with no yaml at all, everything falls back to the vendored models directory", async () => {
    const p = await pathsWithYaml(null);
    const resolved = p.resolveModelPaths();
    expect(resolved.dirs).toEqual({});
    expect(resolved.root).toMatch(/comfyui\/models$/);
    expect(p.targetDirForKind("diffusion")).toMatch(/comfyui\/models\/diffusion_models$/);
  });

  it("resolveModelPaths caches: editing the yaml later does not silently repoint live downloads", async () => {
    const p = await pathsWithYaml(YAML);
    expect(p.targetDirForKind("vae")).toBe("/shared/models/vae");
    writeFileSync(path.join(dir, "extra_model_paths.yaml"), YAML.replace("/shared/models", "/elsewhere"));
    expect(p.targetDirForKind("vae")).toBe("/shared/models/vae"); // same module instance keeps its resolution
  });
});
