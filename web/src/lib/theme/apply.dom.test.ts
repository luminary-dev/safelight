// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeColors } from "./contrast";
import { APPLIED_PROPS, applyTheme, clearTheme, getActiveThemeName, subscribeActiveTheme } from "./apply";

/**
 * apply/clear parity on a real DOM (TEST-BRIEF §10 — apply.ts was at 50 %):
 * applying sets inline custom properties on <html>, clearing removes exactly
 * those and leaves the element as found. Custom properties pass through
 * jsdom's CSSOM unparsed, so color-mix values survive verbatim.
 */

const COLORS: ThemeColors = { bg: "#10141a", surface: "#1a212b", text: "#e8edf4", muted: "#9aa7b8", accent: "#5eb0ff", accentText: "#08121f" };

afterEach(() => {
  clearTheme();
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("applyTheme / clearTheme parity", () => {
  it("apply sets every themed property inline on <html>; clear removes every one — the element ends as it began", () => {
    const style = document.documentElement.style;
    expect(style.length).toBe(0);

    applyTheme("midnight", COLORS, { display: "Inter", body: "Inter", mono: "Fira Code" });
    for (const prop of APPLIED_PROPS) {
      expect(style.getPropertyValue(prop), `${prop} not applied`).not.toBe("");
    }
    expect(style.getPropertyValue("--paper")).toBe(COLORS.bg);
    expect(style.getPropertyValue("--shell")).toBe(`color-mix(in srgb, ${COLORS.bg} 96%, black)`); // unparsed passthrough
    expect(style.getPropertyValue("--font-sans")).toContain('"Inter"');

    clearTheme();
    for (const prop of APPLIED_PROPS) {
      expect(style.getPropertyValue(prop), `${prop} survived clear()`).toBe("");
    }
    expect(style.length).toBe(0);
  });

  it("a font-less theme removes stale font vars from a previously applied theme", () => {
    const style = document.documentElement.style;
    applyTheme("with-fonts", COLORS, { display: "Fraunces", body: "Inter" });
    expect(style.getPropertyValue("--font-display")).toContain("Fraunces");

    applyTheme("colors-only", COLORS);
    expect(style.getPropertyValue("--font-display")).toBe(""); // not left behind
    expect(style.getPropertyValue("--paper")).toBe(COLORS.bg); // colors still applied
  });

  it("re-applying replaces values in place — no accumulation, still fully clearable", () => {
    const style = document.documentElement.style;
    applyTheme("a", COLORS);
    const count = style.length;
    applyTheme("b", { ...COLORS, bg: "#ffffff" });
    expect(style.length).toBe(count);
    expect(style.getPropertyValue("--paper")).toBe("#ffffff");
    clearTheme();
    expect(style.length).toBe(0);
  });

  it("apply leaves unrelated inline styles alone and clear does not touch them", () => {
    const style = document.documentElement.style;
    style.setProperty("--user-custom", "keep-me");
    applyTheme("midnight", COLORS);
    clearTheme();
    expect(style.getPropertyValue("--user-custom")).toBe("keep-me");
  });

  it("tracks the active theme name through a subscribe/snapshot pair", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeActiveTheme(() => seen.push(getActiveThemeName()));
    applyTheme("midnight", COLORS);
    clearTheme();
    unsubscribe();
    applyTheme("after-unsubscribe", COLORS);
    expect(seen).toEqual(["midnight", null]);
    expect(getActiveThemeName()).toBe("after-unsubscribe");
  });
});
