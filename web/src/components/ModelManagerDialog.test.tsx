import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelManagerDialog } from "./ModelManagerDialog";
import { renderApp, stubFetch } from "./test-utils";

const LONG_FILE = "unet/Qwen-Image-2.1-Uncensored-Q4_K_M.gguf";

const downloadsRoute = (downloads: unknown[], root = "/Users/me/Library/Application Support/safelight/models") => ({
  url: "/api/models/download",
  reply: { root, downloads },
});

describe("ModelManagerDialog", () => {
  it("long file names truncate with the full path in the title, and the download list scrolls internally", async () => {
    stubFetch(
      downloadsRoute([
        { id: "d1", file: LONG_FILE, received: 1024, total: 4096, state: "downloading" },
        { id: "d2", file: "loras/other.safetensors", received: 0, total: null, state: "error", error: "disk full" },
      ]),
    );
    renderApp(<ModelManagerDialog open onClose={() => {}} />);

    // TruncatedText keeps the full path reachable even when the visible name is cut.
    const name = await screen.findByTitle(LONG_FILE);
    expect(name).toHaveTextContent("Qwen-Image-2.1-Uncensored-Q4_K_M.gguf");
    // The list scrolls internally instead of growing the dialog past the viewport (§5 item 6).
    expect(name.closest("ul")?.className).toContain("overflow-y-auto");
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("pins the header and scrolls the body, never the footer past 100dvh (§6)", async () => {
    stubFetch(downloadsRoute([]));
    renderApp(<ModelManagerDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const card = dialog.querySelector("[class*=card-raised]") as HTMLElement;
    expect(card.className).toContain("max-h-[calc(92dvh-1rem)]");
    expect(card.className).toContain("max-md:max-h-dvh"); // <768 sheet treatment

    // The close button lives in the pinned header: its nearest scroll region is
    // the overlay backstop, not the dialog's internal body scroller.
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".overflow-y-auto")).toBe(dialog);
    // The tab strip lives inside the internal scroll region.
    const tab = screen.getByRole("button", { name: "Starter picks" });
    expect(tab.closest(".overflow-y-auto")).not.toBe(dialog);
    expect(tab.closest(".overflow-y-auto")).not.toBeNull();
  });
});
