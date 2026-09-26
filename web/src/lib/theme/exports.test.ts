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

/**
 * Round trip per format (TEST-BRIEF §10): each export re-imports to the same
 * token values. The parsers below read only what the format guarantees —
 * var/value pairs — so a formatting change that keeps values intact still
 * passes, while any dropped, renamed or altered token fails.
 */
describe("each export re-imports to the same token values", () => {
  const COLOR_VAR_KEYS = ["bg", "surface", "text", "muted", "accent", "accent-text"] as const;

  function fromKebab(k: string): string {
    return k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  function parseVarBlock(body: string, colorPrefix: string): { colors: Record<string, string>; fonts: Record<string, string> } {
    const colors: Record<string, string> = {};
    const fonts: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
      if (name.startsWith("font-")) {
        fonts[name.slice(5)] = /"([^"]+)"/.exec(value)![1]; // first family in the stack
      } else if (colorPrefix === "" || name.startsWith(colorPrefix)) {
        colors[fromKebab(name.replace(colorPrefix, ""))] = value.trim();
      }
    }
    return { colors, fonts };
  }

  it("css: values parse back to the exact theme", () => {
    const { colors, fonts } = parseVarBlock(toCss(THEME), "");
    expect(colors).toEqual(THEME.colors);
    expect(fonts).toEqual({ display: "Fraunces", body: "Inter", mono: "JetBrains Mono" });
  });

  it("tailwind: --color-* tokens parse back to the exact theme", () => {
    const { colors, fonts } = parseVarBlock(toTailwind(THEME), "color-");
    expect(colors).toEqual(THEME.colors);
    expect(fonts.display).toBe("Fraunces");
    expect(fonts.body).toBe("Inter");
    expect(fonts.mono).toBe("JetBrains Mono");
  });

  it("tokens: DTCG $values parse back to the exact theme", () => {
    const parsed = JSON.parse(toTokens(THEME)) as {
      color: Record<string, { $value: string }>;
      font: Record<string, { $value: string }>;
    };
    const colors = Object.fromEntries(Object.entries(parsed.color).map(([k, v]) => [fromKebab(k), v.$value]));
    expect(colors).toEqual(THEME.colors);
    expect(Object.fromEntries(Object.entries(parsed.font).map(([k, v]) => [k, v.$value]))).toEqual(THEME.fonts);
  });

  it("every format carries all six colors — none may drop a token", () => {
    for (const format of EXPORT_FORMATS) {
      const body = exportTheme(THEME, format).body;
      for (const key of COLOR_VAR_KEYS) {
        expect(body.includes(key === "accent-text" ? "accent-text" : key), `${format} lost ${key}`).toBe(true);
      }
      for (const value of Object.values(THEME.colors)) expect(body).toContain(value);
    }
  });

  it("a mono-less theme round-trips without inventing a mono token", () => {
    const noMono = { ...THEME, fonts: { display: "Fraunces", body: "Inter" } };
    expect(parseVarBlock(toCss(noMono), "").fonts).toEqual({ display: "Fraunces", body: "Inter" });
    const parsed = JSON.parse(toTokens(noMono)) as { font: Record<string, unknown> };
    expect(Object.keys(parsed.font).sort()).toEqual(["body", "display"]);
  });
});
