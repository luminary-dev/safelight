import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, exportTheme, toCss, toTailwind, toTokens, type ExportableTheme } from "./exports";

const THEME: ExportableTheme = {
  name: "sea-glass",
  description: "Cool coastal light",
  colors: { bg: "#f2f7f5", surface: "#ffffff", text: "#1c2b28", muted: "#4e6660", accent: "#0e7a5f", accentText: "#ffffff" },
  fonts: { display: "Fraunces", body: "Inter", mono: "JetBrains Mono" },
};

describe("toCss", () => {
  it("emits a :root block with kebab-case vars and fonts", () => {
    const css = toCss(THEME);
    expect(css).toContain(":root {");
    expect(css).toContain("--bg: #f2f7f5;");
    expect(css).toContain("--accent-text: #ffffff;");
    expect(css).toContain('--font-display: "Fraunces";');
    expect(css).toContain('--font-mono: "JetBrains Mono";');
    expect(css).toContain("sea-glass — Cool coastal light");
    expect(css.trim().endsWith("}")).toBe(true);
  });

  it("omits mono when absent", () => {
    expect(toCss({ ...THEME, fonts: { display: "Fraunces", body: "Inter" } })).not.toContain("--font-mono");
  });
});

describe("toTailwind", () => {
  it("emits a Tailwind v4 @theme block with --color-* tokens", () => {
    const tw = toTailwind(THEME);
    expect(tw).toContain("@theme {");
    expect(tw).toContain("--color-bg: #f2f7f5;");
    expect(tw).toContain("--color-accent-text: #ffffff;");
    expect(tw).toContain('--font-body: "Inter", system-ui, sans-serif;');
  });
});

describe("toTokens", () => {
  it("emits DTCG-style JSON with $type color entries", () => {
    const parsed = JSON.parse(toTokens(THEME)) as {
      $description: string;
      color: Record<string, { $type: string; $value: string }>;
      font: Record<string, { $type: string; $value: string }>;
    };
    expect(parsed.$description).toContain("sea-glass");
    expect(parsed.color.bg).toEqual({ $type: "color", $value: "#f2f7f5" });
    expect(parsed.color["accent-text"]).toEqual({ $type: "color", $value: "#ffffff" });
    expect(Object.keys(parsed.color)).toHaveLength(6);
    expect(parsed.font.display).toEqual({ $type: "fontFamily", $value: "Fraunces" });
    expect(parsed.font.mono.$value).toBe("JetBrains Mono");
  });
});

describe("exportTheme", () => {
  it.each(EXPORT_FORMATS)("returns body, filename, and content type for %s", (format) => {
    const out = exportTheme(THEME, format);
    expect(out.body.length).toBeGreaterThan(0);
    expect(out.filename.startsWith("sea-glass")).toBe(true);
    expect(out.contentType).toContain("charset=utf-8");
  });

  it("names files by format", () => {
    expect(exportTheme(THEME, "css").filename).toBe("sea-glass.css");
    expect(exportTheme(THEME, "tailwind").filename).toBe("sea-glass.tailwind.css");
    expect(exportTheme(THEME, "tokens").filename).toBe("sea-glass.tokens.json");
  });
});
