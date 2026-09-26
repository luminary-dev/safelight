import { describe, expect, it } from "vitest";
import { parseExtraModelPaths, pickSubpath } from "./paths";

const YAML = `# Point ComfyUI at the shared ~/models tree so downloads live outside the repo.
studio_models:
  base_path: /Users/example/models
  diffusion_models: |
    Qwen-Image-2.1-Uncensored-GGUF
    diffusion_models
  unet: |
    Qwen-Image-2.1-Uncensored-GGUF
    diffusion_models
  text_encoders: |
    Qwen-Image-2.1-Uncensored-GGUF/text_encoders
    text_encoders
  vae: |
    Qwen-Image-2.1-Uncensored-GGUF/vae
    vae
  checkpoints: checkpoints
  loras: loras
`;

describe("parseExtraModelPaths", () => {
  const parsed = parseExtraModelPaths(YAML);

  it("reads base_path", () => {
    expect(parsed.basePath).toBe("/Users/example/models");
  });

  it("reads plain entries and block-scalar lists in order", () => {
    expect(parsed.map.checkpoints).toEqual(["checkpoints"]);
    expect(parsed.map.loras).toEqual(["loras"]);
    expect(parsed.map.diffusion_models).toEqual(["Qwen-Image-2.1-Uncensored-GGUF", "diffusion_models"]);
    expect(parsed.map.text_encoders).toEqual(["Qwen-Image-2.1-Uncensored-GGUF/text_encoders", "text_encoders"]);
  });

  it("ignores comments and handles a missing base_path", () => {
    const empty = parseExtraModelPaths("# nothing here\n");
    expect(empty.basePath).toBeUndefined();
    expect(empty.map).toEqual({});
  });
});

describe("pickSubpath", () => {
  it("prefers the generic folder over a model-specific bundle dir", () => {
    expect(pickSubpath("diffusion_models", ["Qwen-Image-2.1-Uncensored-GGUF", "diffusion_models"])).toBe("diffusion_models");
    expect(pickSubpath("text_encoders", ["Qwen-Image-2.1-Uncensored-GGUF/text_encoders", "text_encoders"])).toBe("text_encoders");
    expect(pickSubpath("vae", ["Qwen-Image-2.1-Uncensored-GGUF/vae", "vae"])).toBe("vae");
  });

  it("falls back to the first entry when none matches the key", () => {
    expect(pickSubpath("unet", ["Qwen-Image-2.1-Uncensored-GGUF", "some_dir"])).toBe("Qwen-Image-2.1-Uncensored-GGUF");
    expect(pickSubpath("unet", [])).toBeUndefined();
  });
});
