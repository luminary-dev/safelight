import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressState } from "@/hooks/useComfySocket";
import type { GalleryItem, ImageCapabilities } from "@/lib/comfy/types";
import type { Job } from "@/lib/safelight-state";
import { aJob, aJobOutput } from "@/test/factories";
import { Stage } from "./Stage";
import { renderApp, stubFetch, type FetchCall, type FetchRoute } from "./test-utils";

function progress(overrides: Partial<ProgressState> = {}): ProgressState {
  return { connected: true, activePromptId: null, progress: 0, step: 0, totalSteps: 0, nodeLabel: null, queueRemaining: 0, preview: null, ...overrides };
}

const CAPS_ONLINE: ImageCapabilities = {
  online: true,
  upscaleModels: ["4x_esrgan.pth"],
  removeBackground: { node: true, models: ["birefnet.safetensors"] },
  inpaint: { controlNets: [] },
  controlnet: { node: true, patches: [] },
};

/** GET /api/generate serves both the capability probe and per-image sidecar lookups. */
function capsRoute(caps: ImageCapabilities = CAPS_ONLINE, sidecar: { mode?: string } | null = { mode: "txt2img" }): FetchRoute {
  return { url: "/api/generate", reply: (call: FetchCall) => (call.url.includes("sidecar=") ? { sidecar } : caps) };
}

function galleryItem(job?: Job): GalleryItem {
  const output = job?.outputs[0] ?? aJobOutput();
  return { ...output, mtime: 1_758_868_800_000, size: 12345 };
}

function stageProps(overrides: Partial<Parameters<typeof Stage>[0]> = {}): Parameters<typeof Stage>[0] {
  return {
    title: "Test session",
    gallery: [],
    jobs: [],
    progress: progress(),
    filter: "all",
    onFilter: () => {},
    onInterrupt: () => {},
    onUseAsInput: () => {},
    onDelete: async () => {},
    queue: [],
    ...overrides,
  };
}

describe("Stage", () => {
  it("shows the empty state when nothing has rendered yet", () => {
    stubFetch(capsRoute());
    renderApp(<Stage {...stageProps()} />);
    expect(screen.getByText(/Describe something on the left/)).toBeInTheDocument();
    expect(screen.getByText("Nothing here yet", { selector: "p.font-display" })).toBeInTheDocument();
  });

  it("a running job takes the stage with live progress and a working Stop", async () => {
    stubFetch(capsRoute());
    const onInterrupt = vi.fn();
    const job = aJob({ id: "p-live", state: "running", prompt: "a lighthouse", nodes: { "3": "KSampler" } });
    const user = userEvent.setup();
    renderApp(
      <Stage
        {...stageProps({ jobs: [job], onInterrupt })}
        progress={progress({ activePromptId: "p-live", nodeLabel: "3", step: 4, totalSteps: 20, progress: 0.2 })}
      />,
    );

    expect(screen.getByText("Rendering…")).toBeInTheDocument();
    expect(screen.getByText("Step 4 of 20")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("surfaces the last failure when the newest job errored and nothing is selected", () => {
    stubFetch(capsRoute());
    renderApp(<Stage {...stageProps({ jobs: [aJob({ state: "error", error: "CUDA out of memory" })] })} />);
    expect(screen.getByText("The last render failed")).toBeInTheDocument();
    expect(screen.getByText("CUDA out of memory")).toBeInTheDocument();
  });

  it("with a sidecar and a live backend, Recreate queues and tracks the action", async () => {
    const done = aJob({ state: "done" });
    const item = galleryItem(done);
    const { of } = stubFetch(
      capsRoute(),
      { method: "POST", url: "/api/generate", reply: { id: "action-1" } },
      { url: "/api/jobs/action-1", reply: { id: "action-1", state: "running", outputs: [] } },
    );
    const user = userEvent.setup();
    renderApp(<Stage {...stageProps({ gallery: [item], jobs: [done] })} />);

    const recreate = screen.getByRole("button", { name: "Recreate" });
    await waitFor(() => expect(recreate).toBeEnabled());
    await user.click(recreate);

    const posts = of("POST", "/api/generate");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ fromSidecar: `${item.subfolder}/${item.filename} [output]` });
    await screen.findByText(/working…|queued/);
    expect(of("GET", "/api/jobs/action-1").length).toBeGreaterThan(0);
  });

  it("disables actions with the reason in the tooltip when the backend or sidecar is missing", async () => {
    const done = aJob({ state: "done" });
    const item = galleryItem(done);
    stubFetch(capsRoute({ ...CAPS_ONLINE, online: false }, null));
    renderApp(<Stage {...stageProps({ gallery: [item], jobs: [done] })} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upscale 4×" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Upscale 4×" })).toHaveAttribute("title", "ComfyUI is offline.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Recreate" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Recreate" })).toHaveAttribute("title", "This image has no render settings sidecar.");
    expect(screen.getByRole("button", { name: "Inpaint" })).toHaveAttribute("title", "ComfyUI is offline.");
  });

  it("the filmstrip filters to this session's renders and reports the switch", async () => {
    const done = aJob({ state: "done", prompt: "owned by this session" });
    const owned = galleryItem(done);
    const stray: GalleryItem = { ...aJobOutput({ filename: "someone-else.png" }), mtime: 1, size: 1 };
    const onFilter = vi.fn();
    stubFetch(capsRoute());
    const user = userEvent.setup();
    const { rerender } = renderApp(<Stage {...stageProps({ gallery: [owned, stray], jobs: [done], onFilter })} />);

    // The header <p> carries the prompt as a title too; count only filmstrip thumbnails.
    const thumbs = (title: string) => screen.queryAllByTitle(title).filter((el) => el.tagName === "BUTTON");
    expect(thumbs("owned by this session")).toHaveLength(1);
    expect(thumbs("someone-else.png")).toHaveLength(1);

    await user.click(screen.getByRole("radio", { name: "This session" }));
    expect(onFilter).toHaveBeenCalledWith("session");

    rerender(<Stage {...stageProps({ gallery: [owned, stray], jobs: [done], onFilter, filter: "session" })} />);
    expect(thumbs("owned by this session")).toHaveLength(1);
    expect(thumbs("someone-else.png")).toHaveLength(0);
  });

  it("Delete lives in the overflow menu behind its confirm dialog, never inline", async () => {
    const done = aJob({ state: "done" });
    const item = galleryItem(done);
    const onDelete = vi.fn(async () => {});
    stubFetch(capsRoute());
    const user = userEvent.setup();
    renderApp(<Stage {...stageProps({ gallery: [item], jobs: [done], onDelete })} />);

    // No one-click Delete anywhere in the toolbar.
    expect(within(screen.getByRole("toolbar", { name: "Image actions" })).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ filename: item.filename }));
  });

  it("the selected render letterboxes inside the stage region at extreme viewport ratios (§5.1 leftover)", () => {
    const done = aJob({ state: "done" });
    stubFetch(capsRoute());
    renderApp(<Stage {...stageProps({ gallery: [galleryItem(done)], jobs: [done] })} />);

    const img = screen.getByRole("button", { name: "Open full size" }).querySelector("img")!;
    // Side-by-side (lg+) the region's height is definite: the image is capped by
    // it, so a very short window shrinks the picture, never the filmstrip.
    expect(img.className).toContain("lg:max-h-full");
    expect(img.className).toContain("object-contain");
    // Stacked (<lg) the column scrolls, so the cap is viewport-relative instead.
    expect(img.className).toContain("max-h-[min(70dvh,900px)]");
  });

  it("the progress advice line is a reserved fixed-height slot that cannot reflow the card", () => {
    stubFetch(capsRoute());
    const job = aJob({ id: "p-live", state: "running", nodes: { "3": "KSampler" } });
    const { container } = renderApp(<Stage {...stageProps({ jobs: [job] })} progress={progress({ activePromptId: "p-live" })} />);
    const advice = container.querySelector('p[aria-live="polite"]')!;
    expect(advice.className).toContain("h-10");
    expect(advice.className).toContain("overflow-hidden");
  });

  it("clicking the image opens the full-size viewer and Escape closes it", async () => {
    const done = aJob({ state: "done" });
    stubFetch(capsRoute());
    const user = userEvent.setup();
    renderApp(<Stage {...stageProps({ gallery: [galleryItem(done)], jobs: [done] })} />);

    await user.click(screen.getByRole("button", { name: "Open full size" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

// ---------- the action bar at a simulated narrow width ----------

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

describe("Stage at a narrow width", () => {
  const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const origClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

  beforeEach(() => {
    roFire.clear();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    // Every action measures 100px, and the bar has 330px — room for exactly two actions plus More.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset?.measureKey ? 100 : 0;
      },
    });
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this instanceof HTMLElement && this.hasAttribute("data-action-bar") ? 330 : 0;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", origOffsetWidth);
    if (origClientWidth) Object.defineProperty(Element.prototype, "clientWidth", origClientWidth);
  });

  function layout() {
    act(() => {
      for (const run of [...roFire]) run();
    });
  }

  it("keeps Edit and Save inline longest and every other action reachable through More", async () => {
    const done = aJob({ state: "done" });
    const item = galleryItem(done);
    const { of } = stubFetch(
      capsRoute(),
      { method: "POST", url: "/api/generate", reply: { id: "action-2" } },
      { url: "/api/jobs/action-2", reply: { id: "action-2", state: "running", outputs: [] } },
    );
    const user = userEvent.setup();
    renderApp(<Stage {...stageProps({ gallery: [item], jobs: [done] })} />);
    layout();

    const toolbar = screen.getByRole("toolbar", { name: "Image actions" });
    // The two primary actions survive the collapse…
    expect(within(toolbar).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("link", { name: "Save" })).toBeInTheDocument();
    // …and the mask/model actions collapsed first, not clipped away.
    for (const name of ["Recreate", "Vary", "Inpaint", "Outpaint", "Upscale 4×", "Remove BG"]) {
      expect(within(toolbar).queryByRole("button", { name })).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "More actions" }));
    for (const name of ["Recreate", "Vary", "Inpaint", "Outpaint", "Upscale 4×", "Remove BG", "Delete"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("menuitem", { name: "Open full size" })).toHaveAttribute("href");

    // A collapsed action still fires end to end.
    const vary = screen.getByRole("menuitem", { name: "Vary" });
    await waitFor(() => expect(vary).toBeEnabled());
    await user.click(vary);
    const posts = of("POST", "/api/generate");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ vary: true });
  });

  it("disabled-with-reason titles survive the collapse into the menu", async () => {
    const done = aJob({ state: "done" });
    const item = galleryItem(done);
    stubFetch(capsRoute({ ...CAPS_ONLINE, online: false }, null));
    const user = userEvent.setup();
    renderApp(<Stage {...stageProps({ gallery: [item], jobs: [done] })} />);
    layout();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const upscale = await screen.findByRole("menuitem", { name: "Upscale 4×" });
    await waitFor(() => expect(upscale).toBeDisabled());
    expect(upscale).toHaveAttribute("title", "ComfyUI is offline.");
    const recreate = screen.getByRole("menuitem", { name: "Recreate" });
    await waitFor(() => expect(recreate).toBeDisabled());
    expect(recreate).toHaveAttribute("title", "This image has no render settings sidecar.");
  });

  it("the filmstrip is a labelled, keyboard-scrollable strip, not a clipped row", () => {
    const done = aJob({ state: "done" });
    stubFetch(capsRoute());
    renderApp(<Stage {...stageProps({ gallery: [galleryItem(done)], jobs: [done] })} />);
    const strip = screen.getByRole("region", { name: "Earlier renders" });
    expect(strip).toHaveAttribute("data-scroll-strip");
    expect(strip).toHaveAttribute("tabindex", "0");
  });
});
