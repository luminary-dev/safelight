/** Shared types for the in-app model manager (search, download, registry). */

export type ModelSource = "hf" | "civitai" | "starter";

/** What a file is, which decides the models subfolder it lands in. */
export type FileKind = "checkpoint" | "diffusion" | "text_encoder" | "vae" | "lora" | "upscale" | "controlnet" | "unknown";

export interface RemoteFile {
  name: string;
  sizeBytes: number | null;
  downloadUrl: string;
  sha256?: string;
  kind: FileKind;
}

export interface SearchResult {
  id: string;
  name: string;
  source: ModelSource;
  description: string;
  nsfw?: boolean;
  files: RemoteFile[];
}

/** A curated "known good" model with plain-language guidance. */
export interface StarterPick extends SearchResult {
  source: "starter";
  /** One sentence: what this is for inside Safelight. */
  whatFor: string;
  /** Optional note shown instead of a Download button (e.g. auto-downloading models). */
  note?: string;
}

export type DownloadState = "downloading" | "done" | "error" | "cancelled";

export interface DownloadProgress {
  id: string;
  /** Final absolute file path the download lands at. */
  file: string;
  received: number;
  total: number | null;
  state: DownloadState;
  error?: string;
}
