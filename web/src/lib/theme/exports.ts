/*
  Theme export generators — pure string builders, no I/O, so the API route and
  tests share them. Three formats: plain CSS custom properties, a Tailwind v4
  @theme block, and W3C DTCG-style design tokens JSON.
*/

import type { ThemeColors } from "./contrast";

export interface ExportableTheme {
  name: string;
  description?: string;
  colors: ThemeColors;
  fonts: { display: string; body: string; mono?: string };
}

export const EXPORT_FORMATS = ["css", "tailwind", "tokens"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const COLOR_KEYS: (keyof ThemeColors)[] = ["bg", "surface", "text", "muted", "accent", "accentText"];

/** kebab-case for CSS var names: accentText -> accent-text. */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** A :root block of custom properties, fonts included as values. */
export function toCss(theme: ExportableTheme): string {
  const lines = [
    `/* ${theme.name}${theme.description ? ` — ${theme.description}` : ""} */`,
    ":root {",
    ...COLOR_KEYS.map((k) => `  --${kebab(k)}: ${theme.colors[k]};`),
    `  --font-display: "${theme.fonts.display}";`,
    `  --font-body: "${theme.fonts.body}";`,
    ...(theme.fonts.mono ? [`  --font-mono: "${theme.fonts.mono}";`] : []),
    "}",
  ];
  return lines.join("\n") + "\n";
}

/** A Tailwind v4 @theme block: --color-* and --font-* tokens. */
export function toTailwind(theme: ExportableTheme): string {
  const lines = [
    `/* ${theme.name}${theme.description ? ` — ${theme.description}` : ""} */`,
    "@theme {",
    ...COLOR_KEYS.map((k) => `  --color-${kebab(k)}: ${theme.colors[k]};`),
    `  --font-display: "${theme.fonts.display}", system-ui, sans-serif;`,
    `  --font-body: "${theme.fonts.body}", system-ui, sans-serif;`,
    ...(theme.fonts.mono ? [`  --font-mono: "${theme.fonts.mono}", ui-monospace, monospace;`] : []),
    "}",
  ];
  return lines.join("\n") + "\n";
}

/** W3C DTCG-style tokens JSON: $type/$value entries for colors and font families. */
export function toTokens(theme: ExportableTheme): string {
  const tokens = {
    $description: `${theme.name}${theme.description ? ` — ${theme.description}` : ""}`,
    color: Object.fromEntries(COLOR_KEYS.map((k) => [kebab(k), { $type: "color", $value: theme.colors[k] }])),
    font: {
      display: { $type: "fontFamily", $value: theme.fonts.display },
      body: { $type: "fontFamily", $value: theme.fonts.body },
      ...(theme.fonts.mono ? { mono: { $type: "fontFamily", $value: theme.fonts.mono } } : {}),
    },
  };
  return JSON.stringify(tokens, null, 2) + "\n";
}

/** Content + filename + media type for one export format. */
export function exportTheme(theme: ExportableTheme, format: ExportFormat): { body: string; filename: string; contentType: string } {
  switch (format) {
    case "css":
      return { body: toCss(theme), filename: `${theme.name}.css`, contentType: "text/css; charset=utf-8" };
    case "tailwind":
      return { body: toTailwind(theme), filename: `${theme.name}.tailwind.css`, contentType: "text/css; charset=utf-8" };
    case "tokens":
      return { body: toTokens(theme), filename: `${theme.name}.tokens.json`, contentType: "application/json; charset=utf-8" };
  }
}
