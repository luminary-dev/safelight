import type { ControlType, GenerateRequest, JobOutput, ModelCatalog, ModelEntry, Mode } from "@/lib/comfy/types";

export interface UploadedImage {
  ref: string;
  filename: string;
  subfolder: string;
  previewUrl: string;
}

export interface Settings {
  mode: Mode;
  model: ModelEntry | null;
  textEncoders: string[];
  vae: string;
  lora: string;
  loraStrength: number;
  prompt: string;
  negativePrompt: string;
  presetId: string;
  scaleId: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  lockSeed: boolean;
  sampler: string;
  scheduler: string;
  batch: number;
  denoise: number;
  refResolution: number;
  matchInputSize: boolean;
  images: UploadedImage[];
  /** ControlNet guidance for img2img: "" is off; the reference image becomes the control map. */
  controlType: "" | ControlType;
  controlStrength: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "txt2img",
  model: null,
  textEncoders: [],
  vae: "",
  lora: "",
  loraStrength: 0.8,
  prompt: "",
  negativePrompt: "",
  presetId: "square",
  scaleId: "1",
  width: 1024,
  height: 1024,
  steps: 25,
  cfg: 1,
  seed: 0,
  lockSeed: false,
  sampler: "euler",
  scheduler: "simple",
  batch: 1,
  denoise: 0.7,
  refResolution: 1024,
  matchInputSize: true,
  images: [],
  controlType: "",
  controlStrength: 1,
};

/** Family-aware defaults so a fresh model selection produces a sane first render. */
export function defaultsForModel(model: ModelEntry, catalog: ModelCatalog): Partial<Settings> {
  // A LoRA never survives a model switch: it is trained for one transformer's shapes.
  return { lora: "", loraStrength: DEFAULT_SETTINGS.loraStrength, ...familyDefaults(model, catalog) };
}

function familyDefaults(model: ModelEntry, catalog: ModelCatalog): Partial<Settings> {
  const pick = (re: RegExp, list: string[]) => list.find((n) => re.test(n.toLowerCase()));
  switch (model.family) {
    case "cloud":
      return { textEncoders: [], vae: "", lora: "" };
    case "qwen-image":
      return {
        textEncoders: [pick(/qwen3vl[-_ ]?8b/, catalog.textEncoders) ?? pick(/qwen3vl|qwen_?3|qwen/, catalog.textEncoders) ?? catalog.textEncoders[0] ?? ""].filter(Boolean),
        vae: pick(/qwen/, catalog.vaes) ?? catalog.vaes[0] ?? "",
        steps: 25,
        cfg: 1,
        sampler: "euler",
        scheduler: "simple",
      };
    case "flux":
      return {
        textEncoders: [pick(/t5/, catalog.textEncoders), pick(/clip_l|clip-l/, catalog.textEncoders)].filter(Boolean) as string[],
        vae: pick(/flux|^ae/, catalog.vaes) ?? catalog.vaes[0] ?? "",
        steps: 20,
        cfg: 1,
        sampler: "euler",
        scheduler: "simple",
      };
    case "sdxl":
      return { textEncoders: [], vae: "", steps: 30, cfg: 6, sampler: "dpmpp_2m", scheduler: "karras" };
    case "sd15":
      return { textEncoders: [], vae: "", steps: 28, cfg: 7, sampler: "dpmpp_2m", scheduler: "karras", width: 512, height: 768 };
    default:
      return model.folder === "checkpoints"
        ? { textEncoders: [], vae: "", steps: 30, cfg: 6, sampler: "dpmpp_2m", scheduler: "karras" }
        : { textEncoders: catalog.textEncoders.slice(0, 1), vae: catalog.vaes[0] ?? "", steps: 25, cfg: 3.5 };
  }
}

export function toRequest(s: Settings, seed: number): GenerateRequest {
  return {
    mode: s.mode,
    model: { name: s.model!.name, folder: s.model!.folder, provider: s.model!.provider },
    textEncoders: s.textEncoders,
    vae: s.vae || undefined,
    lora: s.lora ? { name: s.lora, strength: s.loraStrength } : null,
    prompt: s.prompt,
    negativePrompt: s.negativePrompt,
    width: s.width,
    height: s.height,
    steps: s.steps,
    cfg: s.cfg,
    seed,
    sampler: s.sampler,
    scheduler: s.scheduler,
    batch: s.batch,
    denoise: s.denoise,
    images: s.images.map((i) => i.ref),
    refResolution: s.refResolution,
    matchInputSize: s.matchInputSize,
    control: s.mode === "img2img" && s.controlType ? { type: s.controlType, strength: s.controlStrength } : null,
  };
}

export function viewUrl(o: JobOutput): string {
  const p = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder ?? "", type: o.type ?? "output" });
  return `/api/view?${p}`;
}

export interface Job {
  id: string;
  seed: number;
  prompt: string;
  startedAt: number;
  state: "queued" | "running" | "done" | "error";
  outputs: JobOutput[];
  error?: string;
  settings: Pick<Settings, "width" | "height" | "steps" | "cfg" | "sampler" | "scheduler" | "mode"> & { model: string };
  /** Node id → class_type for the queued graph, so live progress can name the stage. */
  nodes?: Record<string, string>;
}

/** Human name for what a graph node spends its time on; the sampler is handled separately as steps. */
export function stageLabel(classType: string | undefined): string {
  switch (classType) {
    case "UnetLoaderGGUF":
    case "UNETLoader":
    case "CheckpointLoaderSimple":
      return "Loading model";
    case "CLIPLoader":
    case "CLIPLoaderGGUF":
    case "DualCLIPLoader":
      return "Loading text encoder";
    case "VAELoader":
      return "Loading VAE";
    case "LoraLoaderModelOnly":
    case "LoraLoader":
      return "Applying LoRA";
    case "CLIPTextEncode":
    case "TextEncodeQwenImage21":
      return "Encoding prompt";
    case "LoadImage":
    case "ImageScale":
    case "ImageScaleToMaxDimension":
    case "ImageScaleToTotalPixels":
    case "FluxKontextImageScale":
    case "VAEEncode":
    case "ReferenceLatent":
    case "GetImageSize":
      return "Preparing references";
    case "UpscaleModelLoader":
      return "Loading upscale model";
    case "ImageUpscaleWithModel":
      return "Upscaling";
    case "LoadBackgroundRemovalModel":
    case "RemoveBackground":
      return "Removing background";
    case "InvertMask":
    case "JoinImageWithAlpha":
    case "ImageCompositeMasked":
      return "Compositing";
    case "ImageToMask":
    case "MaskToImage":
    case "GrowMask":
    case "ImageBlur":
    case "SetLatentNoiseMask":
      return "Preparing mask";
    case "ImagePadForOutpaint":
      return "Extending canvas";
    case "ControlNetLoader":
    case "ModelPatchLoader":
      return "Loading ControlNet";
    case "ControlNetInpaintingAliMamaApply":
    case "ControlNetApplyAdvanced":
    case "QwenImageDiffsynthControlnet":
      return "Applying ControlNet";
    case "Canny":
      return "Tracing edges";
    case "KSampler":
    case "KSamplerAdvanced":
    case "SamplerCustomAdvanced":
      return "Rendering";
    case "VAEDecode":
    case "VAEDecodeTiled":
      return "Decoding image";
    case "VAEDecodeAudio":
      return "Decoding audio";
    case "SaveImage":
    case "SaveAnimatedWEBP":
    case "SaveAnimatedPNG":
      return "Saving";
    case "CreateVideo":
    case "SaveVideo":
    case "SaveWEBM":
      return "Encoding video";
    case "SaveAudio":
    case "SaveAudioMP3":
    case "SaveAudioOpus":
      return "Saving audio";
    default:
      return "Preparing";
  }
}
