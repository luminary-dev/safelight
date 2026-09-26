import { describe, expect, it } from "vitest";
import type { ModelFamily } from "./types";
import { classifyFamily } from "./models";

/** Real-world filenames and the family each must land in. */
const FIXTURES: [string, ModelFamily][] = [
  // Qwen-Image line (including edit variants, which share the graph today)
  ["qwen-image-2.1-Q4_K_M.gguf", "qwen-image"],
  ["Qwen_Image_2.1_uncensored_Q5_K_M.gguf", "qwen-image"],
  ["qwenimage-v1.safetensors", "qwen-image"],
  ["qwen-image-edit-2511-Q4_K_M.gguf", "qwen-image"],
  // Flux line — flux2 files also land here since the dedicated family was removed
  ["flux1-dev-Q8_0.gguf", "flux"],
  ["FLUX.1-schnell-fp8.safetensors", "flux"],
  ["flux1-kontext-dev-Q4_K_S.gguf", "flux"],
  ["flux-2-klein-9b-Q4_K_M.gguf", "flux"],
  // SDXL family and its finetune ecosystem
  ["sd_xl_base_1.0.safetensors", "sdxl"],
  ["juggernautXL_v9.safetensors", "sdxl"],
  ["ponyDiffusionV6XL.safetensors", "sdxl"],
  ["illustriousXL_v01.safetensors", "sdxl"],
  ["noobaiXLNAIXL_epsilon.safetensors", "sdxl"],
  ["animagineXL_v31.safetensors", "sdxl"],
  ["realvisxlV40.safetensors", "sdxl"],
  // SD 1.5
  ["v1-5-pruned-emaonly.ckpt", "sd15"],
  ["sd-1.5-inpainting.safetensors", "sd15"],
  ["dreamshaper_8.safetensors", "sd15"],
  ["realisticVisionV60.safetensors", "sd15"],
  // Unknown stays unknown rather than guessing
  ["mystery-model.safetensors", "unknown"],
  ["hunyuan_dit_1.2.safetensors", "unknown"],
];

describe("classifyFamily", () => {
  it.each(FIXTURES)("%s → %s", (name, family) => {
    expect(classifyFamily(name)).toBe(family);
  });

  it("is case-insensitive", () => {
    expect(classifyFamily("QWEN-IMAGE-2.1.GGUF")).toBe("qwen-image");
    expect(classifyFamily("FLUX1-DEV.SAFETENSORS")).toBe("flux");
  });
});
