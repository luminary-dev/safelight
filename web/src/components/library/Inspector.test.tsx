import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { formatBytes } from "@/lib/i18n-format";
import { aLibraryImage } from "@/test/factories";
import { renderApp, stubFetch } from "../test-utils";
import { Inspector } from "./Inspector";
import type { LibraryItem } from "./types";

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return { ...(aLibraryImage() as unknown as LibraryItem), ...overrides };
}

function props(it_: LibraryItem, overrides: Partial<Parameters<typeof Inspector>[0]> = {}) {
  return {
    item: it_,
    onClose: () => {},
    onOpenViewer: () => {},
    onToggleFavorite: () => {},
    onAddTag: () => {},
    onRemoveTag: () => {},
    onUseAsInput: () => {},
    onDelete: async () => {},
    ...overrides,
  };
}

describe("library Inspector", () => {
  it("shows the print's provenance: prompt, size, model, seed and sidecar fields", () => {
    stubFetch();
    const subject = item({
      path: "safelight/print.png",
      prompt: "a lighthouse at dusk",
      model: "qwen-image-Q4_K_M.gguf",
      seed: 42,
      width: 1024,
      height: 768,
      size: 2048,
      meta: JSON.stringify({ sampler: "euler", steps: 25, cfg: 2.5 }),
    });
    renderApp(<Inspector {...props(subject)} />);

    expect(screen.getByText("print.png")).toBeInTheDocument();
    expect(screen.getByText("a lighthouse at dusk")).toBeInTheDocument();
    expect(screen.getByText(`1024 × 768 · ${formatBytes(2048)}`)).toBeInTheDocument();
    expect(screen.getByText("qwen-image-Q4_K_M.gguf")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("euler")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("2.5")).toBeInTheDocument();
  });

  it("favorite reflects state and toggles; broken sidecar JSON degrades to no meta rows", async () => {
    stubFetch();
    const onToggleFavorite = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderApp(<Inspector {...props(item({ favorite: 0, meta: "{not json" }), { onToggleFavorite })} />);

    expect(screen.queryByText("sampler")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Favorite" }));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    rerender(<Inspector {...props(item({ favorite: 1 }), { onToggleFavorite })} />);
    expect(screen.getByRole("button", { name: "Favorited" })).toBeInTheDocument();
  });

  it("tags: add by Enter, remove by chip", async () => {
    stubFetch();
    const onAddTag = vi.fn();
    const onRemoveTag = vi.fn();
    const user = userEvent.setup();
    renderApp(<Inspector {...props(item({ tags: ["portrait"] }), { onAddTag, onRemoveTag })} />);

    await user.type(screen.getByRole("textbox", { name: "Add tag" }), "  moody {Enter}");
    expect(onAddTag).toHaveBeenCalledWith("moody");
    expect(screen.getByRole("textbox", { name: "Add tag" })).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Remove tag portrait" }));
    expect(onRemoveTag).toHaveBeenCalledWith("portrait");
  });

  it("delete asks for confirmation before it destroys anything", async () => {
    stubFetch();
    const onDelete = vi.fn(async () => {});
    const user = userEvent.setup();
    renderApp(<Inspector {...props(item({ path: "safelight/precious.png" }), { onDelete })} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled(); // only the dialog opened
    expect(await screen.findByText("Delete this image?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });
});
