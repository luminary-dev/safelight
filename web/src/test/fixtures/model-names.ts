import type { ModelFamily } from "@/lib/comfy/types";

/**
 * ~80 real-looking model file names with the family classifyFamily() assigns
 * them (src/lib/comfy/models.ts). `family` is the classifier's contract, not
 * always the human truth — the deliberate near-misses carry a `note` saying
 * why (companion files whose names look like a family, and family models whose
 * names give the classifier nothing). `companion: true` marks files that are
 * not main image transformers (text encoders, VAEs, LoRAs, ControlNets,
 * upscalers) for catalog-filtering tests.
 */
export interface ModelNameFixture {
  name: string;
  family: ModelFamily;
  companion?: boolean;
  note?: string;
}

export const MODEL_NAME_FIXTURES: ModelNameFixture[] = [
  // ---- qwen-image ----
  { name: "qwen-image-Q4_K_M.gguf", family: "qwen-image" },
  { name: "Qwen_Image_Distill_Q5_K_S.gguf", family: "qwen-image" },
  { name: "Qwen-Image-Edit-Q8_0.gguf", family: "qwen-image" },
  { name: "qwen_image_fp8_e4m3fn.safetensors", family: "qwen-image" },
  { name: "qwen_image_edit_2509_fp8_e4m3fn.safetensors", family: "qwen-image" },
  { name: "qwenimage_bf16.safetensors", family: "qwen-image" },
  { name: "Qwen-Image-Q3_K_S.gguf", family: "qwen-image" },
  { name: "qwen image edit 2509.safetensors", family: "qwen-image" },
  { name: "QwenImage_Lightning_8step_lora.safetensors", family: "qwen-image", companion: true, note: "near-miss: a LoRA that name-classifies into the family" },

  // ---- flux ----
  { name: "flux1-dev-Q8_0.gguf", family: "flux" },
  { name: "flux1-schnell-fp8.safetensors", family: "flux" },
  { name: "FLUX.1-Krea-dev_Q4_K_M.gguf", family: "flux" },
  { name: "flux1-fill-dev.safetensors", family: "flux" },
  { name: "flux_dev_fp8_scaled.safetensors", family: "flux" },
  { name: "flux1-kontext-dev-Q6_K.gguf", family: "flux" },
  { name: "flux1-dev-fp8-e4m3fn.safetensors", family: "flux" },
  { name: "PixelWave_FLUX.1-dev_03.safetensors", family: "flux" },
  { name: "flux-hyp8-Q5_K_M.gguf", family: "flux" },
  { name: "flux_vae.safetensors", family: "flux", companion: true, note: "near-miss from the brief: a VAE, classified flux by name" },
  { name: "flux1-canny-controlnet.safetensors", family: "flux", companion: true, note: "near-miss: ControlNet, classified flux by name" },
  { name: "flux1-turbo-alpha-lora.safetensors", family: "flux", companion: true, note: "near-miss: LoRA, classified flux by name" },

  // ---- sdxl ----
  { name: "sd_xl_base_1.0.safetensors", family: "sdxl" },
  { name: "sd_xl_refiner_1.0.safetensors", family: "sdxl" },
  { name: "sdxl_lightning_4step.safetensors", family: "sdxl" },
  { name: "sdxl_turbo_1.0_fp16.safetensors", family: "sdxl" },
  { name: "juggernautXL_v9Rdphoto2.safetensors", family: "sdxl" },
  { name: "ponyDiffusionV6XL.safetensors", family: "sdxl" },
  { name: "pony_realism_v22.safetensors", family: "sdxl" },
  { name: "cyberrealisticPony_v65.safetensors", family: "sdxl" },
  { name: "illustriousXL_v01.safetensors", family: "sdxl" },
  { name: "waiNSFWIllustrious_v120.safetensors", family: "sdxl" },
  { name: "noobaiXLNAIXL_epsilonPred10.safetensors", family: "sdxl" },
  { name: "realvisxlV50_v50Bakedvae.safetensors", family: "sdxl" },
  { name: "animagine-xl-4.0.safetensors", family: "sdxl" },
  { name: "animaginexl_v31.safetensors", family: "sdxl" },
  { name: "dreamshaperXL_v21TurboDPMSDE.safetensors", family: "sdxl" },
  { name: "leosamsHelloworldXL_helloworldXL70.safetensors", family: "sdxl" },
  { name: "epicrealismXL_vxviLastfameRealism.safetensors", family: "sdxl" },
  { name: "sdxl_vae.safetensors", family: "sdxl", companion: true, note: "near-miss: the SDXL VAE, not a checkpoint" },
  { name: "sdxl_lora_detail.safetensors", family: "sdxl", companion: true, note: "near-miss from the brief: LoRA, classified sdxl by name" },
  { name: "lcm-lora-sdxl.safetensors", family: "sdxl", companion: true, note: "near-miss: LoRA, classified sdxl by name" },
  { name: "t5xxl_fp16.safetensors", family: "sdxl", companion: true, note: "near-miss: a Flux/SD3 text encoder — 'xxl_' trips the xl[-_] rule" },
  { name: "t5xxl_fp8_e4m3fn.safetensors", family: "sdxl", companion: true, note: "near-miss: text encoder, same 'xxl_' trap" },
  { name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", family: "sdxl", companion: true, note: "near-miss: WAN text encoder — 'xxl_' trips the xl[-_] rule" },
  { name: "pixart_sigma_xl_2_1024.safetensors", family: "sdxl", note: "near-miss: PixArt-Σ, classified sdxl because of 'xl_'" },

  // ---- sd15 ----
  { name: "v1-5-pruned-emaonly.safetensors", family: "sd15" },
  { name: "sd-v1-5-inpainting.ckpt", family: "sd15" },
  { name: "sd15_photorealistic.ckpt", family: "sd15" },
  { name: "sd-1.5-pruned.safetensors", family: "sd15" },
  { name: "dreamshaper_8.safetensors", family: "sd15" },
  { name: "realisticVisionV60B1_v51HyperVAE.safetensors", family: "sd15" },
  { name: "realisticVisionV51_v51VAE.safetensors", family: "sd15" },
  { name: "hyper-sd15-8steps-lora.safetensors", family: "sd15", companion: true, note: "near-miss: LoRA, classified sd15 by name" },
  { name: "control_v11p_sd15_canny.pth", family: "sd15", companion: true, note: "near-miss: ControlNet, classified sd15 by name" },

  // ---- unknown: real models the classifier has no rule for ----
  { name: "majicmixRealistic_v7.safetensors", family: "unknown", note: "near-miss: an SD1.5 checkpoint the name rules cannot place" },
  { name: "anything-v3-fp16-pruned.safetensors", family: "unknown", note: "near-miss: SD1.5-based, unclassifiable by name" },
  { name: "deliberate_v2.safetensors", family: "unknown", note: "near-miss: SD1.5-based, unclassifiable by name" },
  { name: "sd3.5_large_fp8.safetensors", family: "unknown", note: "SD3.5 is not a supported family; the sd15 rule must not fire on '3.5'" },
  { name: "z-image-turbo_fp8.safetensors", family: "unknown", note: "'image' alone must not classify as qwen-image" },
  { name: "chroma-unlocked-v37.safetensors", family: "unknown" },
  { name: "auraflow_v03.safetensors", family: "unknown", note: "'flow' must not match the flux rule" },
  { name: "ltx-video-2b-v0.9.safetensors", family: "unknown" },
  { name: "wan2.2_t2v_14B_Q5_K_M.gguf", family: "unknown" },
  { name: "wan2.1_i2v_480p_14B_fp8.safetensors", family: "unknown" },
  { name: "hunyuan_video_720_fp8.safetensors", family: "unknown" },
  { name: "hidream_i1_full_fp16.safetensors", family: "unknown" },
  { name: "kolors_unet_fp16.safetensors", family: "unknown" },
  { name: "lumina_next_sft.safetensors", family: "unknown" },
  { name: "playground-v2.5-1024px.safetensors", family: "unknown" },
  { name: "stable_cascade_stage_c.safetensors", family: "unknown" },

  // ---- unknown: companions with family-neutral names ----
  { name: "clip_l.safetensors", family: "unknown", companion: true },
  { name: "clip_g.safetensors", family: "unknown", companion: true },
  { name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", family: "unknown", companion: true, note: "Qwen text encoder — must NOT classify as qwen-image" },
  { name: "qwen_3_vl_7b_bf16.safetensors", family: "unknown", companion: true, note: "Qwen3-VL text encoder — must NOT classify as qwen-image" },
  { name: "ae.safetensors", family: "unknown", companion: true, note: "the Flux VAE's real published name" },
  { name: "wan_2.1_vae.safetensors", family: "unknown", companion: true },
  { name: "vae-ft-mse-840000-ema-pruned.ckpt", family: "unknown", companion: true },
  { name: "add_detail.safetensors", family: "unknown", companion: true },
  { name: "4x-UltraSharp.pth", family: "unknown", companion: true },
  { name: "RealESRGAN_x4plus.pth", family: "unknown", companion: true },
  { name: "diffusion_pytorch_model.safetensors", family: "unknown", companion: true },
  { name: "model.fp16.safetensors", family: "unknown", companion: true },

  // ---- unknown: LLM/GGUF files that live near image models ----
  { name: "qwen3-vl-8b-instruct-Q4_K_M.gguf", family: "unknown", note: "an LLM — 'qwen' without 'image' must stay unknown" },
  { name: "llama-3.3-70b-instruct-Q4_K_M.gguf", family: "unknown" },
  { name: "mistral-small-3.2-24b-Q5_K_M.gguf", family: "unknown" },
  { name: "gemma-3-27b-it-Q4_K_M.gguf", family: "unknown" },
];

/** Convenience view: names only, e.g. to stuff a fake ComfyUI folder. */
export function modelNamesByFamily(family: ModelFamily): string[] {
  return MODEL_NAME_FIXTURES.filter((f) => f.family === family).map((f) => f.name);
}
