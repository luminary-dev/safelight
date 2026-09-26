import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
