/*
  Client-side live theme application. Maps a saved theme's six colors onto the
  app's CSS custom properties as inline styles on <html>, which win over both
  :root and .dark — an applied theme replaces light AND dark until cleared.
  Derived shades use CSS color-mix strings; the browser does the math.
*/

import type { ThemeColors } from "./contrast";

/** Every custom property an applied theme sets; clear() removes exactly these. */
export const APPLIED_PROPS = [
  "--shell",
  "--paper",
  "--paper-2",
  "--pill",
  "--tray",
  "--line",
  "--line-strong",
  "--ink",
  "--ink-muted",
  "--faint",
  "--placeholder",
  "--terracotta",
  "--terracotta-deep",
  "--terracotta-wash",
  "--glass",
  "--glass-border",
  "--primary",
  "--primary-ink",
  "--primary-foreground",
  "--primary-hover",
  "--focus-ring",
] as const;

/** Pure mapping from the six theme colors to CSS custom property values. Exported for tests. */
export function themeCssVars(c: ThemeColors): Record<string, string> {
  return {
    // Panels float on a slightly darker ground, like the stock themes.
    "--shell": `color-mix(in srgb, ${c.bg} 96%, black)`,
    "--paper": c.bg,
    "--paper-2": c.surface,
    "--pill": `color-mix(in srgb, ${c.surface} 55%, ${c.bg})`,
    "--tray": `color-mix(in srgb, ${c.bg} 97%, black)`,
    "--line": `color-mix(in srgb, ${c.text} 10%, transparent)`,
    "--line-strong": `color-mix(in srgb, ${c.text} 18%, transparent)`,
    "--ink": c.text,
    "--ink-muted": c.muted,
    "--faint": `color-mix(in srgb, ${c.muted} 72%, ${c.bg})`,
    "--placeholder": `color-mix(in srgb, ${c.muted} 55%, ${c.bg})`,
    "--terracotta": c.accent,
    "--terracotta-deep": `color-mix(in srgb, ${c.accent} 82%, black)`,
    "--terracotta-wash": `color-mix(in srgb, ${c.accent} 14%, transparent)`,
    "--glass": `color-mix(in srgb, ${c.surface} 85%, transparent)`,
    "--glass-border": `color-mix(in srgb, ${c.text} 8%, transparent)`,
    "--primary": c.accent,
    "--primary-ink": c.accentText,
    "--primary-foreground": c.accentText,
    "--primary-hover": `color-mix(in srgb, ${c.accent} 92%, black)`,
    "--focus-ring": `0 0 0 3px color-mix(in srgb, ${c.accent} 35%, transparent)`,
  };
}

// The active theme name lives here so swatch cards can show a Reset control.
// useSyncExternalStore-shaped: subscribe + snapshot.
let activeName: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribeActiveTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getActiveThemeName(): string | null {
  return activeName;
}

/** Sets the theme's vars inline on <html>. Overrides both light and dark until cleared. */
export function applyTheme(name: string, colors: ThemeColors): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  const vars = themeCssVars(colors);
  for (const prop of APPLIED_PROPS) style.setProperty(prop, vars[prop]);
  activeName = name;
  notify();
}

/** Removes every override; the stock light/dark tokens take effect again. */
export function clearTheme(): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const prop of APPLIED_PROPS) style.removeProperty(prop);
  activeName = null;
  notify();
}
