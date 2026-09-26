import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { aLibraryImage } from "@/test/factories";
import { json, renderApp, stubFetch } from "../test-utils";
import { DuplicatesView } from "./DuplicatesView";
import type { DuplicateGroup, DupItem } from "./types";

const dup = () => aLibraryImage() as unknown as DupItem;

function props(overrides: Partial<Parameters<typeof DuplicatesView>[0]> = {}) {
  return { reloadKey: 0, selected: new Set<string>(), onToggle: () => {}, onSelectMany: () => {}, ...overrides };
}

describe("DuplicatesView", () => {
  it("scans, then renders one group per row with an honest summary", async () => {
    const groups: DuplicateGroup[] = [{ items: [dup(), dup(), dup()], spread: 4 }];
    stubFetch({ url: "/api/library/duplicates", reply: { groups } });
    renderApp(<DuplicatesView {...props()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Comparing perceptual hashes…");
    expect(await screen.findByText("3 near-identical prints · max distance 4")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Select safelight\// })).toHaveLength(3);
  });

  it("keep-newest selects every print except the first, and ticking feeds the shared selection", async () => {
    const keep = dup();
    const extra1 = dup();
    const extra2 = dup();
    stubFetch({ url: "/api/library/duplicates", reply: { groups: [{ items: [keep, extra1, extra2], spread: 2 }] } });
    const onSelectMany = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderApp(<DuplicatesView {...props({ onSelectMany, onToggle, selected: new Set([extra1.path]) })} />);

    await user.click(await screen.findByRole("button", { name: "Select all but newest" }));
    expect(onSelectMany).toHaveBeenCalledWith([extra1.path, extra2.path]);

    const ticked = screen.getByRole("button", { name: `Select ${extra1.path}` });
    expect(ticked).toHaveAttribute("aria-pressed", "true");
    expect(within(ticked.parentElement as HTMLElement).getByRole("button", { name: `Select ${keep.path}` })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: `Select ${keep.path}` }));
    expect(onToggle).toHaveBeenCalledWith(keep.path);
  });

  it("says so when every print is unique", async () => {
    stubFetch({ url: "/api/library/duplicates", reply: { groups: [] } });
    renderApp(<DuplicatesView {...props()} />);
    expect(await screen.findByText("No near-duplicates found. Every print is one of a kind.")).toBeInTheDocument();
  });

  it("reports a failed scan", async () => {
    stubFetch({ url: "/api/library/duplicates", reply: () => json({ error: "index locked" }, 500) });
    renderApp(<DuplicatesView {...props()} />);
    expect(await screen.findByText("Could not scan for duplicates.")).toBeInTheDocument();
  });
});
