import type { StarterPick } from "./types";

/**
 * Curated "known good" starter models. Client-safe data only — the dialog
 * renders this directly and the download API places each file by its kind.
 * Sizes are approximate (shown to the user; the real content-length wins).
 */
export const STARTER_PICKS: StarterPick[] = [
  {
    id: "starter/4x-ultrasharp",
    name: "4x-UltraSharp",
    source: "starter",
    description: "The community-favourite ESRGAN upscaler: crisp 4x upscales that hold up on skin, hair and hard edges alike.",
    whatFor: "Powers the one-click Upscale action on any Library image. If you install one extra model, make it this one.",
    files: [
      {
        name: "4x-UltraSharp.pth",
        sizeBytes: 67_010_000,
        downloadUrl: "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth?download=true",
        kind: "upscale",
      },
    ],
  },
  {
    id: "starter/realesrgan-x4plus",
    name: "RealESRGAN x4plus",
    source: "starter",
    description: "The standard Real-ESRGAN 4x general-purpose upscaler — a softer, more forgiving alternative to UltraSharp.",
    whatFor: "A second upscaler for photographic material where UltraSharp looks over-sharpened.",
    files: [
      {
        name: "RealESRGAN_x4plus.pth",
        sizeBytes: 67_040_000,
        downloadUrl: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        kind: "upscale",
      },
    ],
  },
  {
    id: "starter/qwen-image-lightning-lora",
    name: "Qwen-Image Lightning 4-step LoRA",
    source: "starter",
    description: "Distillation LoRA that cuts Qwen-Image renders from ~50 steps to 4 with a small quality trade-off.",
    whatFor: "Speeds up the house Qwen 2.1 image model dramatically — drafts in a fraction of the render time, then re-render keepers without it.",
    files: [
      {
        name: "Qwen-Image-Lightning-4steps-V1.0.safetensors",
        sizeBytes: 1_720_000_000,
        downloadUrl: "https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Lightning-4steps-V1.0.safetensors?download=true",
        kind: "lora",
      },
    ],
  },
  {
    id: "starter/flux-text-encoders",
    name: "Flux text encoders (clip_l + t5xxl fp8)",
    source: "starter",
    description: "The two text encoders every Flux checkpoint needs: CLIP-L plus the fp8 T5-XXL that fits a 26 GB machine.",
    whatFor: "Required companions if you download any Flux diffusion model from the Search tab — Flux will not run without them.",
    files: [
      {
        name: "clip_l.safetensors",
        sizeBytes: 246_140_000,
        downloadUrl: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors?download=true",
        kind: "text_encoder",
      },
      {
        name: "t5xxl_fp8_e4m3fn.safetensors",
        sizeBytes: 4_890_000_000,
        downloadUrl: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors?download=true",
        kind: "text_encoder",
      },
    ],
  },
  {
    id: "starter/birefnet",
    name: "BiRefNet (background removal)",
    source: "starter",
    description: "State-of-the-art matting model behind the Remove Background action.",
    whatFor: "Nothing to download here: the BiRefNet node fetches its own weights automatically the first time you run Remove Background.",
    note: "Auto-downloads on first use — no manual install needed.",
    files: [],
  },
];
