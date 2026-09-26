"use client";

import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useBackends } from "@/hooks/useBackends";
import { useComfySocket } from "@/hooks/useComfySocket";
import { useImageStudio, uploadRefFiles } from "@/hooks/useImageStudio";
import { useSessions } from "@/hooks/useSessions";
import { loadString } from "@/lib/local-prefs";
import { autoTitle, type ChatAttachment, type ChatMessage, type ChatParams, type ChatSession, type CodeSession, type DesignSession, type ImageSession, type SessionKind } from "@/lib/session-types";
import { deriveStatus } from "@/lib/system-status";
import { applyTheme } from "@/lib/theme/apply";
import type { ThemeColors } from "@/lib/theme/contrast";
import { chatModelKey } from "./ChatMode";
import { BlueprintsWorkspace } from "./BlueprintsWorkspace";
import { ChatWorkspace } from "./ChatWorkspace";
import { CodeWorkspace } from "./CodeWorkspace";
import { DesignWorkspace } from "./DesignWorkspace";
import { Composer } from "./Composer";
import type { TopMode } from "./shell";
import { KeysDialog } from "./KeysDialog";
import { Library } from "./Library";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";

const WS_URL = process.env.NEXT_PUBLIC_COMFY_WS ?? "ws://127.0.0.1:8188";

// Memoized at module scope so unrelated state changes (a keystroke in the composer,
// a health poll) stop re-rendering every workspace.
const MSidebar = memo(Sidebar);
const MChatWorkspace = memo(ChatWorkspace);
const MCodeWorkspace = memo(CodeWorkspace);
const MDesignWorkspace = memo(DesignWorkspace);
const MComposer = memo(Composer);
const MLibrary = memo(Library);
const MStage = memo(Stage);

export function Safelight() {
  // Stable per-browser id: ComfyUI only sends progress events to the client id that queued a job,
  // so keeping it across reloads means a refreshed page still sees live progress.
  const [clientId] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("safelight.clientId.v1") ?? localStorage.getItem("studio.clientId.v1");
      if (saved) return saved;
      const fresh = crypto.randomUUID();
      localStorage.setItem("safelight.clientId.v1", fresh);
      return fresh;
    } catch {
      return crypto.randomUUID();
    }
  });
  const [topMode, setTopMode] = useState<TopMode>(() => {
    // ?mode=chat|image deep-links a mode; otherwise the last used mode wins.
    const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("mode");
    const saved = fromUrl ?? loadString("safelight.mode.v1", "image");
    return saved === "chat" || saved === "library" || saved === "code" || saved === "design" || saved === "blueprints" ? saved : "image";
  });
  const [keysOpen, setKeysOpen] = useState(false);
  const progress = useComfySocket(clientId, WS_URL);

  const s = useSessions();
  const backends = useBackends();
  const img = useImageStudio({ clientId, progress, s, setTopMode });

  const { chatModels, ollamaUp, defaultChatModel, setDefaultChatModel, keys, loadKeys, loadChatModels } = backends;
  const { activeChat, activeImage, activeCode, activeDesign, byKind, ensureSession, updateSession, sessionsRef, activeIds, setActiveIds, createSession, setSessions } = s;
  const { loadCatalog, loadGallery, setSettings: setImageSettings } = img;

  useEffect(() => {
    try {
      localStorage.setItem("safelight.mode.v1", topMode);
    } catch {
      /* ignore */
    }
  }, [topMode]);

  // Boot: fetch the active saved theme once and apply it (inline vars override both light and dark until cleared).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/themes").catch(() => null);
      if (cancelled || !res?.ok) return;
      const body = (await res.json().catch(() => null)) as { themes?: { name: string; data?: { colors?: ThemeColors } }[]; active?: string | null } | null;
      const active = body?.active ? body.themes?.find((t) => t.name === body.active) : null;
      if (active?.data?.colors) applyTheme(active.name, active.data.colors);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // First load, then keep the status indicators honest: poll both backends, faster while something is down.
  useEffect(() => {
    const t = setTimeout(() => {
      void loadCatalog();
      void loadGallery();
      void loadChatModels();
      void loadKeys();
    }, 0);
    return () => clearTimeout(t);
  }, [loadCatalog, loadGallery, loadChatModels, loadKeys]);
  useEffect(() => {
    const healthy = img.online && (ollamaUp || chatModels.length > 0);
    const t = setInterval(
      () => {
        void loadCatalog();
        void loadChatModels();
      },
      healthy ? 15000 : 4000,
    );
    return () => clearInterval(t);
  }, [img.online, ollamaUp, chatModels.length, loadCatalog, loadChatModels]);

  const refresh = useCallback(() => {
    void loadCatalog();
    void loadGallery();
    void loadChatModels();
    void loadKeys();
  }, [loadCatalog, loadGallery, loadChatModels, loadKeys]);

  const openKeys = useCallback(() => setKeysOpen(true), []);
  const closeKeys = useCallback(() => setKeysOpen(false), []);

  // ---------- cross-cutting session actions (they also touch the image draft) ----------
  const selectSession = useCallback(
    (id: string) => {
      const target = sessionsRef.current.find((x) => x.id === id);
      if (!target) return;
      setActiveIds((a) => ({ ...a, [target.kind]: id }));
      if (target.kind === "image") setImageSettings((prev) => ({ ...prev, prompt: (target as ImageSession).draft }));
    },
    [setImageSettings, sessionsRef, setActiveIds],
  );
  const createAndOpen = useCallback(
    (kind: SessionKind) => {
      createSession(kind);
      if (kind === "image") setImageSettings((prev) => ({ ...prev, prompt: "" }));
    },
    [createSession, setImageSettings],
  );
  const removeSession = useCallback(
    (id: string) => {
      const target = sessionsRef.current.find((x) => x.id === id);
      setSessions((list) => list.filter((x) => x.id !== id));
      void fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
      if (target && activeIds[target.kind] === id) {
        const next = sessionsRef.current.find((x) => x.kind === target.kind && x.id !== id);
        setActiveIds((a) => ({ ...a, [target.kind]: next?.id ?? null }));
        if (target.kind === "image") setImageSettings((prev) => ({ ...prev, prompt: next ? (next as ImageSession).draft : "" }));
      }
    },
    [activeIds, setImageSettings, setSessions, sessionsRef, setActiveIds],
  );
  const createChat = useCallback(() => createAndOpen("chat"), [createAndOpen]);
  const createCode = useCallback(() => createAndOpen("code"), [createAndOpen]);
  const createDesign = useCallback(() => createAndOpen("design"), [createAndOpen]);

  // ---------- per-mode wiring: messages and models live in the active session ----------
  const chatModel = activeChat?.model && chatModels.some((m) => chatModelKey(m) === activeChat.model) ? activeChat.model : defaultChatModel;
  const setChatModel = useCallback(
    (key: string) => {
      setDefaultChatModel(key);
      const sess = ensureSession("chat");
      updateSession<ChatSession>(sess.id, (x) => ({ ...x, model: key }));
    },
    [ensureSession, updateSession, setDefaultChatModel],
  );
  const setAgent = useCallback(
    (on: boolean) => {
      const sess = ensureSession("chat");
      updateSession<ChatSession>(sess.id, (x) => ({ ...x, agent: on }));
    },
    [ensureSession, updateSession],
  );
  const preferredImageModel = img.settings.model ? `${img.settings.model.folder}:${img.settings.model.name}` : undefined;
  const codeModel = activeCode?.model && chatModels.some((m) => chatModelKey(m) === activeCode.model) ? activeCode.model : defaultChatModel;
  const setCodeModel = useCallback(
    (key: string) => {
      const sess = ensureSession("code");
      updateSession<CodeSession>(sess.id, (x) => ({ ...x, model: key }));
    },
    [ensureSession, updateSession],
  );
  const setCodeRoot = useCallback(
    (root: string) => {
      const sess = ensureSession("code");
      updateSession<CodeSession>(sess.id, (x) => ({ ...x, root }));
    },
    [ensureSession, updateSession],
  );
  const approveCodePath = useCallback(
    (p: string) => {
      const sess = ensureSession("code");
      updateSession<CodeSession>(sess.id, (x) => ({ ...x, approvedPaths: (x.approvedPaths ?? []).includes(p) ? x.approvedPaths : [...(x.approvedPaths ?? []), p] }));
    },
    [ensureSession, updateSession],
  );
  const removeCodePath = useCallback(
    (p: string) => {
      const sess = ensureSession("code");
      updateSession<CodeSession>(sess.id, (x) => ({ ...x, approvedPaths: (x.approvedPaths ?? []).filter((a) => a !== p) }));
    },
    [ensureSession, updateSession],
  );
  const designModel = activeDesign?.model && chatModels.some((m) => chatModelKey(m) === activeDesign.model) ? activeDesign.model : defaultChatModel;
  const setDesignModel = useCallback(
    (key: string) => {
      const sess = ensureSession("design");
      updateSession<DesignSession>(sess.id, (x) => ({ ...x, model: key }));
    },
    [ensureSession, updateSession],
  );
  const onMessages = useCallback(
    (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      const sess = ensureSession("chat");
      updateSession<ChatSession>(sess.id, (x) => {
        const messages = fn(x.messages);
        const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
        return { ...x, messages, title: x.titled ? x.title : autoTitle(firstUser, x.title) };
      });
    },
    [ensureSession, updateSession],
  );
  const onCodeMessages = useCallback(
    (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      const sess = ensureSession("code");
      updateSession<CodeSession>(sess.id, (x) => {
        const messages = fn(x.messages);
        const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
        return { ...x, messages, title: x.titled ? x.title : autoTitle(firstUser, x.title) };
      });
    },
    [ensureSession, updateSession],
  );
  /** Fork the conversation: a new chat session seeded with the truncated history. */
  const onBranch = useCallback(
    (messages: ChatMessage[]) => {
      const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
      createSession("chat", { messages, title: autoTitle(firstUser, "Branched chat"), titled: false } as Partial<ChatSession>);
    },
    [createSession],
  );
  const onPatchChatSession = useCallback(
    (patch: Partial<{ system: string; params: ChatParams }>) => {
      const sess = ensureSession("chat");
      updateSession<ChatSession>(sess.id, (x) => ({ ...x, ...patch }));
    },
    [ensureSession, updateSession],
  );
  const onDesignMessages = useCallback(
    (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      const sess = ensureSession("design");
      updateSession<DesignSession>(sess.id, (x) => {
        const messages = fn(x.messages);
        const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
        return { ...x, messages, title: x.titled ? x.title : autoTitle(firstUser, x.title) };
      });
    },
    [ensureSession, updateSession],
  );

  /** Uploads for chat attachments; same input folder as Image mode so references work in both. */
  const uploadRefs = useCallback(async (files: File[]): Promise<ChatAttachment[]> => {
    return (await uploadRefFiles(files)).map((f) => ({ ref: f.ref, filename: f.filename, subfolder: f.subfolder }));
  }, []);

  // ---------- status ----------
  const { systems, overall } = useMemo(() => {
    const counts = (list: { provider?: string }[]) => {
      const out: Record<string, number> = {};
      for (const m of list) if (m.provider) out[m.provider] = (out[m.provider] ?? 0) + 1;
      return out;
    };
    return deriveStatus({
      checking: img.lastHealthAt === null,
      topMode,
      online: img.online,
      progressConnected: progress.connected,
      ollamaUp,
      localChatCount: chatModels.filter((m) => m.provider === "ollama").length,
      localImageCount: img.catalog?.models.filter((m) => m.folder !== "cloud").length ?? 0,
      keys,
      cloudErrors: img.catalog?.cloudErrors,
      chatCounts: counts(chatModels),
      imageCounts: counts(img.catalog?.models ?? []),
      onAddKey: openKeys,
    });
  }, [img.lastHealthAt, topMode, img.online, progress.connected, ollamaUp, chatModels, img.catalog, keys, openKeys]);

  void img.catalogError;

  return (
    <div className="grid min-h-[100dvh] grid-cols-1 gap-3.5 bg-shell p-3.5 font-sans lg:h-[100dvh] lg:grid-cols-[268px_minmax(0,1fr)]">
      <KeysDialog open={keysOpen} onClose={closeKeys} onChanged={refresh} />

      <MSidebar
        mode={topMode}
        onMode={setTopMode}
        galleryCount={img.gallery.length}
        chatSessions={byKind.chat}
        imageSessions={byKind.image}
        codeSessions={byKind.code}
        designSessions={byKind.design}
        activeChatId={activeChat?.id ?? null}
        activeImageId={activeImage?.id ?? null}
        activeCodeId={activeCode?.id ?? null}
        activeDesignId={activeDesign?.id ?? null}
        onSelectSession={selectSession}
        onCreateSession={createAndOpen}
        onRenameSession={s.renameSession}
        onDeleteSession={removeSession}
        onMoveSession={s.moveSession}
        projects={s.projects}
        sessions={s.sessions}
        activeProjectId={s.activeProjectId}
        onSelectProject={s.setActiveProjectId}
        onCreateProject={s.createProject}
        onRenameProject={s.renameProject}
        onDeleteProject={s.removeProject}
        overall={overall}
        systems={systems}
        queueCount={img.renderQueue.length}
        onRefresh={refresh}
        onKeys={openKeys}
      />

      <main className="panel flex min-h-0 flex-col overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={topMode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="flex min-h-0 flex-1 flex-col">
        {topMode === "chat" ? (
          <MChatWorkspace
            active={activeChat}
            onCreateSession={createChat}
            models={chatModels}
            ollamaUp={ollamaUp}
            model={chatModel}
            onModel={setChatModel}
            agent={Boolean(activeChat?.agent)}
            onAgent={setAgent}
            messages={activeChat?.messages ?? []}
            onMessages={onMessages}
            onBranch={onBranch}
            onPatchSession={onPatchChatSession}
            onUseAsPrompt={img.useAsPrompt}
            onUseAsInput={img.useAsInput}
            onOpenKeys={openKeys}
            preferredModel={preferredImageModel}
            clientId={clientId}
            onUpload={uploadRefs}
          />
        ) : topMode === "code" ? (
          <MCodeWorkspace
            active={activeCode}
            onCreateSession={createCode}
            onRoot={setCodeRoot}
            onApprovePath={approveCodePath}
            onRemoveApprovedPath={removeCodePath}
            models={chatModels}
            ollamaUp={ollamaUp}
            model={codeModel}
            onModel={setCodeModel}
            messages={activeCode?.messages ?? []}
            onMessages={onCodeMessages}
            onUseAsPrompt={img.useAsPrompt}
            onUseAsInput={img.useAsInput}
            onOpenKeys={openKeys}
            clientId={clientId}
            onUpload={uploadRefs}
          />
        ) : topMode === "design" ? (
          <MDesignWorkspace
            active={activeDesign}
            onCreateSession={createDesign}
            models={chatModels}
            ollamaUp={ollamaUp}
            model={designModel}
            onModel={setDesignModel}
            messages={activeDesign?.messages ?? []}
            onMessages={onDesignMessages}
            onUseAsPrompt={img.useAsPrompt}
            onUseAsInput={img.useAsInput}
            onOpenKeys={openKeys}
            clientId={clientId}
            onUpload={uploadRefs}
          />
        ) : topMode === "library" ? (
          <MLibrary gallery={img.gallery} onUseAsInput={img.useAsInput} onDelete={img.deleteOutput} />
        ) : topMode === "blueprints" ? (
          <BlueprintsWorkspace />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[350px_minmax(0,1fr)]">
            <MComposer
              catalog={img.catalog}
              online={img.online}
              settings={img.settings}
              onChange={img.update}
              onSelectModel={img.selectModel}
              onUpload={img.upload}
              uploading={img.uploading}
              canGenerate={img.canGenerate}
              submitting={img.submitting}
              error={img.submitError}
              onGenerate={img.generate}
              onOpenKeys={openKeys}
            />
            <div className="flex min-h-0 flex-col overflow-y-auto p-5 lg:overflow-hidden">
              <MStage
                title={activeImage?.title ?? "New session"}
                gallery={img.gallery}
                jobs={img.jobs}
                progress={progress}
                filter={img.wallFilter}
                onFilter={img.setWallFilter}
                onInterrupt={img.interrupt}
                onUseAsInput={img.useAsInput}
                onDelete={img.deleteOutput}
                queue={img.renderQueue}
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
