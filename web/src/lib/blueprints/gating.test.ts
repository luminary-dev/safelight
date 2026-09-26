import { describe, expect, it, vi } from "vitest";
import { startFakeComfy } from "@/test/fakes/comfy-server";
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

/**
 * getInstalled against the fake ComfyUI (network half of the gate). The fake
 * does not implement the bare /models folder listing, so installed model files
 * stay empty here — the model-matching arm is covered above through
 * computeStatus; this proves the node-class inventory, the offline null, and
 * the cache.
 */
describe("getInstalled", () => {
  async function gatingAt(url: string) {
    vi.resetModules();
    process.env.COMFY_URL = url;
    const mod = await import("./gating");
    mod.resetInstalledCache();
    return mod;
  }

  it("inventories the backend's node classes; a blueprint needing a custom node gates missing, stock-only gates ready", async () => {
    const comfy = await startFakeComfy();
    try {
      comfy.setObjectInfo("CLIPTextEncode", { input: {} });
      const g = await gatingAt(comfy.url);
      const installed = await g.getInstalled();
      expect(installed).not.toBeNull();
      expect(installed!.nodeClasses.has("KSampler")).toBe(true);

      const stock = g.computeStatus({ requiredNodeClasses: ["KSampler", "CLIPTextEncode", "SaveImage"], requiredModels: [] }, installed);
      expect(stock.status).toBe("ready");
      const custom = g.computeStatus({ requiredNodeClasses: ["KSampler", "LTXVConditioning"], requiredModels: [] }, installed);
      expect(custom.status).toBe("missing");
      expect(custom.missingNodeClasses).toEqual(["LTXVConditioning"]);
    } finally {
      comfy.close();
    }
  });

  it("answers null when the backend is offline — the gate then says Unknown, never Ready", async () => {
    const g = await gatingAt("http://127.0.0.1:1"); // deliberately unreachable
    const installed = await g.getInstalled();
    expect(installed).toBeNull();
    expect(g.computeStatus({ requiredNodeClasses: ["KSampler"], requiredModels: [] }, installed).status).toBe("unknown");
  });

  it("caches the inventory briefly and forgets it on resetInstalledCache", async () => {
    const comfy = await startFakeComfy();
    const g = await gatingAt(comfy.url);
    expect(await g.getInstalled()).not.toBeNull();
    comfy.close(); // backend gone…
    expect(await g.getInstalled()).not.toBeNull(); // …but the cache still answers
    g.resetInstalledCache();
    expect(await g.getInstalled()).toBeNull(); // fresh probe hits the dead server
  });
});
