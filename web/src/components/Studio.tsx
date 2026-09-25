"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComfySocket } from "@/hooks/useComfySocket";
import { teCompatible, type GalleryItem, type JobOutput, type JobStatus, type ModelCatalog, type ModelEntry } from "@/lib/comfy/types";
import { randomSeed } from "@/lib/presets";
import { autoTitle, newProject, newSession, type ChatAttachment, type ChatMessage, type ChatSession, type ImageSession, type Project, type Session, type SessionKind } from "@/lib/session-types";
import { DEFAULT_SETTINGS, defaultsForModel, toRequest, viewUrl, type Job, type Settings, type UploadedImage } from "@/lib/studio-state";
import { chatModelKey, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { ChatWorkspace } from "./ChatWorkspace";
import { Composer } from "./Composer";
import type { SystemRow, Tone, TopMode } from "./Header";
import type { KeyStatus } from "./KeysDialog";
import { KeysDialog } from "./KeysDialog";
import { Library } from "./Library";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";

const WS_URL = process.env.NEXT_PUBLIC_COMFY_WS ?? "ws://127.0.0.1:8188";
const SETTINGS_KEY = "studio.settings.v2";
const CHAT_MODEL_KEY = "studio.chatModel.v1";
const ACTIVE_KEY = "studio.active.v1";
const PROJECT_KEY = "studio.project.v1";
const RAIL_KEY = "studio.rail.v1";
const LEGACY_CHAT_KEY = "studio.chat.v1";

/** Restores prompt and sampling preferences. Model and images are re-resolved against the live catalog. */
function loadSavedSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...saved, images: [], model: saved.model ?? null };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadString(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = loadString(key, "");
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function Studio() {
  // Stable per-browser id: ComfyUI only sends progress events to the client id that queued a job,
  // so keeping it across reloads means a refreshed page still sees live progress.
  const [clientId] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("studio.clientId.v1");
      if (saved) return saved;
      const fresh = crypto.randomUUID();
      localStorage.setItem("studio.clientId.v1", fresh);
      return fresh;
    } catch {
      return crypto.randomUUID();
    }
  });
  const [topMode, setTopMode] = useState<TopMode>(() => {
    // ?mode=chat|image deep-links a mode; otherwise the last used mode wins.
    const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("mode");
    const saved = fromUrl ?? loadString("studio.mode.v1", "image");
    return saved === "chat" || saved === "library" ? saved : "image";
  });
  const [online, setOnline] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSavedSettings);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [chatModels, setChatModels] = useState<ChatModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState(false);
  const [defaultChatModel, setDefaultChatModel] = useState(() => loadString(CHAT_MODEL_KEY, ""));
  const [keysOpen, setKeysOpen] = useState(false);
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null);
  const progress = useComfySocket(clientId, WS_URL);

  // ---------- sessions ----------
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeIds, setActiveIds] = useState<Record<SessionKind, string | null>>(() => loadJSON(ACTIVE_KEY, { chat: null, image: null }));
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadString(PROJECT_KEY, "") || null);
  const [wallFilter, setWallFilter] = useState<"session" | "all">(() => (loadString(RAIL_KEY, "all") === "session" ? "session" : "all"));
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const persist = useCallback((id: string, immediate = false) => {
    const fire = () => {
      saveTimers.current.delete(id);
      const s = sessionsRef.current.find((x) => x.id === id);
      if (!s) return;
      void fetch(`/api/sessions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }).catch(() => undefined);
    };
    const existing = saveTimers.current.get(id);
    if (existing) clearTimeout(existing);
    if (immediate) fire();
    else saveTimers.current.set(id, setTimeout(fire, 600));
  }, []);

  const updateSession = useCallback(
    <T extends Session>(id: string, fn: (s: T) => T) => {
      setSessions((list) => list.map((s) => (s.id === id ? { ...fn(s as T), updatedAt: Date.now() } : s)));
      persist(id);
    },
    [persist],
  );

  /** Updates every job with this id wherever it lives, so background polls reach jobs in non-active sessions. */
  const updateJob = useCallback(
    (jobId: string, fn: (j: Job) => Job) => {
      const touched: string[] = [];
      setSessions((list) =>
        list.map((s) => {
          if (s.kind !== "image" || !s.jobs.some((j) => j.id === jobId)) return s;
          touched.push(s.id);
          return { ...s, jobs: s.jobs.map((j) => (j.id === jobId ? fn(j) : j)), updatedAt: Date.now() };
        }),
      );
      // setSessions may run later in strict mode; schedule saves for any session that could hold the job.
      sessionsRef.current.filter((s) => s.kind === "image" && s.jobs.some((j) => j.id === jobId)).forEach((s) => persist(s.id));
      void touched;
    },
    [persist],
  );

  /** Whether a session belongs to the active project scope; All projects (null) shows everything. */
  const inProject = useCallback((s: Session) => activeProjectId === null || s.projectId === activeProjectId, [activeProjectId]);

  const createSession = useCallback(
    (kind: SessionKind, seed?: Partial<Session>): Session => {
      const s = { ...newSession(kind), ...(activeProjectId ? { projectId: activeProjectId } : {}), ...seed } as Session;
      setSessions((list) => [s, ...list]);
      setActiveIds((a) => ({ ...a, [kind]: s.id }));
      void fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }).catch(() => undefined);
      return s;
    },
    [activeProjectId],
  );

  /** Returns the active session of a kind within the current project, creating one on first use. */
  const ensureSession = useCallback(
    (kind: SessionKind): Session => {
      const current =
        sessionsRef.current.find((s) => s.kind === kind && s.id === activeIds[kind] && inProject(s)) ?? sessionsRef.current.find((s) => s.kind === kind && inProject(s));
      if (current) {
        if (current.id !== activeIds[kind]) setActiveIds((a) => ({ ...a, [kind]: current.id }));
        return current;
      }
      const created = createSession(kind);
      sessionsRef.current = [created, ...sessionsRef.current];
      return created;
    },
    [activeIds, createSession, inProject],
  );

  const activeChat = useMemo(
    () => (sessions.find((s) => s.kind === "chat" && s.id === activeIds.chat && inProject(s)) ?? sessions.find((s) => s.kind === "chat" && inProject(s)) ?? null) as ChatSession | null,
    [sessions, activeIds.chat, inProject],
  );
  const activeImage = useMemo(
    () => (sessions.find((s) => s.kind === "image" && s.id === activeIds.image && inProject(s)) ?? sessions.find((s) => s.kind === "image" && inProject(s)) ?? null) as ImageSession | null,
    [sessions, activeIds.image, inProject],
  );

  // Load sessions once; migrate the old single chat from localStorage if present.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/sessions").catch(() => null);
      if (cancelled) return;
      let list: Session[] = [];
      if (res?.ok) {
        const body = (await res.json()) as { sessions: Session[]; projects?: Project[] };
        list = body.sessions;
        setProjects(body.projects ?? []);
      }
      const legacy = loadJSON<ChatMessage[]>(LEGACY_CHAT_KEY, []);
      if (legacy.length && !list.some((s) => s.kind === "chat")) {
        const first = legacy.find((m) => m.role === "user")?.text ?? "";
        const migrated: ChatSession = { ...(newSession("chat") as ChatSession), messages: legacy, title: autoTitle(first, "Earlier chat") };
        list = [migrated, ...list];
        void fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(migrated) }).catch(() => undefined);
        try {
          localStorage.removeItem(LEGACY_CHAT_KEY);
        } catch {
          /* ignore */
        }
      }
      setSessions(list);
      setSessionsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeIds));
      localStorage.setItem(PROJECT_KEY, activeProjectId ?? "");
      localStorage.setItem(RAIL_KEY, wallFilter);
    } catch {
      /* ignore */
    }
  }, [activeIds, activeProjectId, wallFilter]);

  useEffect(() => {
    try {
      const { images, ...rest } = settings;
      void images;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
      localStorage.setItem("studio.mode.v1", topMode);
      if (defaultChatModel) localStorage.setItem(CHAT_MODEL_KEY, defaultChatModel);
    } catch {
      /* ignore */
    }
  }, [settings, topMode, defaultChatModel]);

  // ---------- backends ----------
  const loadCatalog = useCallback(async () => {
    const res = await fetch("/api/models").catch(() => null);
    setLastHealthAt(Date.now());
    if (!res || !res.ok) {
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setCatalogError(body.error ?? "The studio server did not answer.");
      setOnline(false);
      return;
    }
    const data = (await res.json()) as ModelCatalog;
    setOnline(data.online);
    setCatalogError(data.online ? null : "ComfyUI is not running.");
    setCatalog(data);
    setSettings((s) => {
      const stillThere = s.model && data.models.find((m) => m.name === s.model!.name && m.folder === s.model!.folder);
      if (stillThere) {
        // Re-derive companions when the model's family changed under us or a chosen file left
        // the catalog, so a stale text encoder is never sent to a model it does not match.
        const stale =
          stillThere.family !== s.model!.family ||
          s.textEncoders.some((t) => !data.textEncoders.includes(t) || !teCompatible(stillThere.family, t)) ||
          (s.vae !== "" && !data.vaes.includes(s.vae)) ||
          (s.lora !== "" && !data.loras.includes(s.lora));
        return stale ? { ...s, model: stillThere, ...defaultsForModel(stillThere, data) } : { ...s, model: stillThere };
      }
      const first = data.models[0];
      return first ? { ...s, model: first, ...defaultsForModel(first, data) } : { ...s, model: null };
    });
  }, []);

  const loadGallery = useCallback(async () => {
    const res = await fetch("/api/gallery").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { items: GalleryItem[] };
    setGallery(data.items);
  }, []);

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/keys").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { keys: KeyStatus[] };
    setKeys(data.keys);
  }, []);

  const loadChatModels = useCallback(async () => {
    const res = await fetch("/api/chat/models").catch(() => null);
    if (!res?.ok) {
      setOllamaUp(false);
      return;
    }
    const data = (await res.json()) as { ollamaUp: boolean; models: ChatModelInfo[] };
    setOllamaUp(data.ollamaUp);
    setChatModels(data.models);
    setDefaultChatModel((m) => (m && data.models.some((x) => chatModelKey(x) === m) ? m : data.models[0] ? chatModelKey(data.models[0]) : ""));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadCatalog();
      void loadGallery();
      void loadChatModels();
      void loadKeys();
    }, 0);
    return () => clearTimeout(t);
  }, [loadCatalog, loadGallery, loadChatModels, loadKeys]);

  // Keep the status indicators honest: poll both backends, faster while something is down.
  useEffect(() => {
    const healthy = online && (ollamaUp || chatModels.length > 0);
    const t = setInterval(
      () => {
        void loadCatalog();
        void loadChatModels();
      },
      healthy ? 15000 : 4000,
    );
    return () => clearInterval(t);
  }, [online, ollamaUp, chatModels.length, loadCatalog, loadChatModels]);

  // ---------- image settings ----------
  const update = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((s) => ({ ...s, ...patch }));
      if (patch.prompt !== undefined) {
        const s = sessionsRef.current.find((x) => x.kind === "image" && x.id === activeIds.image) ?? sessionsRef.current.find((x) => x.kind === "image");
        if (s) updateSession<ImageSession>(s.id, (x) => ({ ...x, draft: patch.prompt ?? "" }));
      }
    },
    [activeIds.image, updateSession],
  );

  const selectModel = useCallback(
    (m: ModelEntry) => {
      if (!catalog) return;
      setSettings((s) => ({ ...s, model: m, ...defaultsForModel(m, catalog), images: m.family === "qwen-image" ? s.images : s.images.slice(0, 1) }));
    },
    [catalog],
  );

  const upload = useCallback(async (files: File[]) => {
    setUploading(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as { files?: { ref: string; filename: string; subfolder: string }[]; error?: string };
      if (!res.ok || !data.files) throw new Error(data.error ?? "Upload failed");
      const added: UploadedImage[] = data.files.map((f) => ({
        ref: f.ref,
        filename: f.filename,
        subfolder: f.subfolder,
        previewUrl: viewUrl({ filename: f.filename, subfolder: f.subfolder, type: "input" }),
      }));
      setSettings((s) => ({ ...s, images: [...s.images, ...added] }));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const useAsInput = useCallback((o: JobOutput) => {
    const path = o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
    const ref = o.type === "input" ? path : `${path} [output]`;
    setTopMode("image");
    setSettings((s) => ({ ...s, mode: "img2img", images: [{ ref, filename: o.filename, subfolder: o.subfolder, previewUrl: viewUrl(o) }] }));
    window.scrollTo({ top: 0 });
  }, []);

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
      const holders = sessionsRef.current.filter((s) => s.kind === "image" && s.jobs.some((j) => j.outputs.some(same)));
      setSessions((list) => list.map((s) => (s.kind === "image" ? { ...s, jobs: s.jobs.map((j) => ({ ...j, outputs: j.outputs.filter((x) => !same(x)) })) } : s)));
      holders.forEach((s) => persist(s.id));
      setSettings((s) => ({ ...s, images: s.images.filter((img) => !(same({ filename: img.filename, subfolder: img.subfolder, type: "output" }) && img.ref.endsWith("[output]"))) }));
    },
    [persist],
  );

  const useAsPrompt = useCallback(
    (h: PromptHandoff) => {
      setTopMode("image");
      update({ prompt: h.prompt.trim() });
      if (h.negativePrompt !== undefined) setSettings((s) => ({ ...s, negativePrompt: h.negativePrompt ?? "" }));
      if (h.images?.length) {
        setSettings((s) => ({
          ...s,
          mode: "img2img",
          images: h.images!.map((img) => ({ ref: img.ref, filename: img.filename, subfolder: img.subfolder, previewUrl: viewUrl({ filename: img.filename, subfolder: img.subfolder, type: "input" }) })),
        }));
      }
      window.scrollTo({ top: 0 });
    },
    [update],
  );

  /** Uploads for chat attachments; same input folder as Image mode so references work in both. */
  const uploadRefs = useCallback(async (files: File[]): Promise<ChatAttachment[]> => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = (await res.json()) as { files?: { ref: string; filename: string; subfolder: string }[]; error?: string };
    if (!res.ok || !data.files) throw new Error(data.error ?? "Upload failed");
    return data.files.map((f) => ({ ref: f.ref, filename: f.filename, subfolder: f.subfolder }));
  }, []);

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
    for (const s of sessionsRef.current) {
      if (s.kind !== "image") continue;
      for (const j of s.jobs) {
        if ((j.state === "queued" || j.state === "running") && !j.id.startsWith("pending-") && !j.id.startsWith("cloud-") && !pollers.current.has(j.id)) pollJob(j.id);
        if (j.id.startsWith("pending-") && (j.state === "queued" || j.state === "running")) {
          updateJob(j.id, (x) => ({ ...x, state: "error", error: "The page was closed before this render was queued." }));
        }
      }
    }
  }, [sessionsLoaded, pollJob, updateJob]);

  // The websocket announces the moment a prompt finishes, so fetch its result right away.
  useEffect(() => {
    for (const id of progress.finished) {
      const job = sessionsRef.current.flatMap((s) => (s.kind === "image" ? s.jobs : [])).find((j) => j.id === id);
      if (job && (job.state === "queued" || job.state === "running")) {
        fetch(`/api/jobs/${id}`)
          .then((r) => (r.ok ? (r.json() as Promise<JobStatus>) : null))
          .then((s) => s && (s.state === "done" || s.state === "error") && finishJob(s))
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
    if (!active.lockSeed) setSettings((s) => ({ ...s, seed }));
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
    updateSession<ImageSession>(session.id, (s) => ({
      ...s,
      jobs: [job, ...s.jobs].slice(0, 100),
      currentJobId: tempId,
      draft: active.prompt,
      title: s.titled || s.jobs.length > 0 ? s.title : autoTitle(active.prompt, active.mode === "img2img" ? "Image edit" : s.title),
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
        updateSession<ImageSession>(session.id, (s) => ({ ...s, currentJobId: id }));
        void loadGallery();
      } else {
        updateJob(tempId, (j) => ({ ...j, id, nodes }));
        updateSession<ImageSession>(session.id, (s) => ({ ...s, currentJobId: id }));
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
  const refresh = useCallback(() => {
    void loadCatalog();
    void loadGallery();
    void loadChatModels();
    void loadKeys();
  }, [loadCatalog, loadGallery, loadChatModels, loadKeys]);

  const jobs = useMemo(() => activeImage?.jobs ?? [], [activeImage?.jobs]);
  /** Every queued or running render across all image sessions, oldest first — ComfyUI runs them in that order. */
  const renderQueue = useMemo(
    () =>
      sessions
        .flatMap((s) => (s.kind === "image" ? s.jobs.filter((j) => j.state === "queued" || j.state === "running").map((job) => ({ job, sessionTitle: s.title })) : []))
        .sort((a, b) => a.job.startedAt - b.job.startedAt),
    [sessions],
  );

  // ---------- session actions ----------
  const selectSession = useCallback(
    (id: string) => {
      const target = sessionsRef.current.find((s) => s.id === id);
      if (!target) return;
      setActiveIds((a) => ({ ...a, [target.kind]: id }));
      if (target.kind === "image") setSettings((s) => ({ ...s, prompt: (target as ImageSession).draft }));
    },
    [],
  );
  const createAndOpen = useCallback(
    (kind: SessionKind) => {
      createSession(kind);
      if (kind === "image") setSettings((s) => ({ ...s, prompt: "" }));
    },
    [createSession],
  );
  const renameSession = useCallback((id: string, title: string) => updateSession(id, (s) => ({ ...s, title, titled: true })), [updateSession]);
  /** Files a session into a project; null unfiles it (explicit null so the server clears it). */
  const moveSession = useCallback((id: string, projectId: string | null) => updateSession(id, (s) => ({ ...s, projectId })), [updateSession]);

  // ---------- project actions ----------
  const createProject = useCallback(() => {
    const p = newProject("New project");
    setProjects((list) => [p, ...list]);
    setActiveProjectId(p.id);
    void fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).catch(() => undefined);
  }, []);
  const renameProject = useCallback((id: string, title: string) => {
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, title, updatedAt: Date.now() } : p)));
    void fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }).catch(() => undefined);
  }, []);
  const removeProject = useCallback(
    (id: string) => {
      setProjects((list) => list.filter((p) => p.id !== id));
      // Match the server: the project's sessions are kept and become unfiled.
      setSessions((list) => list.map((s) => (s.projectId === id ? { ...s, projectId: undefined } : s)));
      if (activeProjectId === id) setActiveProjectId(null);
      void fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => undefined);
    },
    [activeProjectId],
  );
  const removeSession = useCallback(
    (id: string) => {
      const target = sessionsRef.current.find((s) => s.id === id);
      setSessions((list) => list.filter((s) => s.id !== id));
      void fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
      if (target && activeIds[target.kind] === id) {
        const next = sessionsRef.current.find((s) => s.kind === target.kind && s.id !== id);
        setActiveIds((a) => ({ ...a, [target.kind]: next?.id ?? null }));
        if (target.kind === "image") setSettings((s) => ({ ...s, prompt: next ? (next as ImageSession).draft : "" }));
      }
    },
    [activeIds],
  );

  // Chat wiring: messages live in the active chat session.
  const chatModel = activeChat?.model && chatModels.some((m) => chatModelKey(m) === activeChat.model) ? activeChat.model : defaultChatModel;
  const setChatModel = useCallback(
    (key: string) => {
      setDefaultChatModel(key);
      const s = ensureSession("chat");
      updateSession<ChatSession>(s.id, (x) => ({ ...x, model: key }));
    },
    [ensureSession, updateSession],
  );
  const setAgent = useCallback(
    (on: boolean) => {
      const s = ensureSession("chat");
      updateSession<ChatSession>(s.id, (x) => ({ ...x, agent: on }));
    },
    [ensureSession, updateSession],
  );
  const preferredImageModel = settings.model ? `${settings.model.folder}:${settings.model.name}` : undefined;
  const onMessages = useCallback(
    (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      const s = ensureSession("chat");
      updateSession<ChatSession>(s.id, (x) => {
        const messages = fn(x.messages);
        const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
        return { ...x, messages, title: x.titled ? x.title : autoTitle(firstUser, x.title) };
      });
    },
    [ensureSession, updateSession],
  );

  // ---------- status ----------
  const checking = lastHealthAt === null;
  const localChatCount = chatModels.filter((m) => m.provider === "ollama").length;
  const localImageCount = catalog?.models.filter((m) => m.folder !== "cloud").length ?? 0;
  const keyFor = (p: string) => keys.find((k) => k.provider === p);
  const cloudRow = (p: "openai" | "anthropic" | "gemini", label: string): SystemRow => {
    const k = keyFor(p);
    const err = catalog?.cloudErrors?.[p];
    const chatN = chatModels.filter((m) => m.provider === p).length;
    const imgN = catalog?.models.filter((m) => m.provider === p).length ?? 0;
    if (!k?.configured) return { id: p, label, detail: "No key", tone: "off", action: { label: "Add key", onClick: () => setKeysOpen(true) } };
    if (err) return { id: p, label, detail: err.replace(/^\d+\s*/, "").slice(0, 60), tone: "down", action: { label: "Fix key", onClick: () => setKeysOpen(true) } };
    const parts = [chatN ? `${chatN} chat` : null, imgN ? `${imgN} image` : null].filter(Boolean);
    return { id: p, label, detail: `${parts.join(" · ") || "connected"} · key ${k.hint ?? ""}`.trim(), tone: "ok" };
  };
  const systems: SystemRow[] = checking
    ? [
        { id: "comfy", label: "ComfyUI", detail: "Checking…", tone: "checking" },
        { id: "ollama", label: "Ollama", detail: "Checking…", tone: "checking" },
      ]
    : [
        online
          ? progress.connected
            ? { id: "comfy", label: "ComfyUI", detail: `${localImageCount} local model${localImageCount === 1 ? "" : "s"} · live progress on`, tone: "ok" }
            : { id: "comfy", label: "ComfyUI", detail: "Up · live progress reconnecting", tone: "warn" }
          : { id: "comfy", label: "ComfyUI", detail: "Offline · run pnpm comfy", tone: "down" },
        ollamaUp
          ? localChatCount
            ? { id: "ollama", label: "Ollama", detail: `${localChatCount} local chat model${localChatCount === 1 ? "" : "s"}`, tone: "ok" }
            : { id: "ollama", label: "Ollama", detail: "Up · no models pulled", tone: "warn" }
          : { id: "ollama", label: "Ollama", detail: "Offline · run ollama serve", tone: "down" },
        cloudRow("openai", "OpenAI"),
        cloudRow("anthropic", "Anthropic"),
        cloudRow("gemini", "Gemini"),
      ];
  const relevant = topMode === "image" ? ["comfy", "openai", "gemini"] : ["ollama", "openai", "anthropic", "gemini"];
  const relevantRows = systems.filter((r) => relevant.includes(r.id));
  const overall: { tone: Tone; label: string } = checking
    ? { tone: "checking", label: "Checking" }
    : relevantRows.some((r) => r.tone === "ok") && relevantRows.every((r) => r.tone === "ok" || r.tone === "off")
      ? { tone: "ok", label: topMode === "image" ? (online ? "Ready to render" : "Cloud ready") : "Ready to chat" }
      : relevantRows.some((r) => r.tone === "ok")
        ? { tone: "warn", label: "Partly ready" }
        : { tone: "down", label: topMode === "image" ? "Nothing to render with" : "Nothing to chat with" };

  void catalogError;
  const imageSessions = sessions.filter((s): s is ImageSession => s.kind === "image" && inProject(s));
  const chatSessions = sessions.filter((s): s is ChatSession => s.kind === "chat" && inProject(s));

  return (
    <div className="grid min-h-[100dvh] grid-cols-1 gap-3.5 bg-shell p-3.5 font-sans lg:h-[100dvh] lg:grid-cols-[268px_minmax(0,1fr)]">
      <KeysDialog open={keysOpen} onClose={() => setKeysOpen(false)} onChanged={refresh} />

      <Sidebar
        mode={topMode}
        onMode={setTopMode}
        galleryCount={gallery.length}
        chatSessions={chatSessions}
        imageSessions={imageSessions}
        activeChatId={activeChat?.id ?? null}
        activeImageId={activeImage?.id ?? null}
        onSelectSession={selectSession}
        onCreateSession={createAndOpen}
        onRenameSession={renameSession}
        onDeleteSession={removeSession}
        onMoveSession={moveSession}
        projects={projects}
        sessions={sessions}
        activeProjectId={activeProjectId}
        onSelectProject={setActiveProjectId}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={removeProject}
        overall={overall}
        systems={systems}
        queueCount={renderQueue.length}
        onRefresh={refresh}
        onKeys={() => setKeysOpen(true)}
      />

      <main className="panel flex min-h-0 flex-col overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={topMode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="flex min-h-0 flex-1 flex-col">
        {topMode === "chat" ? (
          <ChatWorkspace
            active={activeChat}
            onCreateSession={() => createAndOpen("chat")}
            models={chatModels}
            ollamaUp={ollamaUp}
            model={chatModel}
            onModel={setChatModel}
            agent={Boolean(activeChat?.agent)}
            onAgent={setAgent}
            messages={activeChat?.messages ?? []}
            onMessages={onMessages}
            onUseAsPrompt={useAsPrompt}
            onUseAsInput={useAsInput}
            onOpenKeys={() => setKeysOpen(true)}
            preferredModel={preferredImageModel}
            clientId={clientId}
            onUpload={uploadRefs}
          />
        ) : topMode === "library" ? (
          <Library gallery={gallery} onUseAsInput={useAsInput} onDelete={deleteOutput} />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[350px_minmax(0,1fr)]">
            <Composer
              catalog={catalog}
              online={online}
              settings={settings}
              onChange={update}
              onSelectModel={selectModel}
              onUpload={upload}
              uploading={uploading}
              canGenerate={canGenerate}
              submitting={submitting}
              error={submitError}
              onGenerate={() => void generate()}
              onOpenKeys={() => setKeysOpen(true)}
            />
            <div className="flex min-h-0 flex-col overflow-y-auto p-5 lg:overflow-hidden">
              <Stage
                title={activeImage?.title ?? "New session"}
                gallery={gallery}
                jobs={jobs}
                progress={progress}
                filter={wallFilter}
                onFilter={setWallFilter}
                onInterrupt={interrupt}
                onUseAsInput={useAsInput}
                onDelete={deleteOutput}
                queue={renderQueue}
              />
            </div>
          </div>
        )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
