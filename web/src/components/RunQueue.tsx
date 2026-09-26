"use client";

import { ChevronsUp, X } from "lucide-react";
import { useState } from "react";
import type { ProgressState } from "@/hooks/useComfySocket";
import { stageLabel, type Job } from "@/lib/safelight-state";

export interface QueueEntry {
  job: Job;
  sessionTitle: string;
}

/** What the active job is truly doing right now, from the executing node and its progress counters. */
export function liveStage(job: Job, progress: ProgressState): { label: string; pct: number | null } {
  const isActive = progress.activePromptId === job.id;
  if (!isActive) return { label: job.state === "queued" ? "Queued" : "Rendering", pct: null };
  const currentClass = progress.nodeLabel ? job.nodes?.[progress.nodeLabel] : undefined;
  const hasCounter = progress.totalSteps > 0;
  if (currentClass === "KSampler") return { label: hasCounter ? `Step ${progress.step} of ${progress.totalSteps}` : "Rendering", pct: hasCounter ? Math.round(progress.progress * 100) : null };
  if (currentClass) return { label: stageLabel(currentClass), pct: hasCounter ? Math.round(progress.progress * 100) : null };
  return { label: "Starting", pct: null };
}

/** Jobs that only exist in the browser (not yet queued, or cloud one-shots) have no ComfyUI queue entry to manage. */
function isManageable(job: Job): boolean {
  return !job.id.startsWith("pending-") && !job.id.startsWith("cloud-");
}

/**
 * The rendering queue card: every queued or running render across all sessions,
 * with truthful staged progress plus per-job Cancel, Run next, and Clear queued.
 */
export function RunQueue({ queue, progress }: { queue: QueueEntry[]; progress: ProgressState }) {
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const cancel = async (job: Job) => {
    // The server decides: interrupt when running, dequeue when pending.
    mark(job.id, true);
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    } catch {
      // The poller keeps the row honest either way.
    } finally {
      mark(job.id, false);
    }
  };

  const runNext = async (job: Job) => {
    mark(job.id, true);
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "front" }) });
    } catch {
      // No-op: the job stays where it was.
    } finally {
      mark(job.id, false);
    }
  };

  const [clearing, setClearing] = useState(false);
  const clearQueued = async () => {
    setClearing(true);
    try {
      await fetch("/api/jobs", { method: "DELETE" });
    } catch {
      // No-op: pollers reconcile whatever actually happened.
    } finally {
      setClearing(false);
    }
  };

  const queuedCount = queue.filter(({ job }) => isManageable(job) && job.state === "queued" && progress.activePromptId !== job.id).length;

  return (
    <div className="card flex flex-col gap-2.5 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="form-label">
          Rendering queue <span className="text-placeholder">{queue.length}</span>
        </span>
        {queuedCount > 0 ? (
          <button type="button" className="btn-quiet h-6 px-2 font-mono text-[10.5px] max-lg:min-h-11" onClick={() => void clearQueued()} disabled={clearing} title="Remove every waiting render from the queue">
            Clear queued
          </button>
        ) : null}
      </div>
      {queue.map(({ job, sessionTitle }) => {
        const live = progress.activePromptId === job.id;
        const { label, pct } = liveStage(job, progress);
        const manageable = isManageable(job);
        const waiting = manageable && !live && job.state === "queued";
        const rowBusy = busy.has(job.id);
        return (
          <div key={job.id} className="develop flex items-center gap-3">
            <span className={`size-1.5 shrink-0 rounded-full ${live ? "bg-terracotta pulse" : "bg-line-strong"}`} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted" title={job.prompt}>
              <span className="font-medium text-ink">{job.settings.model}</span> · {job.prompt || sessionTitle}
            </span>
            <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-line max-sm:w-12">
              {live && pct === null ? (
                <div className="progress-sweep h-full rounded-full bg-terracotta/60" />
              ) : (
                <div className="h-full rounded-full bg-terracotta transition-[width] duration-300" style={{ width: live && pct !== null ? `${Math.max(4, pct)}%` : "0%" }} />
              )}
            </div>
            <span className="w-28 shrink truncate text-right font-mono text-[10.5px] text-faint" title={live ? label : "queued"}>{live ? label : "queued"}</span>
            {waiting ? (
              <button type="button" className="btn-quiet h-6 shrink-0 px-1.5 max-lg:min-h-11 max-lg:min-w-11" onClick={() => void runNext(job)} disabled={rowBusy} title="Run this render next" aria-label="Run next">
                <ChevronsUp className="size-3.5" />
              </button>
            ) : null}
            {manageable ? (
              <button
                type="button"
                className="btn-quiet h-6 shrink-0 px-1.5 hover:border-danger/40 hover:text-danger max-lg:min-h-11 max-lg:min-w-11"
                onClick={() => void cancel(job)}
                disabled={rowBusy}
                title={live || job.state === "running" ? "Stop this render" : "Remove from the queue"}
                aria-label="Cancel render"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
