import type { Blueprint } from "@/lib/blueprints/types";
import type { GenerateRequest, JobOutput, ModelEntry, ModelFamily, ModelFolder } from "@/lib/comfy/types";
import type { LibraryRow } from "@/lib/library/search";
import type { Job } from "@/lib/safelight-state";
import type { ChatMessage, ChatSession, CodeSession, DesignSession, ImageSession, Project } from "@/lib/session-types";
import type { UsageInsert } from "@/lib/usage/record";

/**
 * Deterministic factories for the real domain shapes (typed against
 * src/lib/session-types.ts, comfy/types.ts, blueprints/types.ts, …).
 * Every factory takes a partial override and returns a complete object.
 * Ids and timestamps are sequential, not random, so assertions are exact
 * and two calls never collide; call resetFactorySequence() in beforeEach
 * for identical objects across tests.
 */

let seq = 0;
const T0 = 1_758_868_800_000; // 2025-09-26T08:00:00Z, an anchor well in the past

function next(): number {
  return ++seq;
}

export function resetFactorySequence(): void {
  seq = 0;
}

export function aProject(overrides: Partial<Project> = {}): Project {
  const n = next();
  return { id: `project-${n}`, title: `Project ${n}`, createdAt: T0 + n, updatedAt: T0 + n, ...overrides };
}

export function aMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const n = next();
  return { role: n % 2 === 1 ? "user" : "assistant", text: `Message ${n}`, ...overrides };
}

export function aChatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const n = next();
  return {
    id: `chat-${n}`,
    kind: "chat",
    title: `Chat ${n}`,
    titled: false,
    projectId: null,
    createdAt: T0 + n,
    updatedAt: T0 + n,
    model: "gpt-4o",
    messages: [aMessage({ role: "user", text: "Hello" }), aMessage({ role: "assistant", text: "Hi there" })],
    ...overrides,
  };
}

export function aJobOutput(overrides: Partial<JobOutput> = {}): JobOutput {
  const n = next();
  return { filename: `ComfyUI_${String(n).padStart(5, "0")}_.png`, subfolder: "safelight", type: "output", ...overrides };
}

export function aJob(overrides: Partial<Job> = {}): Job {
  const n = next();
  const state = overrides.state ?? "done";
  return {
    id: `job-${n}`,
    seed: 1000 + n,
    prompt: `A prompt ${n}`,
    startedAt: T0 + n,
    state,
    outputs: state === "done" ? [aJobOutput()] : [],
    ...(state === "error" ? { error: "Fake job error" } : {}),
    settings: { width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: "euler", scheduler: "simple", mode: "txt2img", model: "qwen-image-Q4_K_M.gguf" },
    ...overrides,
  };
}

export function anImageSession(overrides: Omit<Partial<ImageSession>, "jobs"> & { jobs?: number | Job[] } = {}): ImageSession {
  const n = next();
  const { jobs, ...rest } = overrides;
  const jobList = Array.isArray(jobs) ? jobs : Array.from({ length: jobs ?? 1 }, () => aJob());
  return {
    id: `image-${n}`,
    kind: "image",
    title: `Image session ${n}`,
    titled: false,
    projectId: null,
    createdAt: T0 + n,
    updatedAt: T0 + n,
    draft: "",
    currentJobId: jobList[jobList.length - 1]?.id ?? null,
    jobs: jobList,
    ...rest,
  };
}

export function aCodeSession(overrides: Partial<CodeSession> = {}): CodeSession {
  const n = next();
  return {
    id: `code-${n}`,
    kind: "code",
    title: `Code session ${n}`,
    titled: false,
    projectId: null,
    createdAt: T0 + n,
    updatedAt: T0 + n,
    model: "claude-sonnet-4-5",
    messages: [],
    root: `/tmp/fake-repo-${n}`,
    approvedPaths: [],
    ...overrides,
  };
}

export function aDesignSession(overrides: Partial<DesignSession> = {}): DesignSession {
  const n = next();
  return {
    id: `design-${n}`,
    kind: "design",
    title: `Design session ${n}`,
    titled: false,
    projectId: null,
    createdAt: T0 + n,
    updatedAt: T0 + n,
    model: "gpt-4o",
    messages: [],
    ...overrides,
  };
}

const FAMILY_NAME: Record<ModelFamily, string> = {
  "qwen-image": "qwen-image-Q4_K_M.gguf",
  flux: "flux1-dev-Q8_0.gguf",
  sdxl: "sd_xl_base_1.0.safetensors",
  sd15: "v1-5-pruned-emaonly.safetensors",
  unknown: "chroma-unlocked-v37.safetensors",
  cloud: "gpt-image-1",
};

const FAMILY_FOLDER: Record<ModelFamily, ModelFolder> = {
  "qwen-image": "unet_gguf",
  flux: "unet_gguf",
  sdxl: "checkpoints",
  sd15: "checkpoints",
  unknown: "diffusion_models",
  cloud: "cloud",
};

export function aModelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  const family = overrides.family ?? "qwen-image";
  const name = overrides.name ?? FAMILY_NAME[family];
  return {
    name,
    folder: FAMILY_FOLDER[family],
    family,
    label: name.replace(/\.(gguf|safetensors|ckpt|pt|pth)$/i, ""),
    ...(family === "cloud" ? { provider: "openai" as const, edit: true } : {}),
    ...overrides,
  };
}

export function aGenerateRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    mode: "txt2img",
    model: { name: "qwen-image-Q4_K_M.gguf", folder: "unet_gguf" },
    textEncoders: ["qwen_3_vl_7b_bf16.safetensors"],
    vae: "qwen_image_vae.safetensors",
    lora: null,
    prompt: "A lighthouse at dusk",
    negativePrompt: "",
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 2.5,
    seed: 42,
    sampler: "euler",
    scheduler: "simple",
    batch: 1,
    denoise: 1,
    images: [],
    refResolution: 0,
    matchInputSize: false,
    control: null,
    ...overrides,
  };
}

export function aBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  const n = next();
  return {
    id: `fake-blueprint-${n}`,
    name: `Fake Blueprint ${n}`,
    category: "image",
    inputs: [
      { key: "prompt", label: "Prompt", kind: "prompt", valueType: "STRING", default: "", required: true, targets: [{ nodeId: "6", input: "text" }] },
      { key: "seed", label: "Seed", kind: "number", valueType: "INT", default: 0, required: false, seed: true, targets: [{ nodeId: "3", input: "seed" }] },
    ],
    requiredNodeClasses: ["CheckpointLoaderSimple", "CLIPTextEncode", "KSampler", "VAEDecode", "SaveImage"],
    requiredModels: ["sd_xl_base_1.0.safetensors"],
    outputTypes: ["IMAGE"],
    ...overrides,
  };
}

export function aLibraryImage(overrides: Partial<LibraryRow> = {}): LibraryRow {
  const n = next();
  return {
    path: `safelight/ComfyUI_${String(n).padStart(5, "0")}_.png`,
    mtime: T0 + n * 1000,
    size: 1_234_567,
    width: 1024,
    height: 1024,
    model: "qwen-image-Q4_K_M.gguf",
    seed: 1000 + n,
    prompt: `A prompt ${n}`,
    meta: null,
    favorite: 0,
    tags: [],
    ...overrides,
  };
}

export function aUsageEvent(overrides: Partial<UsageInsert> = {}): UsageInsert {
  const n = next();
  return {
    provider: "openai",
    model: "gpt-4o",
    mode: "chat",
    inputTokens: 100 + n,
    outputTokens: 50 + n,
    images: 0,
    durationMs: 1200,
    ts: T0 + n,
    ...overrides,
  };
}
