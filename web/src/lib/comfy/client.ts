import "server-only";
import type { JobOutput } from "./types";

export const COMFY_URL = process.env.COMFY_URL ?? "http://127.0.0.1:8188";

class ComfyError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
  }
}

async function comfyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${COMFY_URL}${path}`, { cache: "no-store", ...init });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    throw new ComfyError(`ComfyUI ${path} failed with ${res.status}`, res.status, body);
  }
  return (await res.json()) as T;
}

export async function isComfyUp(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFY_URL}/system_stats`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function systemStats() {
  return comfyFetch<{
    system: { os: string; ram_total: number; ram_free: number; comfyui_version: string; pytorch_version: string };
    devices: { name: string; type: string; vram_total: number; vram_free: number }[];
  }>("/system_stats");
}

/** Lists files ComfyUI knows about in a model folder. Unknown folders return an empty list. */
export async function listFolder(folder: string): Promise<string[]> {
  try {
    return await comfyFetch<string[]>(`/models/${folder}`);
  } catch (err) {
    if (err instanceof ComfyError && err.status === 404) return [];
    throw err;
  }
}

export async function objectInfo(nodeClass: string) {
  const info = await comfyFetch<Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>>(
    `/object_info/${nodeClass}`,
  );
  return info[nodeClass];
}

export async function hasNode(nodeClass: string): Promise<boolean> {
  try {
    const info = await objectInfo(nodeClass);
    return Boolean(info);
  } catch {
    return false;
  }
}

export interface QueueResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export async function queuePrompt(graph: Record<string, unknown>, clientId: string, opts: { front?: boolean; promptId?: string } = {}): Promise<QueueResult> {
  try {
    return await comfyFetch<QueueResult>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId, ...(opts.front ? { front: true } : {}), ...(opts.promptId ? { prompt_id: opts.promptId } : {}) }),
    });
  } catch (err) {
    if (err instanceof ComfyError && err.body && typeof err.body === "object") {
      const body = err.body as { error?: { message?: string }; node_errors?: Record<string, { errors?: { message: string; details?: string }[] }> };
      const nodeMessages = Object.values(body.node_errors ?? {})
        .flatMap((n) => n.errors ?? [])
        .map((e) => (e.details ? `${e.message}: ${e.details}` : e.message));
      const message = [body.error?.message, ...nodeMessages].filter(Boolean).join(" | ");
      throw new ComfyError(message || err.message, err.status, err.body);
    }
    throw err;
  }
}

export interface HistoryEntry {
  status?: { status_str: "success" | "error"; completed: boolean; messages: [string, Record<string, unknown>][] };
  outputs: Record<string, { images?: JobOutput[] }>;
}

export async function getHistory(promptId: string): Promise<HistoryEntry | undefined> {
  const history = await comfyFetch<Record<string, HistoryEntry>>(`/history/${promptId}`);
  return history[promptId];
}

/** ComfyUI queue entries are tuples: [number, prompt_id, prompt graph, extra_data, outputs_to_execute]. */
export type QueueEntryTuple = [number, string, ...unknown[]];

export interface QueueSnapshot {
  queue_running: QueueEntryTuple[];
  queue_pending: QueueEntryTuple[];
}

export async function getQueue(): Promise<QueueSnapshot> {
  return comfyFetch<QueueSnapshot>("/queue");
}

/** Interrupts the running job. With a prompt id, ComfyUI only interrupts when that job is the one running. */
export async function interrupt(promptId?: string): Promise<void> {
  await fetch(`${COMFY_URL}/interrupt`, {
    method: "POST",
    ...(promptId ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) } : {}),
  });
}

/** Removes pending jobs from ComfyUI's queue. Running jobs are unaffected (use interrupt for those). */
export async function deleteQueued(promptIds: string[]): Promise<void> {
  const res = await fetch(`${COMFY_URL}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delete: promptIds }),
  });
  if (!res.ok) throw new ComfyError(`ComfyUI /queue delete failed with ${res.status}`, res.status);
}

/** Wipes every pending (not running) job from ComfyUI's queue. */
export async function clearPendingQueue(): Promise<void> {
  const res = await fetch(`${COMFY_URL}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clear: true }),
  });
  if (!res.ok) throw new ComfyError(`ComfyUI /queue clear failed with ${res.status}`, res.status);
}

/** Cancels one job whatever its state: interrupt when running, dequeue when pending, no-op otherwise. */
export async function cancelJob(promptId: string): Promise<"interrupted" | "dequeued" | "noop"> {
  const queue = await getQueue();
  if (queue.queue_running.some((e) => e[1] === promptId)) {
    await interrupt(promptId);
    return "interrupted";
  }
  if (queue.queue_pending.some((e) => e[1] === promptId)) {
    await deleteQueued([promptId]);
    return "dequeued";
  }
  return "noop";
}

/**
 * Moves a pending job to the front of the queue by re-queuing its graph with front: true
 * under the same prompt id, so existing polls and progress keep working.
 * Returns false when the job is not pending any more (already running or finished).
 */
export async function promoteQueued(promptId: string): Promise<boolean> {
  const queue = await getQueue();
  const entry = queue.queue_pending.find((e) => e[1] === promptId);
  const graph = entry?.[2] as Record<string, unknown> | undefined;
  if (!graph) return false;
  const extra = (entry?.[3] ?? {}) as { client_id?: string };
  await deleteQueued([promptId]);
  // The job may have started running between the snapshot and the delete; re-queuing it then would run it twice.
  const after = await getQueue();
  if (after.queue_running.some((e) => e[1] === promptId) || after.queue_pending.some((e) => e[1] === promptId)) return false;
  await queuePrompt(graph, extra.client_id ?? "safelight", { front: true, promptId });
  return true;
}

export async function uploadImage(file: File, subfolder = "safelight"): Promise<JobOutput> {
  const form = new FormData();
  form.append("image", file, file.name);
  form.append("subfolder", subfolder);
  form.append("type", "input");
  form.append("overwrite", "false");
  const res = await fetch(`${COMFY_URL}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new ComfyError(`Upload failed with ${res.status}`, res.status);
  const data = (await res.json()) as { name: string; subfolder: string; type: string };
  return { filename: data.name, subfolder: data.subfolder, type: data.type };
}

/** Streams a file from ComfyUI's output or input directory. */
export async function fetchView(output: JobOutput): Promise<Response> {
  const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? "", type: output.type ?? "output" });
  return fetch(`${COMFY_URL}/view?${params}`, { cache: "no-store" });
}

/** The name LoadImage expects: "subfolder/filename" when uploaded into a subfolder. */
export function inputRef(output: JobOutput): string {
  return output.subfolder ? `${output.subfolder}/${output.filename}` : output.filename;
}

export { ComfyError };
