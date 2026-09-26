import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aLibraryImage } from "@/test/factories";
import { renderApp, stubFetch } from "../test-utils";
import { CompareView } from "./CompareView";
import type { LibraryItem } from "./types";

const itemA = () => aLibraryImage() as unknown as LibraryItem;

/** Simulates the <768 viewport: only the (max-width: 767px) query matches. */
function stubNarrowViewport(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(max-width: 767px)" ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("CompareView", () => {
  it("shows both prints and starts the divider at the middle", () => {
    stubFetch();
    const a = itemA();
    const b = itemA();
    renderApp(<CompareView a={a} b={b} onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Compare images" })).toBeInTheDocument();
    expect(screen.getByAltText(a.path)).toBeInTheDocument();
    expect(screen.getByAltText(b.path)).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Comparison divider" })).toHaveAttribute("aria-valuenow", "50");
  });

  it("the divider moves by keyboard in 5 % steps with Home/End jumps", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderApp(<CompareView a={itemA()} b={itemA()} onClose={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Comparison divider" });
    slider.focus();

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuenow", "60");
    await user.keyboard("{ArrowLeft}");
    expect(slider).toHaveAttribute("aria-valuenow", "55");
    await user.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuenow", "100");
    await user.keyboard("{ArrowUp}");
    expect(slider).toHaveAttribute("aria-valuenow", "100"); // clamped
    await user.keyboard("{Home}");
    expect(slider).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{ArrowDown}");
    expect(slider).toHaveAttribute("aria-valuenow", "0"); // clamped
  });

  it("below 768 the two-up slider becomes a stacked A/B toggle (§5 item 10)", async () => {
    stubFetch();
    stubNarrowViewport(true);
    const a = itemA();
    const b = itemA();
    const user = userEvent.setup();
    renderApp(<CompareView a={a} b={b} onClose={() => {}} />);

    // No divider to drag at phone widths — a toggle instead, starting on A.
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show A" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText(a.path)).toBeInTheDocument();
    expect(screen.queryByAltText(b.path)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show B" }));
    expect(screen.getByAltText(b.path)).toBeInTheDocument();
    expect(screen.queryByAltText(a.path)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show B" })).toHaveAttribute("aria-pressed", "true");
  });

  it("at ≥768 the slider mode is unchanged by the toggle machinery", () => {
    stubFetch();
    stubNarrowViewport(false);
    const a = itemA();
    const b = itemA();
    renderApp(<CompareView a={a} b={b} onClose={() => {}} />);

    expect(screen.getByRole("slider", { name: "Comparison divider" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show A" })).not.toBeInTheDocument();
  });

  it("Escape and the close button both close the compare", async () => {
    stubFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderApp(<CompareView a={itemA()} b={itemA()} onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close compare" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
