"use client";

/* eslint-disable @next/next/no-img-element */
import { Download, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GalleryItem, JobOutput } from "@/lib/comfy/types";
import { stageLabel, viewUrl, type Job } from "@/lib/studio-state";
import type { ProgressState } from "@/hooks/useComfySocket";
import { ConfirmDelete } from "./ConfirmDelete";

function same(a: JobOutput, b: JobOutput) {
  return a.filename === b.filename && a.subfolder === b.subfolder;
}

/** Right column: the latest (or selected) render large, actions, and a filmstrip of earlier ones. */
export interface QueueEntry {
  job: Job;
  sessionTitle: string;
}

export function Stage({
  title,
  gallery,
  jobs,
  progress,
  filter,
  onFilter,
  onInterrupt,
  onUseAsInput,
  onDelete,
  queue,
}: {
  /** The active image session's title, shown as the panel heading. */
  title: string;
  gallery: GalleryItem[];
  jobs: Job[];
  progress: ProgressState;
  filter: "session" | "all";
  onFilter: (f: "session" | "all") => void;
  onInterrupt: () => void;
  onUseAsInput: (o: JobOutput) => void;
  onDelete: (o: JobOutput) => Promise<void>;
  /** Every queued or running render across all sessions, oldest first. */
  queue: QueueEntry[];
}) {
  const reduce = useReducedMotion();
  // Prefer the job that is actually sampling over one still waiting in line.
  const activeJob =
    jobs.find((j) => j.id === progress.activePromptId && (j.state === "queued" || j.state === "running")) ??
    jobs.find((j) => j.state === "running") ??
    jobs.find((j) => j.state === "queued") ??
    null;
  // Only surface a failure when it is the most recent thing that happened in this session.
  const failedJob = !activeJob && jobs[0]?.state === "error" ? jobs[0] : null;
  const jobFor = (item: GalleryItem) => jobs.find((j) => j.outputs.some((o) => same(o, item)));
  const items = useMemo(() => (filter === "session" ? gallery.filter((g) => Boolean(jobFor(g))) : gallery), [gallery, filter, jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = items.find((i) => `${i.subfolder}/${i.filename}` === selectedKey) ?? items[0] ?? null;
  const [viewer, setViewer] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  // A new render finishing should take the stage: adjust the selection while rendering when the newest item changes.
  const newestKey = items[0] ? `${items[0].subfolder}/${items[0].filename}` : null;
  const [seenNewest, setSeenNewest] = useState<string | null>(newestKey);
  if (newestKey !== seenNewest) {
    setSeenNewest(newestKey);
    setSelectedKey(newestKey);
  }

  const selectedJob = selected ? jobFor(selected) : undefined;

  return (
    <section className="flex min-h-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[22px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
          <p className="text-[13px] text-ink-muted">{activeJob ? "Rendering" : selected ? "Latest render" : "Nothing here yet"}</p>
        </div>
        <ToggleGroup type="single" value={filter} onValueChange={(v) => v && onFilter(v as "session" | "all")} spacing={0} className="shrink-0 rounded-full bg-pill p-[3px]" aria-label="Filmstrip filter">
          <ToggleGroupItem value="session" className="h-6 rounded-full! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
            This session
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-6 rounded-full! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
            Everything <span className="text-faint">{gallery.length}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className={`relative flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-[10px] border border-line shadow-[var(--shadow-hairline)] ${activeJob ? "safelight-wash" : "easel"}`}>
        <AnimatePresence mode="wait">
          {activeJob ? (
            <RenderingState key={activeJob.id} job={activeJob} progress={progress} onInterrupt={onInterrupt} />
          ) : failedJob && !selected ? (
            <motion.div key={failedJob.id} initial={false} className="max-w-md p-8 text-center">
              <p className="font-display text-lg text-ink">The last render failed</p>
              <p className="mt-2 break-words font-mono text-xs leading-relaxed text-danger">{failedJob.error}</p>
            </motion.div>
          ) : selected ? (
            <motion.button
              key={`${selected.subfolder}/${selected.filename}`}
              type="button"
              onClick={() => setViewer(true)}
              initial={reduce ? false : { opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="flex h-full w-full items-center justify-center p-3"
              aria-label="Open full size"
            >
              <img src={viewUrl(selected)} alt={selectedJob?.prompt || selected.filename} className="develop max-h-[min(70vh,900px)] max-w-full rounded-[6px] object-contain" />
            </motion.button>
          ) : (
            <motion.div key="empty" initial={false} className="max-w-sm p-8 text-center">
              <p className="font-display text-[22px] font-medium tracking-[-0.01em] text-ink">Nothing here yet</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-muted [text-wrap:pretty]">Describe something on the left and press Generate. Your image appears here, with earlier renders in the row below.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {queue.length > 1 || (queue.length === 1 && queue[0].job.id !== activeJob?.id) ? (
        <div className="card flex flex-col gap-2.5 p-3.5">
          <span className="form-label">
            Rendering queue <span className="text-placeholder">{queue.length}</span>
          </span>
          {queue.map(({ job, sessionTitle }) => {
            const live = progress.activePromptId === job.id;
            const { label, pct } = liveStage(job, progress);
            return (
              <div key={job.id} className="develop flex items-center gap-3">
                <span className={`size-1.5 shrink-0 rounded-full ${live ? "bg-terracotta pulse" : "bg-line-strong"}`} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted" title={job.prompt}>
                  <span className="font-medium text-ink">{job.settings.model}</span> · {job.prompt || sessionTitle}
                </span>
                <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-line">
                  {live && pct === null ? (
                    <div className="progress-sweep h-full rounded-full bg-terracotta/60" />
                  ) : (
                    <div className="h-full rounded-full bg-terracotta transition-[width] duration-300" style={{ width: live && pct !== null ? `${Math.max(4, pct)}%` : "0%" }} />
                  )}
                </div>
                <span className="w-28 shrink-0 truncate text-right font-mono text-[10.5px] text-faint">{live ? label : "queued"}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {selected && !activeJob ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] tracking-[0.02em] text-ink-muted" title={selectedJob?.prompt}>
            {selectedJob ? `${selectedJob.settings.model} · ${selectedJob.settings.width}×${selectedJob.settings.height} · seed ${selectedJob.seed}` : selected.filename}
          </p>
          <button type="button" className="btn-quiet" onClick={() => onUseAsInput(selected)}>
            <Pencil className="size-3.5" /> Edit
          </button>
          <a className="btn-quiet no-underline" href={viewUrl(selected)} download={selected.filename}>
            <Download className="size-3.5" /> Save
          </a>
          <a className="btn-quiet px-2 no-underline" href={viewUrl(selected)} target="_blank" rel="noreferrer" aria-label="Open full size">
            <ExternalLink className="size-3.5" />
          </a>
          <ConfirmDelete
            filename={selected.filename}
            onConfirm={() => onDelete(selected)}
            trigger={
              <button type="button" className="btn-quiet px-2 hover:border-danger/40 hover:text-danger" aria-label="Delete image">
                <Trash2 className="size-3.5" />
              </button>
            }
          />
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="contact-strip -mx-1 flex gap-1.5 overflow-x-auto">
          {items.map((it) => {
            const key = `${it.subfolder}/${it.filename}`;
            const on = key === (selected ? `${selected.subfolder}/${selected.filename}` : null);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedKey(key)}
                title={jobFor(it)?.prompt ?? it.filename}
                className={`h-[68px] w-[68px] flex-none overflow-hidden rounded-[3px] border transition-[border-color,transform] hover:-translate-y-0.5 ${on ? "border-terracotta" : "border-transparent"}`}
              >
                <img src={viewUrl(it)} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>
      ) : null}

      <AnimatePresence>
        {viewer && selected ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md"
            onClick={() => setViewer(false)}
          >
            <div className="flex items-center justify-between gap-3 px-6 py-4" onClick={(e) => e.stopPropagation()}>
              <p className="min-w-0 truncate font-mono text-xs text-ink-muted">{selectedJob?.prompt ?? selected.filename}</p>
              <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={() => setViewer(false)}>
                <X className="size-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <img src={viewUrl(selected)} alt={selected.filename} className="max-h-full max-w-full rounded-[12px] object-contain shadow-[var(--shadow-raised)]" onClick={(e) => e.stopPropagation()} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
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

function RenderingState({ job, progress, onInterrupt }: { job: Job; progress: ProgressState; onInterrupt: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  const isActive = progress.activePromptId === job.id;
  const { label, pct } = liveStage(job, progress);
  return (
    <motion.div initial={false} className="flex h-full w-full flex-col items-center justify-center gap-5 p-8">
      <div className="relative w-[min(60%,360px)] overflow-hidden rounded-[12px] bg-pill" style={{ aspectRatio: `${job.settings.width} / ${job.settings.height}`, maxHeight: "48vh" }}>
        {isActive && progress.preview ? <img src={progress.preview} alt="Preview" className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-pill via-paper-2 to-pill" />}
      </div>
      <div className="w-[min(60%,360px)]">
        <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-ink-muted">
          <span>{label}</span>
          <span>
            {pct !== null ? `${pct}% · ` : ""}
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line">
          {pct !== null ? (
            <motion.div className="h-full rounded-full bg-terracotta" animate={{ width: `${Math.max(2, pct)}%` }} transition={{ ease: "linear", duration: 0.2 }} />
          ) : (
            <div className="progress-sweep h-full rounded-full bg-terracotta/60" />
          )}
        </div>
        {pct === null && isActive && elapsed > 45 ? (
          <p className="mt-2 text-[12px] leading-relaxed text-faint [text-wrap:pretty]">{label === "Loading model" ? "Large models take a few minutes to load the first time; sampling starts right after." : "Still working — this stage does not report step progress."}</p>
        ) : null}
      </div>
      <p className="line-clamp-2 max-w-md text-center text-[13px] text-ink-muted">{job.prompt}</p>
      <button type="button" className="btn-quiet" onClick={onInterrupt}>
        Stop
      </button>
    </motion.div>
  );
}
