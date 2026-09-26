import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, stubFetch } from "../test-utils";
import { aLibraryImage } from "@/test/factories";
import { LibraryGrid } from "./LibraryGrid";
import type { LibraryItem } from "./types";

/**
 * jsdom has no layout, so the scroller's box is stubbed and the grid's own
 * ResizeObserver callback is fired by hand; from there the windowing math is real.
 */
let observers: ResizeObserverCallback[];

beforeEach(() => {
  observers = [];
  const Fake = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal("ResizeObserver", Fake);
});

function items(n: number): LibraryItem[] {
  return Array.from({ length: n }, () => aLibraryImage() as unknown as LibraryItem);
}

/** Renders the grid inside a stubbed 800×400 scroller: 3 columns, ~271 px rows. */
function renderGrid(loaded: LibraryItem[], total: number, onNeedMore: () => void) {
  stubFetch();
  const view = renderApp(
    <LibraryGrid items={loaded} total={total} onNeedMore={onNeedMore} renderTile={(item) => <span data-testid="tile">{item.path}</span>} />,
  );
  const scroller = view.container.querySelector("div.overflow-y-auto") as HTMLDivElement;
  Object.defineProperty(scroller, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));
  return { scroller };
}

describe("LibraryGrid", () => {
  it("renders only the visible rows plus overscan, not the whole result set", () => {
    const loaded = items(40);
    renderGrid(loaded, 100, () => {});

    // 3 columns; rows 0–5 fit 400 px + 3 rows of overscan ⇒ 18 of the 40 loaded tiles.
    const tiles = screen.getAllByTestId("tile");
    expect(tiles).toHaveLength(18);
    expect(tiles[0]).toHaveTextContent(loaded[0].path);
    expect(tiles[17]).toHaveTextContent(loaded[17].path);
    expect(screen.queryByText(loaded[18].path)).not.toBeInTheDocument();
  });

  it("scrolling moves the window and asks for more once it reaches unloaded indices", async () => {
    const loaded = items(40);
    const onNeedMore = vi.fn();
    const { scroller } = renderGrid(loaded, 100, onNeedMore);
    expect(onNeedMore).not.toHaveBeenCalled();

    Object.defineProperty(scroller, "scrollTop", { value: 4000, configurable: true });
    fireEvent.scroll(scroller);

    // The scroll handler waits for a frame before re-rendering the window.
    await waitFor(() => expect(screen.getAllByTestId("tile")[0]).toHaveTextContent(loaded[33].path));
    // The window now ends past the 40 loaded items, so the next page is requested —
    // possibly a frame after the window re-render, so poll rather than assert instantly.
    await waitFor(() => expect(onNeedMore).toHaveBeenCalled());
    expect(screen.getAllByTestId("tile")).toHaveLength(7); // items 33..39 are all that exist yet
    expect(screen.queryByText(loaded[0].path)).not.toBeInTheDocument();
  });
});
