import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch, type FetchRoute } from "@/components/test-utils";
import type { GenerateRequest, JobStatus, ModelCatalog } from "@/lib/comfy/types";
import type { ImageSession, Session } from "@/lib/session-types";
import { aJob, aJobOutput, aModelEntry, anImageSession } from "@/test/factories";
import type { useComfySocket } from "./useComfySocket";
import { useImageStudio } from "./useImageStudio";
import { useSessions } from "./useSessions";

const SETTINGS_KEY = "safelight.settings.v2";

const qwen = aModelEntry(); // qwen-image family
const CATALOG: ModelCatalog = {
  models: [qwen],
  textEncoders: ["qwen_3_vl_7b_bf16.safetensors"],
  vaes: ["qwen_image_vae.safetensors"],
  loras: ["style-lora.safetensors"],
  samplers: ["euler"],
  schedulers: ["simple"],
  online: true,
};

function makeProgress(finished: string[]): ReturnType<typeof useComfySocket> {
  return { connected: true, activePromptId: null, progress: 0, step: 0, totalSteps: 0, nodeLabel: null, queueRemaining: 0, preview: null, finished };
}

function useHarness({ finished }: { finished: string[] }) {
  const s = useSessions();
  const studio = useImageStudio({ clientId: "client-1", progress: makeProgress(finished), s, setTopMode: () => {} });
  return { s, studio };
}

function renderStudio(sessions: Session[] = [], extraRoutes: FetchRoute[] = []) {
  const api = stubFetch(
    { url: "/api/sessions", reply: { sessions, projects: [] } },
    { method: "POST", url: "/api/sessions", reply: { ok: true } },
    { method: "PATCH", url: /\/api\/sessions\/.+/, reply: { ok: true } },
    { url: "/api/models", reply: CATALOG },
    { url: "/api/gallery", reply: { items: [] } },
    ...extraRoutes,
  );
  const rendered = renderHook(useHarness, { initialProps: { finished: [] as string[] } });
  return { ...api, ...rendered };
}

async function flushAsync() {
  for (let i = 0; i < 8; i++) await act(async () => {});
}

describe("useImageStudio", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("loadCatalog adopts the first model with its family defaults", async () => {
    const { result } = renderStudio();
    await flushAsync();

    await act(() => result.current.studio.loadCatalog());

    expect(result.current.studio.online).toBe(true);
    expect(result.current.studio.catalogError).toBeNull();
    expect(result.current.studio.settings.model).toEqual(qwen);
    expect(result.current.studio.settings.textEncoders).toEqual(["qwen_3_vl_7b_bf16.safetensors"]);
    expect(result.current.studio.settings.vae).toBe("qwen_image_vae.safetensors");
  });

  it("reports the server error and goes offline when the catalog cannot load", async () => {
    const { result } = renderStudio([], []);
    await flushAsync();
    stubFetch({ url: "/api/models", reply: () => json({ error: "The Safelight server exploded." }, 500) });

    await act(() => result.current.studio.loadCatalog());

    expect(result.current.studio.online).toBe(false);
    expect(result.current.studio.catalogError).toBe("The Safelight server exploded.");
    expect(result.current.studio.catalog).toBeNull();
  });

  it("resets stale companions when the saved text encoder no longer fits the model", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ model: qwen, textEncoders: ["t5xxl_fp16.safetensors"], lora: "gone-lora.safetensors", vae: "qwen_image_vae.safetensors" }),
    );
    const { result } = renderStudio();
    await flushAsync();
    expect(result.current.studio.settings.textEncoders).toEqual(["t5xxl_fp16.safetensors"]);

    await act(() => result.current.studio.loadCatalog());

    expect(result.current.studio.settings.model).toEqual(qwen);
    expect(result.current.studio.settings.textEncoders).toEqual(["qwen_3_vl_7b_bf16.safetensors"]);
    expect(result.current.studio.settings.lora).toBe("");
  });

  it("generate queues the render, tracks it to done, and reloads the gallery", async () => {
    const output = aJobOutput();
    let polls = 0;
    const { result, of } = renderStudio(
      [],
      [
        { method: "POST", url: "/api/generate", reply: { id: "prompt-123" } },
        {
          url: "/api/jobs/prompt-123",
          reply: (): JobStatus => (++polls === 1 ? { id: "prompt-123", state: "running", outputs: [] } : { id: "prompt-123", state: "done", outputs: [output] }),
        },
      ],
    );
    await flushAsync();
    await act(() => result.current.studio.loadCatalog());
    act(() => result.current.studio.update({ prompt: "A lighthouse at dusk" }));
    expect(result.current.studio.canGenerate).toBe(true);

    await act(() => result.current.studio.generate());

    const body = of("POST", "/api/generate")[0].body as GenerateRequest & { clientId: string };
    expect(body.prompt).toBe("A lighthouse at dusk");
    expect(body.clientId).toBe("client-1");
    expect(body.model).toEqual({ name: qwen.name, folder: qwen.folder, provider: undefined });

    const running = result.current.s.activeImage!;
    expect(running.jobs[0].id).toBe("prompt-123");
    expect(running.jobs[0].state).toBe("running");

    await act(() => vi.advanceTimersByTimeAsync(1500));
    const done = result.current.s.activeImage!;
    expect(done.jobs[0].state).toBe("done");
    expect(done.jobs[0].outputs).toEqual([output]);
    expect(of("GET", "/api/gallery").length).toBeGreaterThan(0);

    // The poller stops once the job finished.
    const settled = polls;
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(polls).toBe(settled);
  });

  it("a failed queue marks the job as an error and surfaces the message", async () => {
    const { result } = renderStudio([], [{ method: "POST", url: "/api/generate", reply: () => json({ error: "ComfyUI exploded." }, 500) }]);
    await flushAsync();
    await act(() => result.current.studio.loadCatalog());
    act(() => result.current.studio.update({ prompt: "Anything" }));

    await act(() => result.current.studio.generate());

    const session = result.current.s.activeImage!;
    expect(session.jobs[0].state).toBe("error");
    expect(session.jobs[0].error).toBe("ComfyUI exploded.");
    expect(result.current.studio.submitError).toBe("ComfyUI exploded.");
    expect(result.current.studio.submitting).toBe(false);
  });

  it("canGenerate needs a model, a prompt for txt2img, and an input image for img2img", async () => {
    const { result } = renderStudio();
    await flushAsync();
    expect(result.current.studio.canGenerate).toBe(false); // no catalog yet

    await act(() => result.current.studio.loadCatalog());
    expect(result.current.studio.canGenerate).toBe(false); // empty prompt

    act(() => result.current.studio.update({ prompt: "A cat" }));
    expect(result.current.studio.canGenerate).toBe(true);

    act(() => result.current.studio.setSettings((prev) => ({ ...prev, mode: "img2img", images: [] })));
    expect(result.current.studio.canGenerate).toBe(false); // img2img without an input

    act(() =>
      result.current.studio.setSettings((prev) => ({
        ...prev,
        images: [{ ref: "in.png", filename: "in.png", subfolder: "", previewUrl: "/api/view?filename=in.png" }],
      })),
    );
    expect(result.current.studio.canGenerate).toBe(true);
  });

  it("on load, resumes polling live jobs and fails jobs that never left the browser", async () => {
    const live = aJob({ id: "job-live", state: "running" });
    const neverQueued = aJob({ id: "pending-stale", state: "queued" });
    const session = anImageSession({ jobs: [live, neverQueued] });
    const { result, of } = renderStudio([session], [{ url: "/api/jobs/job-live", reply: { id: "job-live", state: "running", outputs: [] } }]);
    await flushAsync();

    expect(of("GET", "/api/jobs/job-live").length).toBeGreaterThan(0);
    const jobs = (result.current.s.sessions[0] as ImageSession).jobs;
    expect(jobs.find((j) => j.id === "pending-stale")?.state).toBe("error");
    expect(jobs.find((j) => j.id === "pending-stale")?.error).toBe("The page was closed before this render was queued.");
    expect(jobs.find((j) => j.id === "job-live")?.state).toBe("running");
  });

  it("fetches the result immediately when the websocket announces a finished prompt", async () => {
    let status: JobStatus = { id: "prompt-123", state: "running", outputs: [] };
    const { result, rerender } = renderStudio(
      [],
      [
        { method: "POST", url: "/api/generate", reply: { id: "prompt-123" } },
        { url: "/api/jobs/prompt-123", reply: () => status },
      ],
    );
    await flushAsync();
    await act(() => result.current.studio.loadCatalog());
    act(() => result.current.studio.update({ prompt: "A quick render" }));
    await act(() => result.current.studio.generate());
    expect(result.current.s.activeImage!.jobs[0].state).toBe("running");

    status = { id: "prompt-123", state: "done", outputs: [aJobOutput()] };
    await act(async () => rerender({ finished: ["prompt-123"] }));
    await flushAsync();

    expect(result.current.s.activeImage!.jobs[0].state).toBe("done");
  });
});
