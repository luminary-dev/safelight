import { describe, expect, it } from "vitest";
import { APPLIED_PROPS, themeCssVars } from "./apply";
import type { ThemeColors } from "./contrast";

const COLORS: ThemeColors = { bg: "#10141a", surface: "#1a212b", text: "#e8edf4", muted: "#9aa7b8", accent: "#5eb0ff", accentText: "#08121f" };

describe("themeCssVars", () => {
  const vars = themeCssVars(COLORS);

  it("covers exactly the properties clear() removes", () => {
    expect(Object.keys(vars).sort()).toEqual([...APPLIED_PROPS].sort());
  });

  it("maps the six colors onto the app tokens", () => {
    expect(vars["--paper"]).toBe(COLORS.bg);
    expect(vars["--paper-2"]).toBe(COLORS.surface);
    expect(vars["--ink"]).toBe(COLORS.text);
    expect(vars["--ink-muted"]).toBe(COLORS.muted);
    expect(vars["--terracotta"]).toBe(COLORS.accent);
    expect(vars["--primary"]).toBe(COLORS.accent);
    expect(vars["--primary-ink"]).toBe(COLORS.accentText);
    expect(vars["--primary-foreground"]).toBe(COLORS.accentText);
  });

  it("derives shades with color-mix so the browser does the math", () => {
    expect(vars["--shell"]).toBe(`color-mix(in srgb, ${COLORS.bg} 96%, black)`);
    expect(vars["--pill"]).toContain("color-mix(in srgb");
    expect(vars["--terracotta-wash"]).toBe(`color-mix(in srgb, ${COLORS.accent} 14%, transparent)`);
    expect(vars["--primary-hover"]).toBe(`color-mix(in srgb, ${COLORS.accent} 92%, black)`);
    expect(vars["--faint"]).toContain(COLORS.muted);
  });
});
