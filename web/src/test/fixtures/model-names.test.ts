import { describe, expect, it } from "vitest";
import { classifyFamily } from "@/lib/comfy/models";
import { MODEL_NAME_FIXTURES, modelNamesByFamily } from "./model-names";

describe("model-name fixtures", () => {
  it("holds ~80 names", () => {
    expect(MODEL_NAME_FIXTURES.length).toBeGreaterThanOrEqual(78);
  });

  it("has no duplicate names", () => {
    const names = MODEL_NAME_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every expected family matches what classifyFamily actually returns", () => {
    const mismatches = MODEL_NAME_FIXTURES.filter((f) => classifyFamily(f.name) !== f.family).map(
      (f) => `${f.name}: fixture says ${f.family}, classifyFamily says ${classifyFamily(f.name)}`,
    );
    expect(mismatches).toEqual([]);
  });

  it("covers every family, including deliberate near-misses", () => {
    for (const family of ["qwen-image", "flux", "sdxl", "sd15", "unknown"] as const) {
      expect(modelNamesByFamily(family).length).toBeGreaterThanOrEqual(5);
    }
    expect(MODEL_NAME_FIXTURES.filter((f) => f.note).length).toBeGreaterThanOrEqual(15);
    expect(MODEL_NAME_FIXTURES.filter((f) => f.companion).length).toBeGreaterThanOrEqual(15);
  });

  it("keeps the brief's two named near-misses", () => {
    expect(MODEL_NAME_FIXTURES.some((f) => f.name === "flux_vae.safetensors" && f.companion)).toBe(true);
    expect(MODEL_NAME_FIXTURES.some((f) => f.name === "sdxl_lora_detail.safetensors" && f.companion)).toBe(true);
  });
});
