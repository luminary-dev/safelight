/*
  WCAG 2.2 contrast math. Pure functions — used server-side to gate save_theme
  and client-side to label swatches, so no "server-only" here.
*/

/** Parses #rrggbb into [r, g, b] 0–255. Throws on anything else. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** sRGB relative luminance per WCAG 2.2 (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors: (L1 + 0.05) / (L2 + 0.05), 1–21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA threshold for normal text. */
export const AA_TEXT = 4.5;

export interface ThemeColors {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
}

export interface ContrastReport {
  textOnBg: number;
  textOnSurface: number;
  accentTextOnAccent: number;
}

/** The three pairs Safelight enforces, each rounded to 2 decimals. */
export function themeContrast(colors: ThemeColors): ContrastReport {
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    textOnBg: round(contrastRatio(colors.text, colors.bg)),
    textOnSurface: round(contrastRatio(colors.text, colors.surface)),
    accentTextOnAccent: round(contrastRatio(colors.accentText, colors.accent)),
  };
}

/** Human-readable names for the enforced pairs, keyed like ContrastReport. */
export const PAIR_LABEL: Record<keyof ContrastReport, string> = {
  textOnBg: "text on bg",
  textOnSurface: "text on surface",
  accentTextOnAccent: "accentText on accent",
};

/** Returns the pairs below AA, empty when the theme passes. */
export function failingPairs(report: ContrastReport): { pair: keyof ContrastReport; ratio: number }[] {
  return (Object.keys(report) as (keyof ContrastReport)[]).filter((k) => report[k] < AA_TEXT).map((pair) => ({ pair, ratio: report[pair] }));
}
