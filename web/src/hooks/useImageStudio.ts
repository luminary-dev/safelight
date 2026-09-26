"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useComfySocket } from "@/hooks/useComfySocket";
import type { SessionsApi } from "@/hooks/useSessions";
import { teCompatible, type GalleryItem, type JobOutput, type JobStatus, type ModelCatalog, type ModelEntry } from "@/lib/comfy/types";
import { loadSavedSettings, loadString } from "@/lib/local-prefs";
import { randomSeed } from "@/lib/presets";
import { autoTitle, type ImageSession } from "@/lib/session-types";
import { defaultsForModel, toRequest, viewUrl, type Job, type Settings, type UploadedImage } from "@/lib/safelight-state";
import type { PromptHandoff } from "@/components/ChatMode";

const SETTINGS_KEY = "safelight.settings.v2";
const RAIL_KEY = "safelight.rail.v1";

/** Uploads files to the shared input folder; used by chat/code/design attachments too. */
export async function uploadRefFiles(files: File[]): Promise<{ ref: string; filename: string; subfolder: string }[]> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = (await res.json()) as { files?: { ref: string; filename: string; subfolder: string }[]; error?: string };
  if (!res.ok || !data.files) throw new Error(data.error ?? "Upload failed");
  return data.files;
}

/**
 * Everything Image mode owns: render settings, the model catalog, the gallery, job polling,
 * and the generate pipeline. Session mutations go through the shared sessions store.
 */
export function useImageStudio({ clientId, progress, s, setTopMode }: { clientId: string; progress: ReturnType<typeof useComfySocket>; s: SessionsApi; setTopMode: (m: "image") => void }) {
  const [online, setOnline] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSavedSettings(SETTINGS_KEY));
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null);
  const [wallFilter, setWallFilter] = useState<"session" | "all">(() => (loadString(RAIL_KEY, "all") === "session" ? "session" : "all"));

  const { sessionsRef, sessionsLoaded, activeIds, activeImage, updateSession, updateJob, ensureSession, persist, setSessions } = s;

  useEffect(() => {
    try {
      const { images, ...rest } = settings;
      void images;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
      localStorage.setItem(RAIL_KEY, wallFilter);
    } catch {
      /* ignore */
    }
  }, [settings, wallFilter]);

  // ---------- backends ----------
  const loadCatalog = useCallback(async () => {
    const res = await fetch("/api/models").catch(() => null);
    setLastHealthAt(Date.now());
    if (!res || !res.ok) {
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setCatalogError(body.error ?? "The Safelight server did not answer.");
      setOnline(false);
      return;
    }
    const data = (await res.json()) as ModelCatalog;
    setOnline(data.online);
    setCatalogError(data.online ? null : "ComfyUI is not running.");
    setCatalog(data);
    setSettings((prev) => {
      const stillThere = prev.model && data.models.find((m) => m.name === prev.model!.name && m.folder === prev.model!.folder);
      if (stillThere) {
        // Re-derive companions when the model's family changed under us or a chosen file left
        // the catalog, so a stale text encoder is never sent to a model it does not match.
        const stale =
          stillThere.family !== prev.model!.family ||
          prev.textEncoders.some((t) => !data.textEncoders.includes(t) || !teCompatible(stillThere.family, t)) ||
          (prev.vae !== "" && !data.vaes.includes(prev.vae)) ||
          (prev.lora !== "" && !data.loras.includes(prev.lora));
        return stale ? { ...prev, model: stillThere, ...defaultsForModel(stillThere, data) } : { ...prev, model: stillThere };
      }
      const first = data.models[0];
      return first ? { ...prev, model: first, ...defaultsForModel(first, data) } : { ...prev, model: null };
    });
  }, []);

  const loadGallery = useCallback(async () => {
    const res = await fetch("/api/gallery").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { items: GalleryItem[] };
    setGallery(data.items);
  }, []);

  // ---------- image settings ----------
  const update = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((prev) => ({ ...prev, ...patch }));
      if (patch.prompt !== undefined) {
        const target = sessionsRef.current.find((x) => x.kind === "image" && x.id === activeIds.image) ?? sessionsRef.current.find((x) => x.kind === "image");
        if (target) updateSession<ImageSession>(target.id, (x) => ({ ...x, draft: patch.prompt ?? "" }));
      }
    },
    [activeIds.image, updateSession, sessionsRef],
  );

  const selectModel = useCallback(
    (m: ModelEntry) => {
      if (!catalog) return;
      setSettings((prev) => ({ ...prev, model: m, ...defaultsForModel(m, catalog), images: m.family === "qwen-image" ? prev.images : prev.images.slice(0, 1) }));
    },
    [catalog],
  );

  const upload = useCallback(async (files: File[]) => {
    setUploading(true);
    try {
      const uploaded = await uploadRefFiles(files);
      const added: UploadedImage[] = uploaded.map((f) => ({
        ref: f.ref,
        filename: f.filename,
        subfolder: f.subfolder,
        previewUrl: viewUrl({ filename: f.filename, subfolder: f.subfolder, type: "input" }),
      }));
      setSettings((prev) => ({ ...prev, images: [...prev.images, ...added] }));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const useAsInput = useCallback(
    (o: JobOutput) => {
      const path = o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
      const ref = o.type === "input" ? path : `${path} [output]`;
      setTopMode("image");
      setSettings((prev) => ({ ...prev, mode: "img2img", images: [{ ref, filename: o.filename, subfolder: o.subfolder, previewUrl: viewUrl(o) }] }));
      window.scrollTo({ top: 0 });
    },
    [setTopMode],
  );

  const deleteOutput = useCallback(
    async (o: JobOutput) => {
      const res = await fetch("/api/gallery", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: o.filename, subfolder: o.subfolder }),
      }).catch(() => null);
      if (!res || (!res.ok && res.status !== 404)) {
        const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
        setSubmitError(body.error ?? "Could not delete the image.");
        return;
      }
      const same = (x: JobOutput) => x.filename === o.filename && x.subfolder === o.subfolder;
      setGallery((list) => list.filter((g) => !same(g)));
      const holders = sessionsRef.current.filter((x) => x.kind === "image" && x.jobs.some((j) => j.outputs.some(same)));
      setSessions((list) => list.map((x) => (x.kind === "image" ? { ...x, jobs: x.jobs.map((j) => ({ ...j, outputs: j.outputs.filter((y) => !same(y)) })) } : x)));
      holders.forEach((h) => persist(h.id));
      setSettings((prev) => ({ ...prev, images: prev.images.filter((img) => !(same({ filename: img.filename, subfolder: img.subfolder, type: "output" }) && img.ref.endsWith("[output]"))) }));
    },
    [persist, setSessions, sessionsRef],
  );

  const useAsPrompt = useCallback(
    (h: PromptHandoff) => {
      setTopMode("image");
      update({ prompt: h.prompt.trim() });
      if (h.negativePrompt !== undefined) setSettings((prev) => ({ ...prev, negativePrompt: h.negativePrompt ?? "" }));
      if (h.images?.length) {
        setSettings((prev) => ({
          ...prev,
          mode: "img2img",
          images: h.images!.map((img) => ({ ref: img.ref, filename: img.filename, subfolder: img.subfolder, previewUrl: viewUrl({ filename: img.filename, subfolder: img.subfolder, type: "input" }) })),
        }));
      }
      window.scrollTo({ top: 0 });
    },
    [update, setTopMode],
  );

  // ---------- jobs ----------
  const pollers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const finishJob = useCallback(
    (status: JobStatus) => {
      updateJob(status.id, (j) => ({ ...j, state: status.state, outputs: status.outputs, error: status.error }));
      const t = pollers.current.get(status.id);
      if (t) {
        clearInterval(t);
        pollers.current.delete(status.id);
      }
      void loadGallery();
    },
    [loadGallery, updateJob],
  );

  const pollJob = useCallback(
    (id: string) => {
      const tick = async () => {
        const res = await fetch(`/api/jobs/${id}`).catch(() => null);
        if (!res?.ok) return;
        const status = (await res.json()) as JobStatus;
        if (status.state === "done" || status.state === "error") finishJob(status);
        else updateJob(id, (j) => ({ ...j, state: status.state }));
      };
      void tick();
      pollers.current.set(id, setInterval(tick, 1500));
    },
    [finishJob, updateJob],
  );

  // Resume polling for jobs that were still running when the page was last closed.
  useEffect(() => {
    if (!sessionsLoaded) return;
    for (const sess of sessionsRef.current) {
      if (sess.kind !== "image") continue;
      for (const j of sess.jobs) {
        if ((j.state === "queued" || j.state === "running") && !j.id.startsWith("pending-") && !j.id.startsWith("cloud-") && !pollers.current.has(j.id)) pollJob(j.id);
        if (j.id.startsWith("pending-") && (j.state === "queued" || j.state === "running")) {
          updateJob(j.id, (x) => ({ ...x, state: "error", error: "The page was closed before this render was queued." }));
        }
      }
    }
  }, [sessionsLoaded, pollJob, updateJob, sessionsRef]);

  // The websocket announces the moment a prompt finishes, so fetch its result right away.
  useEffect(() => {
    for (const id of progress.finished) {
      const job = sessionsRef.current.flatMap((x) => (x.kind === "image" ? x.jobs : [])).find((j) => j.id === id);
      if (job && (job.state === "queued" || job.state === "running")) {
        fetch(`/api/jobs/${id}`)
          .then((r) => (r.ok ? (r.json() as Promise<JobStatus>) : null))
          .then((st) => st && (st.state === "done" || st.state === "error") && finishJob(st))
          .catch(() => undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.finished]);

  useEffect(() => () => pollers.current.forEach((t) => clearInterval(t)), []);

  const isCloudModel = settings.model?.folder === "cloud";
  const canGenerate =
    Boolean(catalog && settings.model && (isCloudModel || online)) &&
    (settings.mode === "txt2img" || isCloudModel ? settings.prompt.trim().length > 0 : settings.images.length > 0) &&
    (settings.mode === "txt2img" || settings.images.length > 0 || !isCloudModel) &&
    !submitting;

  const generate = useCallback(async () => {
    if (!settings.model) return;
    // An incompatible text encoder can never render; snap companions back to the model's defaults and continue.
    let active = settings;
    if (catalog && settings.textEncoders.some((t) => !teCompatible(settings.model!.family, t))) {
      active = { ...settings, ...defaultsForModel(settings.model, catalog) };
      setSettings(active);
    }
    setSubmitError(null);
    setSubmitting(true);
    const seed = active.lockSeed ? active.seed : randomSeed();
    if (!active.lockSeed) setSettings((prev) => ({ ...prev, seed }));
    const cloud = active.model!.folder === "cloud";
    const tempId = `pending-${crypto.randomUUID()}`;
    const job: Job = {
      id: tempId,
      seed,
      prompt: active.prompt,
      startedAt: Date.now(),
      state: cloud ? "running" : "queued",
      outputs: [],
      settings: {
        model: active.model!.label,
        width: active.width,
        height: active.height,
        steps: active.steps,
        cfg: active.cfg,
        sampler: active.sampler,
        scheduler: active.scheduler,
        mode: active.mode,
      },
    };
    const session = ensureSession("image");
    updateSession<ImageSession>(session.id, (x) => ({
      ...x,
      jobs: [job, ...x.jobs].slice(0, 100),
      currentJobId: tempId,
      draft: active.prompt,
      title: x.titled || x.jobs.length > 0 ? x.title : autoTitle(active.prompt, active.mode === "img2img" ? "Image edit" : x.title),
    }));
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...toRequest(active, seed), clientId }),
      });
      const data = (await res.json()) as { id?: string; error?: string; outputs?: JobOutput[]; state?: string; graph?: Record<string, { class_type: string }> };
      if (!res.ok || !data.id) throw new Error(data.error ?? "Failed to queue");
      const id = data.id;
      // Keep the graph's node id → class_type map so live progress can name the stage.
      const nodes = data.graph ? Object.fromEntries(Object.entries(data.graph).map(([nid, n]) => [nid, n.class_type])) : undefined;
      if (data.state === "done" && data.outputs) {
        updateJob(tempId, (j) => ({ ...j, id, state: "done", outputs: data.outputs! }));
        updateSession<ImageSession>(session.id, (x) => ({ ...x, currentJobId: id }));
        void loadGallery();
      } else {
        updateJob(tempId, (j) => ({ ...j, id, nodes }));
        updateSession<ImageSession>(session.id, (x) => ({ ...x, currentJobId: id }));
        pollJob(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue";
      updateJob(tempId, (j) => ({ ...j, state: "error", error: message }));
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }, [settings, catalog, clientId, pollJob, loadGallery, ensureSession, updateSession, updateJob]);

  const interrupt = useCallback(() => void fetch("/api/interrupt", { method: "POST" }), []);

  const jobs = useMemo(() => activeImage?.jobs ?? [], [activeImage?.jobs]);
  /** Every queued or running render across all image sessions, oldest first — ComfyUI runs them in that order. */
  const renderQueue = useMemo(
    () =>
      s.sessions
        .flatMap((x) => (x.kind === "image" ? x.jobs.filter((j) => j.state === "queued" || j.state === "running").map((job) => ({ job, sessionTitle: x.title })) : []))
        .sort((a, b) => a.job.startedAt - b.job.startedAt),
    [s.sessions],
  );

  return {
    online,
    catalog,
    catalogError,
    settings,
    setSettings,
    gallery,
    uploading,
    submitError,
    submitting,
    lastHealthAt,
    wallFilter,
    setWallFilter,
    loadCatalog,
    loadGallery,
    update,
    selectModel,
    upload,
    useAsInput,
    deleteOutput,
    useAsPrompt,
    canGenerate,
    generate,
    interrupt,
    jobs,
    renderQueue,
  };
}
