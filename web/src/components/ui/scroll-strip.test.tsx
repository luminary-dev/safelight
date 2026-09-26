import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test-utils";
import { ScrollStrip } from "./scroll-strip";

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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  roFire.clear();
  // A strip 200px wide holding 600px of content — scrollable by 400px.
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get(this: Element) {
      return this instanceof HTMLElement && this.hasAttribute("data-scroll-strip") ? 600 : 0;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return this instanceof HTMLElement && this.hasAttribute("data-scroll-strip") ? 200 : 0;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origScrollWidth) Object.defineProperty(Element.prototype, "scrollWidth", origScrollWidth);
  if (origClientWidth) Object.defineProperty(Element.prototype, "clientWidth", origClientWidth);
});

function renderStrip() {
  renderApp(
    <ScrollStrip label="Earlier renders">
      <button type="button">one</button>
      <button type="button">two</button>
    </ScrollStrip>,
  );
  act(() => {
    for (const run of [...roFire]) run();
  });
  return screen.getByRole("region", { name: "Earlier renders" });
}

describe("ScrollStrip", () => {
  it("is a labelled, focusable, deliberately scrollable region the audit tooling can whitelist", () => {
    const strip = renderStrip();
    expect(strip).toHaveAttribute("data-scroll-strip");
    expect(strip).toHaveAttribute("tabindex", "0");
    expect(strip).toHaveAttribute("aria-label", "Earlier renders");
  });

  it("scrolls with the arrow keys", () => {
    const strip = renderStrip();
    expect(strip.scrollLeft).toBe(0);
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(strip.scrollLeft).toBe(160);
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(strip.scrollLeft).toBe(320);
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(strip.scrollLeft).toBe(160);
    // Never past the start.
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(strip.scrollLeft).toBe(0);
  });

  it("redirects vertical wheel input sideways", () => {
    const strip = renderStrip();
    fireEvent.wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);
    fireEvent.wheel(strip, { deltaY: -200 });
    expect(strip.scrollLeft).toBe(0);
  });

  it("shows an edge fade wherever content hides beyond that edge", () => {
    const strip = renderStrip();
    // At the start: content hides only past the right edge.
    expect(strip).not.toHaveAttribute("data-fade-start");
    expect(strip).toHaveAttribute("data-fade-end");
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(strip).toHaveAttribute("data-fade-start");
  });
});
