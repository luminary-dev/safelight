import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDelete } from "../ConfirmDelete";
import { renderApp } from "../test-utils";
import { ActionBar, type ActionBarAction } from "./action-bar";

// ---------- simulated layout: a controllable ResizeObserver plus mocked widths ----------

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

/** Deliver the initial/resize ResizeObserver notifications the browser would send. */
function layout() {
  act(() => {
    for (const run of [...roFire]) run();
  });
}

const ITEM_WIDTH = 80;
const MORE_WIDTH = 60;
let containerWidth = 1000;

const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const origClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

beforeEach(() => {
  roFire.clear();
  containerWidth = 1000;
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  // Ghost measurement spans report a natural width; the bar reports its allotted space.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const key = this.dataset?.measureKey;
      if (!key) return 0;
      return key === "__more__" ? MORE_WIDTH : ITEM_WIDTH;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return this instanceof HTMLElement && this.hasAttribute("data-action-bar") ? containerWidth : 0;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", origOffsetWidth);
  if (origClientWidth) Object.defineProperty(Element.prototype, "clientWidth", origClientWidth);
});

// ---------- fixtures ----------

function actions(overrides: { onRecreate?: () => void; onVary?: () => void; onEdit?: () => void; onConfirmDelete?: () => void } = {}): ActionBarAction[] {
  return [
    { key: "recreate", label: "Recreate", onSelect: overrides.onRecreate ?? (() => {}), priority: 1 },
    { key: "vary", label: "Vary", onSelect: overrides.onVary ?? (() => {}), priority: 1 },
    { key: "upscale", label: "Upscale", onSelect: () => {}, disabled: true, disabledReason: "ComfyUI is offline.", priority: 2 },
    { key: "edit", label: "Edit", onSelect: overrides.onEdit ?? (() => {}), priority: 0 },
    {
      key: "delete",
      label: "Delete",
      destructive: true,
      wrap: (control) => <ConfirmDelete filename="render.png" onConfirm={overrides.onConfirmDelete ?? (() => {})} trigger={control} />,
    },
  ];
}

describe("ActionBar", () => {
  it("keeps everything inline when it fits, with only the destructive action behind More", () => {
    renderApp(<ActionBar label="Image actions" actions={actions()} />);
    layout();

    for (const name of ["Recreate", "Vary", "Edit"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upscale" })).toBeDisabled();
    // Delete never renders inline; the More menu carries it.
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });

  it("collapses low-priority actions into the More menu at a narrow width, all of them still firing", async () => {
    containerWidth = 200; // fits exactly one 80px action + the 60px More trigger + gaps
    const onRecreate = vi.fn();
    const onVary = vi.fn();
    const user = userEvent.setup();
    renderApp(<ActionBar label="Image actions" actions={actions({ onRecreate, onVary })} />);
    layout();

    // Priority 0 stays inline longest; everything else is behind More — nothing clipped, nothing dropped.
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recreate" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu");
    for (const name of ["Recreate", "Vary", "Upscale", "Delete"]) expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Recreate" }));
    expect(onRecreate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Vary" }));
    expect(onVary).toHaveBeenCalledTimes(1);
  });

  it("collapsed disabled actions keep their reason as the menu item's title", async () => {
    containerWidth = 200;
    const user = userEvent.setup();
    renderApp(<ActionBar label="Image actions" actions={actions()} />);
    layout();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const upscale = await screen.findByRole("menuitem", { name: "Upscale" });
    expect(upscale).toBeDisabled();
    expect(upscale).toHaveAttribute("title", "ComfyUI is offline.");
  });

  it("the destructive action stays behind its confirm flow inside the menu", async () => {
    containerWidth = 200;
    const onConfirmDelete = vi.fn();
    const user = userEvent.setup();
    renderApp(<ActionBar label="Image actions" actions={actions({ onConfirmDelete })} />);
    layout();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    // Selecting Delete never deletes: the confirm dialog interposes.
    const dialog = await screen.findByRole("alertdialog");
    expect(onConfirmDelete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it("the bar never clips: even at zero width every action remains reachable through the menu", async () => {
    containerWidth = 0;
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderApp(<ActionBar label="Image actions" actions={actions({ onEdit })} />);
    layout();

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    for (const name of ["Recreate", "Vary", "Upscale", "Edit", "Delete"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
