import { describe, expect, it } from "vitest";
import { SIZE_PRESETS, SIZE_SCALES, roundTo32, scaledSize } from "./presets";

describe("roundTo32", () => {
  it("rounds to the nearest multiple of 32", () => {
    expect(roundTo32(1024)).toBe(1024);
    expect(roundTo32(1039)).toBe(1024);
    expect(roundTo32(1040)).toBe(1056);
  });

  it("never returns below the 256 floor", () => {
    expect(roundTo32(0)).toBe(256);
    expect(roundTo32(255)).toBe(256);
    expect(roundTo32(-100)).toBe(256);
  });
});

describe("scaledSize", () => {
  it("keeps every preset at multiples of 32 across every scale", () => {
    for (const preset of SIZE_PRESETS) {
      for (const scale of SIZE_SCALES) {
        const { width, height } = scaledSize(preset, scale.factor);
        expect(width % 32).toBe(0);
        expect(height % 32).toBe(0);
        expect(width).toBeGreaterThanOrEqual(256);
        expect(height).toBeGreaterThanOrEqual(256);
      }
    }
  });

  it("doubles area at the 4 MP scale", () => {
    const base = scaledSize(SIZE_PRESETS[0], 1);
    const big = scaledSize(SIZE_PRESETS[0], 2);
    expect(big.width).toBe(base.width * 2);
  });
});
