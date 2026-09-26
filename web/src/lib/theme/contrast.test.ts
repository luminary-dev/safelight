import { describe, expect, it } from "vitest";
import { AA_TEXT, contrastRatio, failingPairs, hexToRgb, relativeLuminance, themeContrast, type ThemeColors } from "./contrast";

describe("hexToRgb", () => {
  it("parses 6-digit hex", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#84cc16")).toEqual([132, 204, 22]);
  });

  it.each(["#fff", "84cc16", "#84cc1", "#84cc1g", "", "red"])("rejects %s", (bad) => {
    expect(() => hexToRgb(bad)).toThrow(/hex/i);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("weights green heaviest per the WCAG coefficients", () => {
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });
});

describe("contrastRatio", () => {
  it("black on white is 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("a color against itself is 1", () => {
    expect(contrastRatio("#84cc16", "#84cc16")).toBeCloseTo(1, 10);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(contrastRatio("#fedcba", "#123456"), 10);
  });

  it("#777777 on white is ~4.48 and fails AA", () => {
    const r = contrastRatio("#777777", "#ffffff");
    expect(r).toBeCloseTo(4.48, 1);
    expect(r).toBeLessThan(AA_TEXT);
  });

  it("#767676 on white is the classic AA boundary pass", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

// Note: white on the app's light lime accent (#5a9e08) is only ~3.3:1 — the fixture uses a deep teal that truly passes.
const GOOD: ThemeColors = { bg: "#f7f7f5", surface: "#ffffff", text: "#0d0d0f", muted: "#3f3f46", accent: "#0e7a5f", accentText: "#ffffff" };

describe("themeContrast / failingPairs", () => {
  it("reports the three enforced pairs, rounded", () => {
    const report = themeContrast(GOOD);
    expect(report.textOnBg).toBeGreaterThan(15);
    expect(report.textOnSurface).toBeGreaterThan(15);
    expect(report.accentTextOnAccent).toBeGreaterThanOrEqual(4.5);
    expect(failingPairs(report)).toEqual([]);
  });

  it("names the failing pair with its ratio", () => {
    const bad = { ...GOOD, accent: "#84cc16" }; // white on lime is well under 4.5
    const report = themeContrast(bad);
    const fails = failingPairs(report);
    expect(fails).toHaveLength(1);
    expect(fails[0].pair).toBe("accentTextOnAccent");
    expect(fails[0].ratio).toBeLessThan(4.5);
  });

  it("flags low-contrast text on both grounds", () => {
    const report = themeContrast({ ...GOOD, text: "#aaaaaa" });
    expect(failingPairs(report).map((f) => f.pair)).toEqual(["textOnBg", "textOnSurface"]);
  });
});
