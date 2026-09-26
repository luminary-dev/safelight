import { describe, expect, it } from "vitest";
import { autoTitle } from "./session-types";

describe("autoTitle", () => {
  it("uses the text when short", () => {
    expect(autoTitle("A red bicycle", "fallback")).toBe("A red bicycle");
  });

  it("collapses whitespace", () => {
    expect(autoTitle("  a\n  b\tc  ", "fallback")).toBe("a b c");
  });

  it("falls back on empty text", () => {
    expect(autoTitle("   ", "fallback")).toBe("fallback");
    expect(autoTitle("", "fallback")).toBe("fallback");
  });

  it("truncates long text with an ellipsis at 42 chars", () => {
    const long = "x".repeat(100);
    const title = autoTitle(long, "fallback");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(43);
  });
});
