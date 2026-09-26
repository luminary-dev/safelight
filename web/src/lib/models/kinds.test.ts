import { describe, expect, it } from "vitest";
import { HEADROOM_BYTES, classifyKind, folderForKind, formatBytes, hasHeadroom } from "./kinds";

describe("classifyKind", () => {
  it("routes gguf unet files to the diffusion folder", () => {
    expect(classifyKind("qwen-image-2.1-Q4_K_M.gguf")).toBe("diffusion");
    expect(classifyKind("flux1-dev-Q8_0.gguf")).toBe("diffusion");
  });

  it("recognizes text encoders, including gguf ones", () => {
    expect(classifyKind("t5xxl_fp8_e4m3fn.safetensors")).toBe("text_encoder");
    expect(classifyKind("clip_l.safetensors")).toBe("text_encoder");
    expect(classifyKind("Qwen3-VL-8B-te-Q5_K_M.gguf")).toBe("text_encoder");
    expect(classifyKind("umt5_xxl_fp16.safetensors")).toBe("text_encoder");
  });

  it("recognizes vae, lora, upscalers and controlnets", () => {
    expect(classifyKind("qwen_image_vae.safetensors")).toBe("vae");
    expect(classifyKind("ae.vae.safetensors")).toBe("vae");
    expect(classifyKind("detail-tweaker-lora.safetensors")).toBe("lora");
    expect(classifyKind("4x-UltraSharp.pth")).toBe("upscale");
    expect(classifyKind("RealESRGAN_x4plus.pth")).toBe("upscale");
    expect(classifyKind("control_v11p_sd15_canny.safetensors")).toBe("controlnet");
  });

  it("prefers the source hint (Civitai model type) when given", () => {
    expect(classifyKind("mystery_file.safetensors", "LORA")).toBe("lora");
    expect(classifyKind("mystery_file.safetensors", "Checkpoint")).toBe("checkpoint");
    expect(classifyKind("mystery_file.pt", "Upscaler")).toBe("upscale");
    expect(classifyKind("mystery_file.safetensors", "VAE")).toBe("vae");
  });

  it("falls back to unknown so the UI can ask the user", () => {
    expect(classifyKind("who_knows.safetensors")).toBe("unknown");
  });
});

describe("folderForKind", () => {
  it("maps every kind to its ComfyUI folder", () => {
    expect(folderForKind("diffusion")).toBe("diffusion_models");
    expect(folderForKind("checkpoint")).toBe("checkpoints");
    expect(folderForKind("text_encoder")).toBe("text_encoders");
    expect(folderForKind("vae")).toBe("vae");
    expect(folderForKind("lora")).toBe("loras");
    expect(folderForKind("upscale")).toBe("upscale_models");
    expect(folderForKind("controlnet")).toBe("controlnet");
    expect(folderForKind("unknown")).toBeNull();
  });
});

describe("hasHeadroom (disk-check math)", () => {
  const GB = 1024 ** 3;
  it("requires size plus 2 GB of headroom", () => {
    expect(HEADROOM_BYTES).toBe(2 * GB);
    expect(hasHeadroom(10 * GB, 8 * GB)).toBe(true); // exactly size + 2 GB
    expect(hasHeadroom(10 * GB - 1, 8 * GB)).toBe(false);
    expect(hasHeadroom(3 * GB, 2 * GB)).toBe(false);
  });

  it("treats unknown sizes as zero but still keeps the headroom", () => {
    expect(hasHeadroom(2 * GB, null)).toBe(true);
    expect(hasHeadroom(2 * GB - 1, undefined)).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats sizes for the dialog", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(67_010_000)).toBe("63.9 MB");
    expect(formatBytes(4_890_000_000)).toBe("4.6 GB");
    expect(formatBytes(null)).toBe("?");
  });
});
