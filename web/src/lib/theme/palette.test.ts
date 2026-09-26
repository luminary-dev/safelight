/*
  WCAG AA regression test for the shell palette itself: parses the :root (light)
  and .dark token blocks straight out of globals.css and checks the core
  text/surface pairs with the same contrast math that gates saved themes.
  If a brand color moves, this fails loudly instead of shipping unreadable text.
*/
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AA_TEXT, contrastRatio } from "./contrast";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"), "utf8");

/** Extracts the body of the first `selector { … }` block (tokens are flat declarations, no nesting). */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`globals.css has no "${selector}" block`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

/** Reads a token's 6-digit hex value from a block; throws if it is missing or not plain hex. */
function token(body: string, name: string): string {
  const m = new RegExp(`^\\s*${name.replace(/[-\\]]/g, "\\$&")}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m").exec(body);
  if (!m) throw new Error(`Token ${name} is missing or not a 6-digit hex color`);
  return m[1];
}

const light = block(":root");
const dark = block(".dark");

const CORE_PAIRS: { theme: string; body: string; fg: string; bg: string }[] = [
  { theme: "light", body: light, fg: "--ink", bg: "--paper" },
  { theme: "light", body: light, fg: "--ink-muted", bg: "--paper" },
  { theme: "light", body: light, fg: "--primary-ink", bg: "--primary" },
  { theme: "dark", body: dark, fg: "--ink", bg: "--paper" },
  { theme: "dark", body: dark, fg: "--ink-muted", bg: "--paper" },
  { theme: "dark", body: dark, fg: "--primary-ink", bg: "--primary" },
];

describe("shell palette meets WCAG AA", () => {
  it.each(CORE_PAIRS)("$theme: $fg on $bg is at least 4.5:1", ({ body, fg, bg }) => {
    expect(contrastRatio(token(body, fg), token(body, bg))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // The light accent was darkened 2026-09-26 (#5a9e08 -> #487e06, owner-approved)
  // precisely to cross AA for the small labels and links it colors.
  it("light-mode --terracotta on --paper passes AA", () => {
    const ratio = contrastRatio(token(light, "--terracotta"), token(light, "--paper"));
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("dark-mode --terracotta on --paper passes AA", () => {
    expect(contrastRatio(token(dark, "--terracotta"), token(dark, "--paper"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
