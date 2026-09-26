import type { FileKind } from "./types";

/**
 * Pure, client-safe helpers: file-kind classification, kind → ComfyUI folder
 * mapping, byte formatting and the disk-headroom rule. No node imports here —
 * the dialog uses these too.
 */

/** ComfyUI folder key for each kind (matches folder_paths.py names). */
export const KIND_FOLDER: Record<Exclude<FileKind, "unknown">, string> = {
  checkpoint: "checkpoints",
  diffusion: "diffusion_models",
  text_encoder: "text_encoders",
  vae: "vae",
  lora: "loras",
  upscale: "upscale_models",
  controlnet: "controlnet",
};

export const KIND_LABEL: Record<FileKind, string> = {
  checkpoint: "Checkpoint",
  diffusion: "Diffusion model (UNet)",
  text_encoder: "Text encoder",
  vae: "VAE",
  lora: "LoRA",
  upscale: "Upscaler",
  controlnet: "ControlNet",
  unknown: "Unknown",
};

export const SELECTABLE_KINDS: Exclude<FileKind, "unknown">[] = ["checkpoint", "diffusion", "text_encoder", "vae", "lora", "upscale", "controlnet"];

export function folderForKind(kind: FileKind): string | null {
  return kind === "unknown" ? null : KIND_FOLDER[kind];
}

export const MODEL_FILE_EXT = /\.(gguf|safetensors|sft|ckpt|pt|pth|bin|onnx)$/i;

/** Best-effort kind from a file name (plus an optional source hint like a Civitai type). */
export function classifyKind(fileName: string, hint?: string): FileKind {
  const h = (hint ?? "").toLowerCase();
  if (h) {
    if (h === "vae") return "vae";
    if (h === "lora" || h === "locon" || h === "dora") return "lora";
    if (h === "checkpoint") return "checkpoint";
    if (h === "upscaler") return "upscale";
    if (h === "controlnet") return "controlnet";
  }

  const n = fileName.toLowerCase();
  // Order matters: the most specific markers first.
  if (/(^|[\/_.-])vae([\/_.-]|$)/.test(n)) return "vae";
  if (/lora|lycoris|locon/.test(n)) return "lora";
  if (/esrgan|upscal|ultrasharp|(^|[\/_-])[0-9]+x[_-]/.test(n)) return "upscale";
  if (/controlnet|control[_-]/.test(n)) return "controlnet";
  if (/clip[_-]?[lgh]|t5xxl|umt5|text[_-]?encoder|byt5|(^|[\/_-])te([\/_.-]|$)|qwen(2\.5|3)?[_-]?vl/.test(n)) return "text_encoder";
  if (/\.gguf$/.test(n)) return "diffusion"; // GGUF quants are UNet weights unless named as encoders above
  if (/unet|diffusion[_-]?model|transformer/.test(n)) return "diffusion";
  if (h === "model" || /checkpoint|(^|[\/_-])ckpt/.test(n)) return "checkpoint";
  return "unknown";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const HEADROOM_BYTES = 2 * 1024 * 1024 * 1024; // keep 2 GB free after the download

/** True when a download of `sizeBytes` (unknown → 0) fits with 2 GB of headroom left. */
export function hasHeadroom(freeBytes: number, sizeBytes: number | null | undefined): boolean {
  return freeBytes >= (sizeBytes ?? 0) + HEADROOM_BYTES;
}
