import { describe, expect, it } from "vitest";
import { computeStatus, type Installed } from "./gating";

const spec = {
  requiredNodeClasses: ["KSampler", "CLIPTextEncode", "LTXVConditioning", "SaveVideo"],
  requiredModels: ["ltx-2.5-video-vae-bf16.safetensors", "checkpoints/anime/z_image_turbo_bf16.safetensors"],
};

function installed(nodeClasses: string[], modelFiles: string[]): Installed {
  return { nodeClasses: new Set(nodeClasses), modelFiles: new Set(modelFiles) };
}

describe("computeStatus", () => {
  it("is ready when every node class and model is installed", () => {
    const s = computeStatus(spec, installed(spec.requiredNodeClasses, ["ltx-2.5-video-vae-bf16.safetensors", "checkpoints/anime/z_image_turbo_bf16.safetensors"]));
    expect(s).toEqual({ status: "ready", missingNodeClasses: [], missingModels: [] });
  });

  it("matches models by basename when ComfyUI lists them under a subfolder", () => {
    const s = computeStatus(spec, installed(spec.requiredNodeClasses, ["ltx-2.5-video-vae-bf16.safetensors", "z_image_turbo_bf16.safetensors"]));
    expect(s.status).toBe("ready");
  });

  it("lists the exact missing node classes and model files", () => {
    const s = computeStatus(spec, installed(["KSampler", "CLIPTextEncode"], ["z_image_turbo_bf16.safetensors"]));
    expect(s.status).toBe("missing");
    expect(s.missingNodeClasses).toEqual(["LTXVConditioning", "SaveVideo"]);
    expect(s.missingModels).toEqual(["ltx-2.5-video-vae-bf16.safetensors"]);
  });

  it("is unknown when the backend is offline instead of pretending", () => {
    expect(computeStatus(spec, null).status).toBe("unknown");
  });

  it("a blueprint with no requirements is always ready", () => {
    const s = computeStatus({ requiredNodeClasses: [], requiredModels: [] }, installed([], []));
    expect(s.status).toBe("ready");
  });
});
