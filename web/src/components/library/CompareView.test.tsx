import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { aLibraryImage } from "@/test/factories";
import { renderApp, stubFetch } from "../test-utils";
import { CompareView } from "./CompareView";
import type { LibraryItem } from "./types";

const itemA = () => aLibraryImage() as unknown as LibraryItem;

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
