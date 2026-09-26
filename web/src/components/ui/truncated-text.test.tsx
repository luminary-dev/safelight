import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test-utils";
import { TruncatedText } from "./truncated-text";

const roFire = new Set<() => void>();

class ControlledResizeObserver {
  private readonly run: () => void;
  constructor(cb: ResizeObserverCallback) {
    this.run = () => cb([], this as unknown as ResizeObserver);
    roFire.add(this.run);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    roFire.delete(this.run);
  }
}

const origScrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
const origClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
let overflowing = false;

beforeEach(() => {
  roFire.clear();
  overflowing = false;
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get: () => (overflowing ? 300 : 100) });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 100 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origScrollWidth) Object.defineProperty(Element.prototype, "scrollWidth", origScrollWidth);
  if (origClientWidth) Object.defineProperty(Element.prototype, "clientWidth", origClientWidth);
});

function layout() {
  act(() => {
    for (const run of [...roFire]) run();
  });
}

describe("TruncatedText", () => {
  it("shrinks instead of pushing the row: min-w-0 + truncate, full value in the title", () => {
    renderApp(<TruncatedText text="gemini_2026-09-24T20-23-56-06" />);
    layout();
    const el = screen.getByText("gemini_2026-09-24T20-23-56-06");
    expect(el).toHaveAttribute("title", "gemini_2026-09-24T20-23-56-06");
    expect(el.className).toContain("min-w-0");
    expect(el.className).toContain("truncate");
    // The text fits, so no aria-label doubles the accessible name.
    expect(el).not.toHaveAttribute("aria-label");
  });

  it("exposes the full value as aria-label once the visible text is actually cut", () => {
    overflowing = true;
    renderApp(<TruncatedText text="gemini_2026-09-24T20-23-56-06" title="the full generated title" />);
    layout();
    const el = screen.getByText("gemini_2026-09-24T20-23-56-06");
    expect(el).toHaveAttribute("title", "the full generated title");
    expect(el).toHaveAttribute("aria-label", "the full generated title");
  });

  it("renders the inline-flex variant with an inner truncating span", () => {
    renderApp(<TruncatedText variant="inline-flex" text="Qwen-Image-2.1-Uncensored-Q4_K_M.gguf" />);
    const inner = screen.getByText("Qwen-Image-2.1-Uncensored-Q4_K_M.gguf");
    expect(inner.className).toContain("truncate");
    const outer = inner.parentElement as HTMLElement;
    expect(outer.className).toContain("inline-flex");
    expect(outer.className).toContain("min-w-0");
    expect(outer).toHaveAttribute("title", "Qwen-Image-2.1-Uncensored-Q4_K_M.gguf");
  });

  it("the wrapping variant gives unbroken generated titles a break opportunity", () => {
    renderApp(<TruncatedText variant="wrap" as="p" text="gemini_2026-09-24T20-23-56-06" />);
    const el = screen.getByText("gemini_2026-09-24T20-23-56-06");
    expect(el.tagName).toBe("P");
    expect(el.className).toContain("[overflow-wrap:anywhere]");
    expect(el.className).not.toContain("truncate");
    expect(el).toHaveAttribute("title", "gemini_2026-09-24T20-23-56-06");
  });
});
