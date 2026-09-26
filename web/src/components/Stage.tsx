"use client";

/* eslint-disable @next/next/no-img-element */
import { Brush, Download, Eraser, ExternalLink, Pencil, RefreshCw, Shuffle, Trash2, UnfoldHorizontal, X, ZoomIn } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GalleryItem, ImageCapabilities, JobOutput, JobStatus } from "@/lib/comfy/types";
import { viewUrl, type Job } from "@/lib/safelight-state";
import type { ProgressState } from "@/hooks/useComfySocket";
import { ConfirmDelete } from "./ConfirmDelete";
import { MaskCanvas, OutpaintControls, type InpaintSubmission, type OutpaintSubmission } from "./MaskCanvas";
import { liveStage, RunQueue, type QueueEntry } from "./RunQueue";

export { liveStage, type QueueEntry };

function same(a: JobOutput, b: JobOutput) {
  return a.filename === b.filename && a.subfolder === b.subfolder;
}

function itemKey(o: JobOutput) {
  return `${o.subfolder}/${o.filename}`;
}

/** The ComfyUI-style reference for a gallery item, e.g. "safelight/x.png [output]". */
function imageRef(o: JobOutput): string {
  const rel = o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
  return (o.type ?? "output") === "output" ? `${rel} [output]` : rel;
}

function browserClientId(): string {
  try {
    return localStorage.getItem("safelight.clientId.v1") ?? "safelight";
  } catch {
    return "safelight";
  }
}

/** A one-click Stage action (recreate, vary, upscale, background removal) being tracked locally. */
interface StageAction {
  id: string;
  label: string;
  state: "queued" | "running" | "done" | "error";
  error?: string;
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

  // Outputs of Stage actions (upscale, recreate…) belong to this session's view even though no Safelight job owns them.
  const [actionOutputKeys, setActionOutputKeys] = useState<Set<string>>(new Set());
  // Fresh gallery items fetched right after a Stage action finishes, merged until the app reloads the gallery itself.
  const [extraItems, setExtraItems] = useState<GalleryItem[]>([]);
  const mergedGallery = useMemo(() => {
    if (extraItems.length === 0) return gallery;
    const seen = new Set(gallery.map(itemKey));
    const extras = extraItems.filter((g) => !seen.has(itemKey(g)));
    return extras.length === 0 ? gallery : [...gallery, ...extras].sort((a, b) => b.mtime - a.mtime);
  }, [gallery, extraItems]);

  const items = useMemo(
    () => (filter === "session" ? mergedGallery.filter((g) => Boolean(jobFor(g)) || actionOutputKeys.has(itemKey(g))) : mergedGallery),
    [mergedGallery, filter, jobs, actionOutputKeys], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = items.find((i) => itemKey(i) === selectedKey) ?? items[0] ?? null;
  const [viewer, setViewer] = useState(false);

  // ---------- one-click actions on the selected image ----------
  const [caps, setCaps] = useState<ImageCapabilities | null>(null);
  useEffect(() => {
    let stale = false;
    fetch("/api/generate")
      .then((r) => (r.ok ? (r.json() as Promise<ImageCapabilities>) : null))
      .then((c) => !stale && c && setCaps(c))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, []);

  // Whether the selected image has a metadata sidecar, and which mode wrote it (enables Recreate/Vary/Inpaint/Outpaint).
  const selectedRef = selected ? imageRef(selected) : null;
  const [sidecarByRef, setSidecarByRef] = useState<Record<string, { present: boolean; mode?: string }>>({});
  useEffect(() => {
    if (!selectedRef || selectedRef in sidecarByRef) return;
    let stale = false;
    fetch(`/api/generate?sidecar=${encodeURIComponent(selectedRef)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ sidecar: { mode?: string } | null }>) : null))
      .then((d) => !stale && d && setSidecarByRef((m) => ({ ...m, [selectedRef]: { present: Boolean(d.sidecar), mode: d.sidecar?.mode } })))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [selectedRef, sidecarByRef]);
  const sidecarInfo = selectedRef ? sidecarByRef[selectedRef] : undefined;
  const hasSidecar = sidecarInfo?.present === true;

  const [actions, setActions] = useState<StageAction[]>([]);
  const actionTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  useEffect(() => {
    const timers = actionTimers.current;
    return () => timers.forEach((t) => clearInterval(t));
  }, []);

  const updateAction = useCallback((id: string, patch: Partial<StageAction>) => {
    setActions((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const finishAction = useCallback(
    async (id: string, status: JobStatus) => {
      const timer = actionTimers.current.get(id);
      if (timer) {
        clearInterval(timer);
        actionTimers.current.delete(id);
      }
      if (status.state === "error") {
        updateAction(id, { state: "error", error: status.error ?? "The job failed." });
        return;
      }
      updateAction(id, { state: "done" });
      const keys = status.outputs.map(itemKey);
      setActionOutputKeys((s) => new Set([...s, ...keys]));
      // The app only reloads the gallery for jobs it queued itself, so fetch the fresh items here.
      try {
        const res = await fetch("/api/gallery");
        if (res.ok) {
          const data = (await res.json()) as { items: GalleryItem[] };
          const fresh = data.items.filter((g) => keys.includes(itemKey(g)));
          setExtraItems((prev) => [...prev.filter((p) => !fresh.some((f) => itemKey(f) === itemKey(p))), ...fresh]);
        }
      } catch {
        // The result still lands on the next gallery reload.
      }
      if (keys[0]) setSelectedKey(keys[0]);
      // A new render carries a new sidecar; forget any cached "absent" answer.
      setSidecarByRef((m) => {
        const next = { ...m };
        for (const out of status.outputs) delete next[imageRef(out)];
        return next;
      });
      // Drop finished rows after a moment so the strip stays small.
      setTimeout(() => setActions((list) => list.filter((a) => a.id !== id)), 4000);
    },
    [updateAction],
  );

  const pollAction = useCallback(
    (id: string) => {
      const tick = async () => {
        const res = await fetch(`/api/jobs/${id}`).catch(() => null);
        if (!res?.ok) return;
        const status = (await res.json()) as JobStatus;
        if (status.state === "done" || status.state === "error") void finishAction(id, status);
        else updateAction(id, { state: status.state });
      };
      actionTimers.current.set(id, setInterval(tick, 1500));
      void tick();
    },
    [finishAction, updateAction],
  );

  const runAction = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      const tempId = `pending-${crypto.randomUUID()}`;
      setActions((list) => [...list, { id: tempId, label, state: "queued" }]);
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, clientId: browserClientId() }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) throw new Error(data.error ?? "Failed to queue.");
        setActions((list) => list.map((a) => (a.id === tempId ? { ...a, id: data.id! } : a)));
        pollAction(data.id);
      } catch (err) {
        updateAction(tempId, { state: "error", error: err instanceof Error ? err.message : "Failed to queue." });
      }
    },
    [pollAction, updateAction],
  );

  const dismissAction = useCallback((id: string) => {
    const timer = actionTimers.current.get(id);
    if (timer) {
      clearInterval(timer);
      actionTimers.current.delete(id);
    }
    setActions((list) => list.filter((a) => a.id !== id));
  }, []);

  const upscaleReason = !caps ? "Checking what ComfyUI has installed…" : !caps.online ? "ComfyUI is offline." : caps.upscaleModels.length === 0 ? 'No upscale model installed — add an ESRGAN file to ComfyUI\'s "upscale_models" folder.' : null;
  const rmbgReason = !caps
    ? "Checking what ComfyUI has installed…"
    : !caps.online
      ? "ComfyUI is offline."
      : !caps.removeBackground.node
        ? "Requires the BiRefNet custom node (RemoveBackground) in ComfyUI."
        : caps.removeBackground.models.length === 0
          ? 'No BiRefNet model installed — add birefnet.safetensors to ComfyUI\'s "background_removal" folder.'
          : null;
  const actionMode = sidecarInfo?.mode && sidecarInfo.mode !== "txt2img" && sidecarInfo.mode !== "img2img" ? sidecarInfo.mode : null;
  const recreateReason =
    selectedRef && selectedRef in sidecarByRef
      ? !hasSidecar
        ? "This image has no render settings sidecar."
        : actionMode
          ? `This image came from ${actionMode === "rmbg" ? "a background removal" : `an ${actionMode}`} action, which Recreate cannot rerun.`
          : null
      : "Checking for this image's render settings…";
  // Mask edits rebuild the model settings from the sidecar, whatever mode wrote it.
  const maskEditReason = !caps
    ? "Checking what ComfyUI has installed…"
    : !caps.online
      ? "ComfyUI is offline."
      : selectedRef && selectedRef in sidecarByRef
        ? hasSidecar
          ? null
          : "This image has no render settings sidecar, so the model to edit with is unknown."
        : "Checking for this image's render settings…";

  // ---------- mask edits (inpaint / outpaint) ----------
  const [maskEditor, setMaskEditor] = useState<"inpaint" | "outpaint" | null>(null);
  const [maskBusy, setMaskBusy] = useState(false);

  const failAction = useCallback((label: string, message: string) => {
    setActions((list) => [...list, { id: `pending-${crypto.randomUUID()}`, label, state: "error", error: message }]);
  }, []);

  const submitInpaint = useCallback(
    async (s: InpaintSubmission) => {
      if (!selectedRef) return;
      setMaskBusy(true);
      try {
        const form = new FormData();
        form.append("files", new File([s.mask], "inpaint-mask.png", { type: "image/png" }));
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const data = (await res.json()) as { files?: { ref: string }[]; error?: string };
        const mask = data.files?.[0]?.ref;
        if (!res.ok || !mask) throw new Error(data.error ?? "Uploading the mask failed.");
        setMaskEditor(null);
        await runAction("Inpaint", { mode: "inpaint", image: selectedRef, mask, prompt: s.prompt, denoise: s.denoise });
      } catch (err) {
        setMaskEditor(null);
        failAction("Inpaint", err instanceof Error ? err.message : "Uploading the mask failed.");
      } finally {
        setMaskBusy(false);
      }
    },
    [selectedRef, runAction, failAction],
  );

  const submitOutpaint = useCallback(
    async (s: OutpaintSubmission) => {
      if (!selectedRef) return;
      setMaskBusy(true);
      try {
        setMaskEditor(null);
        await runAction("Outpaint", { mode: "outpaint", image: selectedRef, prompt: s.prompt, left: s.left, top: s.top, right: s.right, bottom: s.bottom, feathering: s.feathering });
      } finally {
        setMaskBusy(false);
      }
    },
    [selectedRef, runAction],
  );

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
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[22px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
          <p className="truncate font-mono text-[11.5px] tracking-[0.02em] text-ink-muted" title={selectedJob?.prompt}>
            {activeJob ? "Rendering…" : selectedJob ? `${selectedJob.settings.model} · ${selectedJob.settings.width}×${selectedJob.settings.height} · seed ${selectedJob.seed}` : selected ? selected.filename : "Nothing here yet"}
          </p>
        </div>
        {selected && !activeJob ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(recreateReason)}
              title={recreateReason ?? "Render this image again with the exact same settings and seed"}
              onClick={() => void runAction("Recreate", { fromSidecar: selectedRef })}
            >
              <RefreshCw className="size-3.5" /> Recreate
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(recreateReason)}
              title={recreateReason ?? "Render a variation: same settings, new random seed"}
              onClick={() => void runAction("Vary", { fromSidecar: selectedRef, vary: true })}
            >
              <Shuffle className="size-3.5" /> Vary
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(maskEditReason)}
              title={maskEditReason ?? "Paint over an area and describe what should replace it"}
              onClick={() => setMaskEditor("inpaint")}
            >
              <Brush className="size-3.5" /> Inpaint
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(maskEditReason)}
              title={maskEditReason ?? "Extend the image beyond its edges"}
              onClick={() => setMaskEditor("outpaint")}
            >
              <UnfoldHorizontal className="size-3.5" /> Outpaint
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(upscaleReason)}
              title={upscaleReason ?? `Upscale with ${caps?.upscaleModels[0]}`}
              onClick={() => void runAction("Upscale 4×", { mode: "upscale", image: selectedRef })}
            >
              <ZoomIn className="size-3.5" /> Upscale 4×
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={Boolean(rmbgReason)}
              title={rmbgReason ?? "Remove the background with BiRefNet"}
              onClick={() => void runAction("Remove background", { mode: "rmbg", image: selectedRef })}
            >
              <Eraser className="size-3.5" /> Remove BG
            </button>
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

      {actions.length > 0 ? (
        <div className="card flex flex-col gap-2 p-3">
          {actions.map((a) => (
            <div key={a.id} className="flex items-center gap-3 text-[12.5px]">
              <span className={`size-1.5 shrink-0 rounded-full ${a.state === "error" ? "bg-danger" : a.state === "done" ? "bg-line-strong" : "bg-terracotta pulse"}`} />
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                <span className="font-medium text-ink">{a.label}</span>
                {a.state === "error" ? <span className="text-danger"> — {a.error}</span> : a.state === "done" ? " — done" : a.state === "running" ? " — working…" : " — queued"}
              </span>
              {a.state === "queued" || a.state === "running" ? (
                <button
                  type="button"
                  className="btn-quiet h-6 shrink-0 px-1.5 hover:border-danger/40 hover:text-danger"
                  aria-label={`Cancel ${a.label}`}
                  title="Cancel"
                  onClick={() => {
                    if (!a.id.startsWith("pending-")) void fetch(`/api/jobs/${a.id}`, { method: "DELETE" }).catch(() => undefined);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              ) : (
                <button type="button" className="btn-quiet h-6 shrink-0 px-1.5" aria-label="Dismiss" title="Dismiss" onClick={() => dismissAction(a.id)}>
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {queue.length > 1 || (queue.length === 1 && queue[0].job.id !== activeJob?.id) ? <RunQueue queue={queue} progress={progress} /> : null}

      {items.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-faint">Earlier renders</span>
          <ToggleGroup type="single" value={filter} onValueChange={(v) => v && onFilter(v as "session" | "all")} spacing={0} className="shrink-0 rounded-full bg-pill p-[3px]" aria-label="Filmstrip filter">
            <ToggleGroupItem value="session" className="h-6 rounded-full! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
              This session
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="h-6 rounded-full! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
              Everything <span className="text-faint">{mergedGallery.length}</span>
            </ToggleGroupItem>
          </ToggleGroup>
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

      {maskEditor === "inpaint" && selected ? <MaskCanvas imageUrl={viewUrl(selected)} imageName={selected.filename} busy={maskBusy} onClose={() => setMaskEditor(null)} onSubmit={(s) => void submitInpaint(s)} /> : null}
      {maskEditor === "outpaint" && selected ? <OutpaintControls imageUrl={viewUrl(selected)} imageName={selected.filename} busy={maskBusy} onClose={() => setMaskEditor(null)} onSubmit={(s) => void submitOutpaint(s)} /> : null}

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
