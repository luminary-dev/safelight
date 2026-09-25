import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistory, getQueue, queuePrompt } from "@/lib/comfy/client";
import { buildGraph } from "@/lib/comfy/graph";
import type { GenerateRequest, JobOutput, JobStatus } from "@/lib/comfy/types";
import { unloadOllamaModels } from "@/lib/ollama/client";
import { generateCloudImages } from "@/lib/providers";
import { PROVIDERS, type ProviderId } from "@/lib/providers/keys";
import { OUTPUT_DIR, parseImageRef, safeJoin } from "@/lib/studio-files";

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
}

function clampFloat(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

export function sanitizeRequest(body: Partial<GenerateRequest>): GenerateRequest {
  if (!body.model?.name || !body.model.folder) throw new Error("Pick a model first.");
  return {
    mode: body.mode === "img2img" ? "img2img" : "txt2img",
    model: { name: String(body.model.name), folder: body.model.folder, provider: body.model.provider },
    textEncoders: Array.isArray(body.textEncoders) ? body.textEncoders.filter(Boolean).map(String) : [],
    vae: body.vae ? String(body.vae) : undefined,
    lora: body.lora?.name ? { name: String(body.lora.name), strength: clampFloat(body.lora.strength, -5, 5, 1) } : null,
    prompt: String(body.prompt ?? ""),
    negativePrompt: String(body.negativePrompt ?? ""),
    width: clampInt(body.width, 256, 4096, 1024),
    height: clampInt(body.height, 256, 4096, 1024),
    steps: clampInt(body.steps, 1, 150, 25),
    cfg: clampFloat(body.cfg, 0, 30, 1),
    seed: clampInt(body.seed, 0, Number.MAX_SAFE_INTEGER, 0),
    sampler: String(body.sampler ?? "euler"),
    scheduler: String(body.scheduler ?? "simple"),
    batch: clampInt(body.batch, 1, 8, 1),
    denoise: clampFloat(body.denoise, 0, 1, 0.75),
    images: Array.isArray(body.images) ? body.images.filter(Boolean).map(String).slice(0, 16) : [],
    refResolution: clampInt(body.refResolution, 0, 4096, 1024),
    matchInputSize: body.matchInputSize !== false,
  };
}

const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const EXT_BY_MIME: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

export async function runCloud(req: GenerateRequest): Promise<JobOutput[]> {
  const provider = req.model.provider;
  if (!provider || !PROVIDERS.includes(provider as ProviderId)) throw new Error("This cloud model has no provider.");
  if (!req.prompt.trim()) throw new Error("Prompt is empty.");

  const images = await Promise.all(
    (req.mode === "img2img" ? req.images : []).map(async (ref) => {
      const { dir, subfolder, filename } = parseImageRef(ref);
      const full = safeJoin(dir, subfolder, filename);
      if (!full) throw new Error(`Bad input reference: ${ref}`);
      const bytes = await readFile(full);
      return { bytes: new Uint8Array(bytes), mime: MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "image/png", name: filename };
    }),
  );

  const generated = await generateCloudImages(provider as ProviderId, req.model.name, {
    prompt: req.prompt,
    width: req.width,
    height: req.height,
    count: req.batch,
    images,
  });
  if (generated.length === 0) throw new Error("The provider returned no images.");

  const dir = path.join(OUTPUT_DIR, "cloud");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputs: JobOutput[] = [];
  for (const [i, img] of generated.entries()) {
    const filename = `${provider}_${stamp}_${i + 1}${EXT_BY_MIME[img.mime] ?? ".png"}`;
    await writeFile(path.join(dir, filename), Buffer.from(img.bytes));
    outputs.push({ filename, subfolder: "cloud", type: "output" });
  }
  return outputs;
}

/** Queues a local render on ComfyUI, freeing Ollama's memory first. Returns the prompt id. */
export async function queueLocal(req: GenerateRequest, clientId: string) {
  const graph = buildGraph(req);
  const freed = await unloadOllamaModels();
  const result = await queuePrompt(graph, clientId);
  return { id: result.prompt_id, graph, freed };
}

export async function jobStatus(id: string): Promise<JobStatus> {
  const entry = await getHistory(id);
  if (entry) {
    const outputs = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
    const failed = entry.status?.status_str === "error";
    let error: string | undefined;
    if (failed) {
      const msg = entry.status?.messages.find(([type]) => type === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
      error = msg?.exception_message ? `${msg.node_type ?? "Node"}: ${msg.exception_message}` : "Generation failed.";
    }
    return { id, state: failed ? "error" : "done", outputs, error };
  }
  const queue = await getQueue();
  const running = queue.queue_running.some(([, pid]) => pid === id);
  const pending = queue.queue_pending.some(([, pid]) => pid === id);
  const status: JobStatus = { id, state: running ? "running" : pending ? "queued" : "error", outputs: [] };
  if (status.state === "error") status.error = "Job vanished from the queue. It may have been cancelled.";
  return status;
}

/** Polls a ComfyUI job until it finishes. Used by the agent, which needs the result before it can continue. */
export async function waitForJob(id: string, opts: { timeoutMs?: number; onTick?: (s: JobStatus, elapsedMs: number) => void; signal?: AbortSignal } = {}): Promise<JobStatus> {
  const start = Date.now();
  const timeout = opts.timeoutMs ?? 25 * 60 * 1000;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    const s = await jobStatus(id);
    opts.onTick?.(s, Date.now() - start);
    if (s.state === "done" || s.state === "error") return s;
    if (Date.now() - start > timeout) return { id, state: "error", outputs: [], error: "Timed out waiting for the render." };
    await new Promise((r) => setTimeout(r, 2000));
  }
}
