import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateRequest, JobStatus } from "@/lib/comfy/types";
import { seedMathRandom } from "@/test/determinism";
import { startFakeComfy, type FakeComfy } from "@/test/fakes/comfy-server";
import { makeTestRoot, type TestRoot } from "@/test/fixtures/tmpdir";

/**
 * lib/agent/tools.ts — the 3.1 % module (TEST-BRIEF §6): the pickModel matrix,
 * generate_image's aspect→preset mapping / count clamp / cloud short-circuit
 * vs local queue+wait (with progress note ticks against the comfy fake),
 * edit_image's <image1> rewrite and [output] suffix rules, and
 * list_recent_images' nesting, limit clamp, ordering, and OUTPUT_DIR
 * confinement. Every render result must pin `modelId` to the raw identifier —
 * pricing matches on it.
 *
 * generate-core is wrapped, not replaced: sanitizeRequest stays real (the
 * clamps under test live there), queueLocal/waitForJob/runCloud capture the
 * request and either answer a scripted result (unit mode) or fall through to
 * the real implementation against the fake ComfyUI (integration mode).
 */

const gc = vi.hoisted(() => ({
  real: false,
  captured: [] as GenerateRequest[],
  cloudCalls: 0,
  localCalls: 0,
  waitResult: null as JobStatus | null,
  waitScript: null as ((opts: { onTick?: (s: JobStatus, elapsedMs: number) => void }) => JobStatus) | null,
}));

const cloud = vi.hoisted(() => ({
  images: [] as { provider: "openai" | "gemini"; id: string; label: string; edit: boolean; tags: string[] }[],
}));

vi.mock("@/lib/providers", () => ({
  cloudCatalog: vi.fn(async () => ({ chat: [], images: cloud.images, errors: {} })),
  generateCloudImages: vi.fn(async () => []),
}));

vi.mock("@/lib/generate-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/generate-core")>();
  return {
    ...real,
    queueLocal: vi.fn(async (req: GenerateRequest, clientId: string) => {
      gc.captured.push(req);
      gc.localCalls++;
      if (gc.real) return real.queueLocal(req, clientId);
      return { id: "job-1", graph: {}, freed: [] };
    }),
    waitForJob: vi.fn(async (id: string, opts: { onTick?: (s: JobStatus, elapsedMs: number) => void; signal?: AbortSignal }) => {
      if (gc.real) return real.waitForJob(id, opts);
      if (gc.waitScript) return gc.waitScript(opts);
      return gc.waitResult ?? { id, state: "done" as const, outputs: [{ filename: "qwen_00001_.png", subfolder: "safelight", type: "output" }] };
    }),
    runCloud: vi.fn(async (req: GenerateRequest) => {
      gc.captured.push(req);
      gc.cloudCalls++;
      return [{ filename: `${req.model.provider}_fake_1.png`, subfolder: "cloud", type: "output" }];
    }),
  };
});

const QWEN = "qwen-image-2.1-Q4_K_M.gguf";
const FLUX = "flux1-dev-Q8_0.gguf";

let comfy: FakeComfy;
let root: TestRoot;
let tools: typeof import("./tools");
let events: import("./tools").AgentEvent[];
let restoreRandom: () => void;

function ctx(overrides: Partial<import("./tools").ToolContext> = {}): import("./tools").ToolContext {
  return { clientId: "agent-test", emit: (e) => events.push(e), ...overrides };
}

function localFolders() {
  comfy.setObjectInfo("UnetLoaderGGUF", { input: { required: { unet_name: [[]] } } });
  comfy.setFolder("unet_gguf", [QWEN, FLUX]);
  comfy.setFolder("text_encoders", ["qwen_3_vl_7b_bf16.safetensors", "t5xxl_fp16.safetensors", "clip_l.safetensors"]);
  comfy.setFolder("vae", ["qwen_image_2.1_vae.safetensors", "ae.safetensors"]);
}

beforeAll(async () => {
  root = await makeTestRoot(); // pins COMFY_OUTPUT_DIR before the module chain resolves OUTPUT_DIR
  comfy = await startFakeComfy();
  vi.stubEnv("COMFY_URL", comfy.url);
  vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:9"); // deliberately unreachable: never touch a real Ollama
  tools = await import("./tools");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await comfy.close();
  await root.cleanup();
});

beforeEach(() => {
  events = [];
  gc.real = false;
  gc.captured = [];
  gc.cloudCalls = 0;
  gc.localCalls = 0;
  gc.waitResult = null;
  gc.waitScript = null;
  cloud.images = [{ provider: "openai", id: "gpt-image-1", label: "GPT Image 1", edit: true, tags: [] }];
  // Reset the fake in place rather than restart(): undici's keep-alive pool holds
  // sockets to the old listener, and the first request after a rebind fails.
  comfy.setAutoComplete(true);
  localFolders();
  restoreRandom = seedMathRandom(7);
});

afterEach(() => {
  restoreRandom();
});

type RenderResult = { images: string[]; seed: number; model: string; modelId: string };

async function generate(args: Record<string, unknown>, context = ctx()) {
  const out = await tools.executeTool("generate_image", args, context, "tool-1");
  return { ...out, result: out.result as RenderResult };
}

async function edit(args: Record<string, unknown>, context = ctx()) {
  const out = await tools.executeTool("edit_image", args, context, "tool-1");
  return { ...out, result: out.result as RenderResult };
}

// ---------------------------------------------------------------------------
// pickModel matrix (observed through the tools, pinned via result.modelId)

describe("model picking", () => {
  it("a requested folder:name id wins over the UI preference", async () => {
    const { result } = await generate({ prompt: "p", model: `unet_gguf:${FLUX}` }, ctx({ preferredModel: `unet_gguf:${QWEN}` }));
    expect(result.modelId).toBe(FLUX);
  });

  it("a requested bare name resolves too", async () => {
    const { result } = await generate({ prompt: "p", model: QWEN });
    expect(result.modelId).toBe(QWEN);
  });

  it("a requested label matches case-insensitively", async () => {
    const { result } = await generate({ prompt: "p", model: "gpt image 1" });
    expect(result.modelId).toBe("gpt-image-1");
    expect(gc.cloudCalls).toBe(1);
  });

  it("without a request, the UI-preferred model is used", async () => {
    const { result } = await generate({ prompt: "p" }, ctx({ preferredModel: `unet_gguf:${FLUX}` }));
    expect(result.modelId).toBe(FLUX);
  });

  it("an unknown requested id falls back to the preference, then the first usable model", async () => {
    const { result } = await generate({ prompt: "p", model: "no-such-model" }, ctx({ preferredModel: `unet_gguf:${FLUX}` }));
    expect(result.modelId).toBe(FLUX);
    const first = await generate({ prompt: "p", model: "no-such-model" });
    expect(first.result.modelId).toBe(QWEN); // first catalog entry
  });

  it("edit_image filters cloud models that cannot edit and keeps local ones", async () => {
    cloud.images = [{ provider: "openai", id: "dall-e-3", label: "DALL·E 3", edit: false, tags: [] }];
    const { result } = await edit({ image: "a.png", instruction: "warmer light", model: "dall-e-3" });
    // The requested cloud model cannot edit, so the pick falls through to the first local model.
    expect(result.modelId).toBe(QWEN);
    expect(gc.localCalls).toBe(1);
  });

  it("no model at all → the generate message that names both remedies", async () => {
    comfy.setFolder("unet_gguf", []);
    cloud.images = [];
    await expect(generate({ prompt: "p" })).rejects.toThrow("No image model is available. Start ComfyUI or add an OpenAI or Gemini key.");
  });

  it("no edit-capable model → the edit-specific message", async () => {
    comfy.setFolder("unet_gguf", []);
    cloud.images = [{ provider: "openai", id: "dall-e-3", label: "DALL·E 3", edit: false, tags: [] }];
    await expect(edit({ image: "a.png", instruction: "x" })).rejects.toThrow("No model that supports edits is available.");
  });
});

// ---------------------------------------------------------------------------
// generate_image

describe("generate_image", () => {
  it("rejects an empty prompt before touching any backend", async () => {
    await expect(generate({ prompt: "  " })).rejects.toThrow("generate_image needs a prompt.");
    expect(gc.captured).toHaveLength(0);
  });

  it.each([
    ["1:1", 1024, 1024],
    ["3:4", 896, 1152],
    ["16:9", 1344, 768],
    ["9:16", 768, 1344],
  ])("maps aspect %s to its preset size %d×%d", async (aspect, width, height) => {
    await generate({ prompt: "p", aspect });
    expect(gc.captured[0]).toMatchObject({ width, height });
  });

  it("defaults to square and falls back to square for an unknown aspect", async () => {
    await generate({ prompt: "p" });
    await generate({ prompt: "p", aspect: "7:5" });
    expect(gc.captured[0]).toMatchObject({ width: 1024, height: 1024 });
    expect(gc.captured[1]).toMatchObject({ width: 1024, height: 1024 });
  });

  it.each([
    [9, 4],
    [0, 1],
    [2.6, 3],
    [undefined, 1],
  ])("clamps count %s to batch %d", async (count, batch) => {
    await generate(count === undefined ? { prompt: "p" } : { prompt: "p", count });
    expect(gc.captured[0].batch).toBe(batch);
  });

  it("cloud models short-circuit to runCloud: no queue, no wait, no progress notes", async () => {
    const { result, images } = await generate({ prompt: "p", model: "cloud:gpt-image-1" });
    expect(gc.cloudCalls).toBe(1);
    expect(gc.localCalls).toBe(0);
    expect(events).toEqual([]); // ticks are a local-queue phenomenon
    expect(result.images).toEqual(["cloud/openai_fake_1.png"]);
    expect(result.model).toBe("GPT Image 1");
    expect(result.modelId).toBe("gpt-image-1"); // pricing matches on the raw id
    expect(images).toEqual([{ filename: "openai_fake_1.png", subfolder: "cloud", type: "output" }]);
  });

  it("local models queue and wait, forwarding each tick as a running note", async () => {
    gc.waitScript = ({ onTick }) => {
      onTick?.({ id: "job-1", state: "queued", outputs: [] }, 400);
      onTick?.({ id: "job-1", state: "running", outputs: [] }, 3200);
      return { id: "job-1", state: "done", outputs: [{ filename: "qwen_00001_.png", subfolder: "safelight", type: "output" }] };
    };
    const { result } = await generate({ prompt: "p", model: QWEN });
    expect(gc.localCalls).toBe(1);
    expect(events).toEmitAgentEvents([
      { type: "tool", id: "tool-1", name: "generate_image", state: "running", note: "Queued · 0s" },
      { type: "tool", id: "tool-1", name: "generate_image", state: "running", note: "Rendering · 3s" },
    ]);
    expect(result.images).toEqual(["safelight/qwen_00001_.png"]);
    expect(result.model).toBe("Qwen-Image 2.1");
    expect(result.modelId).toBe(QWEN);
    expect(result.seed).toBe(gc.captured[0].seed); // the seed reported is the seed rendered
  });

  it("a failed local job surfaces its error, and a message-less failure gets the fallback", async () => {
    gc.waitResult = { id: "job-1", state: "error", outputs: [], error: "KSampler: CUDA out of memory" };
    await expect(generate({ prompt: "p", model: QWEN })).rejects.toThrow("KSampler: CUDA out of memory");
    gc.waitResult = { id: "job-1", state: "error", outputs: [] };
    await expect(generate({ prompt: "p", model: QWEN })).rejects.toThrow("Render failed.");
  });

  it("integration: the real queue+wait chain against the fake ComfyUI emits Queued then Rendering ticks", async () => {
    gc.real = true;
    comfy.setAutoComplete(false);
    vi.useFakeTimers({ toFake: ["setTimeout"] }); // fake only the poll sleep; I/O and Date stay real
    const yieldIo = async (until: () => boolean) => {
      for (let i = 0; i < 2000 && !until(); i++) await new Promise((r) => setImmediate(r));
    };
    try {
      const pending = generate({ prompt: "p", model: QWEN });
      pending.catch(() => {}); // asserted below; never unhandled
      const notes = () => events.flatMap((e) => (e.type === "tool" && e.note ? [e.note] : []));
      await yieldIo(() => notes().length >= 1);
      expect(notes()[0]).toMatch(/^Queued · \d+s$/);
      comfy.completePrompt("fake-prompt-1");
      // Wake the 2 s poll sleep; the next jobStatus sees the finished history entry.
      await vi.advanceTimersByTimeAsync(2100);
      await yieldIo(() => notes().length >= 2);
      const { result } = await pending;
      expect(notes().at(-1)).toMatch(/^Rendering · \d+s$/);
      expect(result.images).toEqual(["safelight/ComfyUI_00001_.png"]);
      expect(result.modelId).toBe(QWEN);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// edit_image

describe("edit_image", () => {
  it("requires both an image and an instruction", async () => {
    await expect(edit({ image: "", instruction: "x" })).rejects.toThrow("edit_image needs an image reference and an instruction.");
    await expect(edit({ image: "a.png", instruction: " " })).rejects.toThrow("edit_image needs an image reference and an instruction.");
  });

  it("appends the <image1> anchor to a Qwen instruction only when absent", async () => {
    await edit({ image: "a.png", instruction: "make it dusk", model: QWEN });
    expect(gc.captured[0].prompt).toBe("make it dusk Keep everything else in <image1> unchanged.");

    await edit({ image: "a.png", instruction: "replace the sky in <image1> with dusk", model: QWEN });
    expect(gc.captured[1].prompt).toBe("replace the sky in <image1> with dusk");
  });

  it("leaves non-Qwen instructions untouched", async () => {
    await edit({ image: "a.png", instruction: "make it dusk", model: FLUX });
    expect(gc.captured[0].prompt).toBe("make it dusk");
  });

  it("suffixes [output] to the image reference only when no type tag is present", async () => {
    await edit({ image: "safelight/a.png", instruction: "x", model: QWEN });
    expect(gc.captured[0].images).toEqual(["safelight/a.png [output]"]);

    await edit({ image: "b.png [input]", instruction: "x", model: QWEN });
    expect(gc.captured[1].images).toEqual(["b.png [input]"]);

    await edit({ image: "c.png [output]", instruction: "x", model: QWEN });
    expect(gc.captured[2].images).toEqual(["c.png [output]"]);
  });

  it("builds an img2img request: denoise 0.6, batch 1, and pins modelId on the result", async () => {
    const { result } = await edit({ image: "a.png", instruction: "x", model: QWEN });
    expect(gc.captured[0]).toMatchObject({ mode: "img2img", denoise: 0.6, batch: 1 });
    expect(result.modelId).toBe(QWEN);
    expect(result.model).toBe("Qwen-Image 2.1");
  });

  it("a cloud edit model short-circuits to runCloud with the raw id pinned", async () => {
    const { result } = await edit({ image: "a.png", instruction: "x", model: "cloud:gpt-image-1" });
    expect(gc.cloudCalls).toBe(1);
    expect(result.modelId).toBe("gpt-image-1");
  });
});

// ---------------------------------------------------------------------------
// list_models

describe("list_models", () => {
  it("merges local and cloud models with ids, provenance, and edit support", async () => {
    const { result } = await tools.executeTool("list_models", {}, ctx(), "t");
    const { models, comfyOnline } = result as { models: { id: string; where: string; supportsEdit: boolean }[]; comfyOnline: boolean };
    expect(comfyOnline).toBe(true);
    expect(models.find((m) => m.id === `unet_gguf:${QWEN}`)).toMatchObject({ where: "local", supportsEdit: true });
    expect(models.find((m) => m.id === "cloud:gpt-image-1")).toMatchObject({ where: "openai", supportsEdit: true });
  });
});

// ---------------------------------------------------------------------------
// list_recent_images

describe("list_recent_images", () => {
  beforeEach(async () => {
    await rm(root.outputsDir, { recursive: true, force: true });
    await mkdir(root.outputsDir, { recursive: true });
  });

  async function stamp(rel: string, minutesAgo: number, content = "x") {
    const full = path.join(root.outputsDir, rel);
    await writeFile(full, content);
    const t = new Date(Date.now() - minutesAgo * 60_000);
    await utimes(full, t, t);
  }

  it("walks nested folders, newest first, skipping non-image files", async () => {
    await stamp("old.png", 30);
    await mkdir(path.join(root.outputsDir, "safelight", "deep"), { recursive: true });
    await stamp("safelight/mid.jpeg", 20);
    await stamp("safelight/deep/new.webp", 5);
    await stamp("safelight/notes.txt", 1);
    const { result, images } = await tools.executeTool("list_recent_images", {}, ctx(), "t");
    const refs = (result as { images: { ref: string }[] }).images.map((i) => i.ref);
    expect(refs).toEqual(["safelight/deep/new.webp", "safelight/mid.jpeg", "old.png"]);
    expect(images![0]).toEqual({ filename: "new.webp", subfolder: "safelight/deep", type: "output" });
    for (const ref of refs) expect(path.join(root.outputsDir, ref)).toBeWithinDirectory(root.outputsDir);
  });

  it("clamps the limit into 1–24 and defaults to 8", async () => {
    for (let i = 0; i < 26; i++) await stamp(`img_${String(i).padStart(2, "0")}.png`, 26 - i);
    const call = async (args: Record<string, unknown>) => {
      const { result } = await tools.executeTool("list_recent_images", args, ctx(), "t");
      return (result as { images: unknown[] }).images.length;
    };
    expect(await call({})).toBe(8);
    expect(await call({ limit: 2 })).toBe(2);
    expect(await call({ limit: 999 })).toBe(24);
    expect(await call({ limit: 0 })).toBe(1);
    expect(await call({ limit: "12" })).toBe(8); // non-numbers keep the default
  });

  it("stays confined to OUTPUT_DIR: a symlinked folder pointing outside is not followed", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "sl-outside-"));
    writeFileSync(path.join(outside, "secret.png"), "x");
    await symlink(outside, path.join(root.outputsDir, "escape"), "dir");
    await stamp("inside.png", 1);
    const { result } = await tools.executeTool("list_recent_images", {}, ctx(), "t");
    const refs = (result as { images: { ref: string }[] }).images.map((i) => i.ref);
    expect(refs).toEqual(["inside.png"]);
    expect(refs.some((r) => r.includes("secret"))).toBe(false);
  });

  it("returns an empty list when OUTPUT_DIR does not exist rather than throwing", async () => {
    await rm(root.outputsDir, { recursive: true, force: true });
    const { result } = await tools.executeTool("list_recent_images", {}, ctx(), "t");
    expect((result as { images: unknown[] }).images).toEqual([]);
    await mkdir(root.outputsDir, { recursive: true });
  });
});

describe("unknown tools", () => {
  it("name the tool in the error", async () => {
    await expect(tools.executeTool("mystery_tool", {}, ctx(), "t")).rejects.toThrow("Unknown tool: mystery_tool");
  });
});
