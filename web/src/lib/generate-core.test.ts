import { describe, expect, it } from "vitest";
import { sanitizeRequest } from "./generate-core";

const MODEL = { model: { name: "qwen-image-2.1-Q4_K_M.gguf", folder: "unet_gguf" as const } };

describe("sanitizeRequest", () => {
  it("requires a model", () => {
    expect(() => sanitizeRequest({})).toThrow(/pick a model/i);
  });

  it("fills defaults", () => {
    const r = sanitizeRequest(MODEL);
    expect(r).toMatchObject({ mode: "txt2img", width: 1024, height: 1024, steps: 25, cfg: 1, batch: 1, sampler: "euler", scheduler: "simple" });
  });

  it("clamps every numeric to its bounds", () => {
    const r = sanitizeRequest({ ...MODEL, width: 99999, height: 1, steps: 900, cfg: -5, seed: -1, batch: 99, denoise: 7, refResolution: 99999 });
    expect(r.width).toBe(4096);
    expect(r.height).toBe(256);
    expect(r.steps).toBe(150);
    expect(r.cfg).toBe(0);
    expect(r.seed).toBe(0);
    expect(r.batch).toBe(8);
    expect(r.denoise).toBe(1);
    expect(r.refResolution).toBe(4096);
  });

  it("rounds non-integer numerics and rejects non-numbers and NaN to defaults", () => {
    const r = sanitizeRequest({ ...MODEL, steps: 20.9, batch: "3" as unknown as number, width: NaN });
    expect(r.steps).toBe(21);
    expect(r.batch).toBe(1);
    expect(r.width).toBe(1024);
  });

  it("caps input images at 16 and stringifies entries", () => {
    const r = sanitizeRequest({ ...MODEL, images: Array.from({ length: 30 }, (_, i) => `safelight/${i}.png`) });
    expect(r.images).toHaveLength(16);
  });

  it("only accepts the two known modes", () => {
    expect(sanitizeRequest({ ...MODEL, mode: "img2img" }).mode).toBe("img2img");
    expect(sanitizeRequest({ ...MODEL, mode: "evil" as never }).mode).toBe("txt2img");
  });

  it("clamps control settings and rejects unknown control types", () => {
    const r = sanitizeRequest({ ...MODEL, control: { type: "canny", strength: 99, cannyLow: -1, cannyHigh: 5, patch: "union.safetensors" } });
    expect(r.control).toEqual({ type: "canny", strength: 2, cannyLow: 0, cannyHigh: 1, patch: "union.safetensors" });
    expect(sanitizeRequest({ ...MODEL, control: { type: "canny", strength: "x" as never } }).control?.strength).toBe(1);
    expect(sanitizeRequest({ ...MODEL, control: { type: "scribble" as never, strength: 1 } }).control).toBeNull();
    expect(sanitizeRequest({ ...MODEL }).control).toBeNull();
  });
});
