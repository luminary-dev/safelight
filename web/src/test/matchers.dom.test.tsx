import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Proves the `component` project end to end: jsdom environment, Testing
 * Library + jest-dom matchers from setup.component.ts, and the shared
 * Safelight matchers working against rendered DOM.
 */

function Swatch({ fg, bg, label }: { fg: string; bg: string; label: string }) {
  return (
    <button type="button" style={{ color: fg, backgroundColor: bg }} disabled>
      {label}
    </button>
  );
}

describe("component project wiring", () => {
  it("renders with jsdom and jest-dom matchers are registered", () => {
    render(<Swatch fg="#e2e8f0" bg="#0a1628" label="Sea Glass" />);
    const button = screen.getByRole("button", { name: "Sea Glass" });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it("toHaveContrastRatio reads computed styles from a rendered element", () => {
    render(<Swatch fg="#e2e8f0" bg="#0a1628" label="readable" />);
    expect(screen.getByRole("button", { name: "readable" })).toHaveContrastRatio(4.5);
  });

  it("and fails a low-contrast element", () => {
    render(<Swatch fg="#777777" bg="#888888" label="muddy" />);
    expect(screen.getByRole("button", { name: "muddy" })).not.toHaveContrastRatio(4.5);
  });
});
