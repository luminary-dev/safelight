"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadJSON, loadString } from "@/lib/local-prefs";
import { autoTitle, newProject, newSession, type ChatMessage, type ChatSession, type CodeSession, type DesignSession, type ImageSession, type Project, type Session, type SessionKind } from "@/lib/session-types";
import type { Job } from "@/lib/safelight-state";

const ACTIVE_KEY = "safelight.active.v1";
const PROJECT_KEY = "safelight.project.v1";
const LEGACY_CHAT_KEY = "studio.chat.v1"; // migration shim: pre-rename key, read-only

/**
 * The session store: every session and project, the active id per kind, debounced saves to
 * the server, and the CRUD actions the sidebar uses. Mode-specific behavior stays with the
 * mode hooks; this owns only the shared shape.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeIds, setActiveIds] = useState<Record<SessionKind, string | null>>(() => loadJSON(ACTIVE_KEY, { chat: null, image: null, code: null, design: null }));
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadString(PROJECT_KEY, "") || null);
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
      setSessions((list) =>
        list.map((s) => {
          if (s.kind !== "image" || !s.jobs.some((j) => j.id === jobId)) return s;
          return { ...s, jobs: s.jobs.map((j) => (j.id === jobId ? fn(j) : j)), updatedAt: Date.now() };
        }),
      );
      // setSessions may run later in strict mode; schedule saves for any session that could hold the job.
      sessionsRef.current.filter((s) => s.kind === "image" && s.jobs.some((j) => j.id === jobId)).forEach((s) => persist(s.id));
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
  const activeCode = useMemo(
    () => (sessions.find((s) => s.kind === "code" && s.id === activeIds.code && inProject(s)) ?? sessions.find((s) => s.kind === "code" && inProject(s)) ?? null) as CodeSession | null,
    [sessions, activeIds.code, inProject],
  );
  const activeDesign = useMemo(
    () => (sessions.find((s) => s.kind === "design" && s.id === activeIds.design && inProject(s)) ?? sessions.find((s) => s.kind === "design" && inProject(s)) ?? null) as DesignSession | null,
    [sessions, activeIds.design, inProject],
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
    } catch {
      /* ignore */
    }
  }, [activeIds, activeProjectId]);

  // ---------- session actions ----------
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

  const byKind = useMemo(
    () => ({
      chat: sessions.filter((s): s is ChatSession => s.kind === "chat" && inProject(s)),
      image: sessions.filter((s): s is ImageSession => s.kind === "image" && inProject(s)),
      code: sessions.filter((s): s is CodeSession => s.kind === "code" && inProject(s)),
      design: sessions.filter((s): s is DesignSession => s.kind === "design" && inProject(s)),
    }),
    [sessions, inProject],
  );

  return {
    sessions,
    sessionsRef,
    sessionsLoaded,
    setSessions,
    activeIds,
    setActiveIds,
    projects,
    activeProjectId,
    setActiveProjectId,
    byKind,
    activeChat,
    activeImage,
    activeCode,
    activeDesign,
    persist,
    updateSession,
    updateJob,
    inProject,
    createSession,
    ensureSession,
    renameSession,
    moveSession,
    createProject,
    renameProject,
    removeProject,
  };
}

export type SessionsApi = ReturnType<typeof useSessions>;
