export type Mode = "txt2img" | "img2img";

export type ModelFamily = "qwen-image" | "flux" | "sdxl" | "sd15" | "unknown" | "cloud";

/** Text encoders a family can actually drive; a mismatched encoder always crashes in the sampler. */
const TE_COMPAT: Partial<Record<ModelFamily, RegExp>> = {
  "qwen-image": /qwen_?3_?vl|qwen3vl/,
};

export function teCompatible(family: ModelFamily, name: string): boolean {
  const re = TE_COMPAT[family];
  return !re || re.test(name.toLowerCase());
}

export type ModelFolder = "unet_gguf" | "diffusion_models" | "checkpoints" | "cloud";

export type CloudProvider = "openai" | "anthropic" | "gemini";

export interface ModelEntry {
  /** File name as ComfyUI reports it, may include a subfolder prefix. */
  name: string;
  folder: ModelFolder;
  family: ModelFamily;
  /** Short display name without extension or folder. */
  label: string;
  /** Quantization or precision hint pulled from the file name, e.g. Q4_K_M, int8, bf16. */
  precision?: string;
  /** Short qualifiers for display, e.g. ["Q4_K_M", "uncensored"]. */
  tags?: string[];
  /** Set for cloud models: which API serves them. */
  provider?: CloudProvider;
  /** Cloud models: whether input images are accepted for editing. */
  edit?: boolean;
}

export interface ModelCatalog {
  models: ModelEntry[];
  textEncoders: string[];
  vaes: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
  /** Whether the local ComfyUI backend answered. Cloud models work without it. */
  online: boolean;
  cloudErrors?: Partial<Record<CloudProvider, string>>;
}

export interface LoraChoice {
  name: string;
  strength: number;
}

export interface GenerateRequest {
  mode: Mode;
  model: { name: string; folder: ModelFolder; provider?: CloudProvider };
  /** Text encoder file(s). Qwen and SD need one, Flux needs [t5, clip_l]. Ignored for checkpoints. */
  textEncoders: string[];
  /** VAE file. Ignored for checkpoints unless provided. */
  vae?: string;
  lora?: LoraChoice | null;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  batch: number;
  /** img2img strength for SD-style models, 0..1. Qwen edits ignore this. */
  denoise: number;
  /** Uploaded input file names living in ComfyUI's input directory. */
  images: string[];
  /** Qwen reference resolution budget (side length). 0 keeps each reference at native size. */
  refResolution: number;
  /** For Qwen edits: when true the output canvas follows the first input image. */
  matchInputSize: boolean;
}

/** One-click image actions that run through their own small graphs rather than a render. */
export type ImageActionMode = "upscale" | "rmbg";

export interface ImageActionRequest {
  mode: ImageActionMode;
  /** ComfyUI-style image reference, e.g. "safelight/x.png [output]". */
  image: string;
  /** Upscale only: file name inside the upscale_models folder. Defaults to the first installed. */
  upscaleModel?: string;
}

/** What the connected ComfyUI can do for Stage actions right now. */
export interface ImageCapabilities {
  online: boolean;
  upscaleModels: string[];
  removeBackground: { node: boolean; models: string[] };
}

export interface JobOutput {
  filename: string;
  subfolder: string;
  type: string;
}

export type JobState = "queued" | "running" | "done" | "error";

export interface JobStatus {
  id: string;
  state: JobState;
  outputs: JobOutput[];
  error?: string;
}

export interface GalleryItem extends JobOutput {
  mtime: number;
  size: number;
}
