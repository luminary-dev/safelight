"use client";

import { Code2, FolderInput, HardDriveDownload, Image as ImageIcon, KeyRound, LibraryBig, MessageSquare, Palette, Pencil, Plug, Plus, RefreshCw, Search, Settings2, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatSession, CodeSession, DesignSession, ImageSession, Project, Session } from "@/lib/session-types";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "./ConfirmDelete";
import { McpDialog } from "./McpDialog";
import { ModelManagerDialog } from "./ModelManagerDialog";
import { SettingsDialog } from "./SettingsDialog";
import { SafelightMark, type SystemRow, type Tone, type TopMode } from "./shell";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "./ThemeToggle";

const TONE_DOT: Record<Tone, string> = { ok: "bg-green", warn: "bg-terracotta", down: "bg-danger", checking: "bg-faint pulse", off: "bg-line-strong" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-green", warn: "text-terracotta", down: "text-danger", checking: "text-ink-muted", off: "text-faint" };

type ListSession = ChatSession | ImageSession | CodeSession | DesignSession;

function group(sessions: ListSession[]): { label: string; items: ListSession[] }[] {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = sessions.filter((s) => s.updatedAt >= dayStart);
  const earlier = sessions.filter((s) => s.updatedAt < dayStart);
  return [
    { label: "Today", items: today },
    { label: "Earlier", items: earlier },
  ].filter((g) => g.items.length > 0);
}

/** The soft-shell sidebar: wordmark, search, mode nav, the current mode's sessions, and the status card. */
export function Sidebar({
  mode,
  onMode,
  galleryCount,
  chatSessions,
  imageSessions,
  codeSessions,
  designSessions,
  activeChatId,
  activeImageId,
  activeCodeId,
  activeDesignId,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onMoveSession,
  projects,
  sessions,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  overall,
  systems,
  queueCount,
  onRefresh,
  onKeys,
}: {
  mode: TopMode;
  onMode: (m: TopMode) => void;
  galleryCount: number;
  chatSessions: ChatSession[];
  imageSessions: ImageSession[];
  codeSessions: CodeSession[];
  designSessions: DesignSession[];
  activeChatId: string | null;
  activeImageId: string | null;
  activeCodeId: string | null;
  activeDesignId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (kind: "chat" | "image" | "code" | "design") => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onMoveSession: (id: string, projectId: string | null) => void;
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onCreateProject: () => void;
  onRenameProject: (id: string, title: string) => void;
  onDeleteProject: (id: string) => void;
  overall: { tone: Tone; label: string };
  systems: SystemRow[];
  queueCount: number;
  onRefresh: () => void;
  onKeys: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [ram, setRam] = useState<{ total: number; free: number } | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);

  // The Local only badge must be truthful on load, not only after the dialog was opened.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json() as Promise<{ settings?: { localOnly?: boolean } }>)
      .then((d) => setLocalOnly(d.settings?.localOnly === true))
      .catch(() => undefined);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Memory pressure straight from the backend, refreshed gently.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/health").catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json()) as { stats?: { system?: { ram_total?: number; ram_free?: number } } };
      const sys = data.stats?.system;
      if (sys?.ram_total) setRam({ total: sys.ram_total, free: sys.ram_free ?? 0 });
    };
    void load();
    const t = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // Re-fetch when renders start or finish, since that is when memory moves.
  }, [queueCount]);

  const kind = mode === "chat" ? "chat" : mode === "code" ? "code" : mode === "design" ? "design" : "image";
  const list = (mode === "chat" ? chatSessions : mode === "code" ? codeSessions : mode === "design" ? designSessions : imageSessions) as ListSession[];
  const activeId = mode === "chat" ? activeChatId : mode === "code" ? activeCodeId : mode === "design" ? activeDesignId : activeImageId;
  const filtered = useMemo(() => (query.trim() ? list.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())) : list), [list, query]);
  // Decimal gigabytes, matching how the machine's memory is marketed and shown in About This Mac.
  const usedGb = ram ? (ram.total - ram.free) / 1e9 : 0;
  const totalGb = ram ? ram.total / 1e9 : 0;

  return (
    <aside className="panel-side flex min-h-0 flex-col gap-4 p-4 pt-5">
      <div className="flex flex-col gap-1.5 px-2">
        <span className="flex items-center gap-2">
          <SafelightMark className="size-6 rounded-[8px]" />
          <span className="font-display text-[21px] font-extrabold tracking-[-0.02em] text-ink">
            Safelight<span className="text-terracotta">.</span>
          </span>
        </span>
        <span className="flex items-center gap-1">
          <ThemeToggle className="size-7 rounded-full border-0 bg-transparent text-faint shadow-none hover:bg-pill hover:text-ink" />
          <button type="button" aria-label="API keys" onClick={onKeys} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
            <KeyRound className="size-3.5" />
          </button>
          <button type="button" aria-label="MCP servers" onClick={() => setMcpOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
            <Plug className="size-3.5" />
          </button>
          <button type="button" aria-label="Model manager" onClick={() => setModelsOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
            <HardDriveDownload className="size-3.5" />
          </button>
          <button type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
            <Settings2 className="size-3.5" />
          </button>
        </span>
        <ModelManagerDialog open={modelsOpen} onClose={() => setModelsOpen(false)} />
        <McpDialog open={mcpOpen} onClose={() => setMcpOpen(false)} />
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onOpenKeys={() => {
            setSettingsOpen(false);
            onKeys();
          }}
          onOpenMcp={() => {
            setSettingsOpen(false);
            setMcpOpen(true);
          }}
          onLocalOnlyChange={setLocalOnly}
        />
      </div>

      {localOnly ? (
        <p className="flex items-center gap-2 rounded-[10px] bg-terracotta-wash px-3 py-1.5 font-mono text-[11px] font-medium text-terracotta">
          <span className="size-1.5 rounded-full bg-terracotta" /> Local only — nothing leaves this machine
        </p>
      ) : null}

      <label className="flex items-center gap-2.5 rounded-[12px] bg-paper-2 px-3 py-2.5 shadow-[var(--shadow-hairline)]">
        <Search className="size-3.5 shrink-0 text-placeholder" />
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search sessions" className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-placeholder" />
        <span className="rounded-[5px] bg-terracotta-wash px-1.5 py-0.5 font-mono text-[11px] font-medium text-terracotta">⌘K</span>
      </label>

      <nav className="flex flex-col gap-0.5">
        {(
          [
            ["chat", "Chat", MessageSquare, null],
            ["image", "Image", ImageIcon, null],
            ["code", "Code", Code2, null],
            ["design", "Design", Palette, null],
            ["library", "Library", LibraryBig, galleryCount],
            ["blueprints", "Blueprints", Workflow, null],
          ] as const
        ).map(([value, label, Icon, count]) => (
          <button
            key={value}
            type="button"
            aria-current={mode === value ? "page" : undefined}
            onClick={() => onMode(value)}
            className={cn(
              "flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-left font-display text-[15px] transition-colors",
              mode === value ? "bg-paper-2 font-semibold text-ink shadow-[var(--shadow-hairline)]" : "font-medium text-ink-muted hover:bg-pill/60 hover:text-ink",
            )}
          >
            <Icon className="size-4" />
            {label}
            {count !== null ? <span className="ml-auto font-mono text-[12px] font-normal text-placeholder">{count}</span> : null}
          </button>
        ))}
      </nav>

      {mode !== "library" && mode !== "blueprints" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <div className="flex items-center justify-between px-3 pb-1.5">
            <span className="text-[12px] font-medium text-placeholder">{mode === "chat" ? "Conversations" : mode === "code" ? "Coding sessions" : mode === "design" ? "Design sessions" : "Sessions"}</span>
            <button type="button" onClick={() => onCreateSession(kind)} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] font-medium text-faint hover:bg-pill hover:text-ink">
              <Plus className="size-3" /> New
            </button>
          </div>
          {filtered.length === 0 ? <p className="px-3 py-4 text-[13px] text-placeholder">{query ? "No matches." : mode === "chat" ? "Your first message starts a chat." : mode === "code" ? "Point a session at a folder to start." : mode === "design" ? "Ask for a theme to start." : "Your first render starts a session."}</p> : null}
          {group(filtered).map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <span className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-placeholder">{g.label}</span>
              {g.items.map((s) =>
                editing === s.id ? (
                  <form
                    key={s.id}
                    className="px-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      onRenameSession(s.id, draft.trim() || s.title);
                      setEditing(null);
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => {
                        onRenameSession(s.id, draft.trim() || s.title);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                      className="w-full rounded-[8px] bg-paper-2 px-2 py-1.5 text-[14px] text-ink shadow-[var(--shadow-hairline)] outline-none"
                      aria-label="Session title"
                    />
                  </form>
                ) : (
                  <div key={s.id} className="group/r relative">
                    <button
                      type="button"
                      aria-current={s.id === activeId ? "true" : undefined}
                      onClick={() => onSelectSession(s.id)}
                      className={cn(
                        "flex w-full items-center gap-2 truncate rounded-[10px] px-3 py-2 text-left text-[14px] transition-colors",
                        s.id === activeId ? "bg-terracotta-wash font-medium text-ink" : "text-ink-muted hover:bg-pill/60",
                      )}
                    >
                      {s.id === activeId ? <span className="size-1.5 shrink-0 rounded-full bg-terracotta" /> : null}
                      <span className="truncate">{s.title}</span>
                    </button>
                    <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-focus-within/r:opacity-100 group-hover/r:opacity-100">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" aria-label="Move to project" className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:text-ink">
                            <FolderInput className="size-3" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" sideOffset={6} className="glass w-[220px] gap-0 rounded-[14px] p-1.5 ring-0">
                          {[{ id: null as string | null, title: "No project" }, ...projects].map((p) => (
                            <button
                              key={p.id ?? "none"}
                              type="button"
                              onClick={() => onMoveSession(s.id, p.id)}
                              className={cn("flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px]", (s.projectId ?? null) === p.id ? "bg-terracotta-wash text-ink" : "text-ink-muted hover:bg-pill/60")}
                            >
                              {p.title}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                      <button
                        type="button"
                        aria-label="Rename"
                        onClick={() => {
                          setDraft(s.title);
                          setEditing(s.id);
                        }}
                        className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:text-ink"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <ConfirmDelete
                        filename={s.title}
                        title={`Delete this ${mode === "chat" ? "chat" : "session"}?`}
                        description={
                          <>
                            <span className="font-medium text-ink">{s.title}</span>
                            {mode === "chat" ? " and its messages are removed. This cannot be undone." : " and its render history are removed. Images stay in the library."}
                          </>
                        }
                        onConfirm={() => onDeleteSession(s.id)}
                        trigger={
                          <button type="button" aria-label="Delete" className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:text-danger">
                            <Trash2 className="size-3" />
                          </button>
                        }
                      />
                    </span>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}

      <div className="flex flex-col gap-2.5 rounded-[14px] bg-paper-2 p-3 shadow-[var(--shadow-hairline)]">
        <div className="flex items-center justify-between gap-2">
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="flex min-w-0 items-center gap-2 text-left font-display text-[13px] font-semibold text-ink" aria-label="System status">
                <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT[overall.tone])} style={overall.tone === "ok" ? { boxShadow: "0 0 0 3px var(--green-wash)" } : undefined} />
                <span aria-live="polite" aria-atomic="true" className="truncate">
                  {queueCount > 0 ? `Rendering · ${queueCount} in queue` : overall.label}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" sideOffset={8} className="glass w-[320px] gap-0 rounded-[16px] p-0 ring-0">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <span className="form-label">Systems</span>
                <button
                  type="button"
                  onClick={() => {
                    setSpinning(true);
                    onRefresh();
                    setTimeout(() => setSpinning(false), 900);
                  }}
                  className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-ink"
                >
                  <RefreshCw className={cn("size-3", spinning && "animate-spin")} /> Re-check
                </button>
              </div>
              <ul className="p-1.5">
                {systems.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 hover:bg-pill/60">
                    <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[s.tone])} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="font-display text-sm font-medium text-ink">{s.label}</span>
                      <span className={cn("truncate font-mono text-[11px]", TONE_TEXT[s.tone])}>{s.detail}</span>
                    </span>
                    {s.action ? (
                      <button
                        type="button"
                        onClick={() => {
                          setStatusOpen(false);
                          s.action!.onClick();
                        }}
                        className="shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-terracotta hover:text-terracotta"
                      >
                        {s.action.label}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
          <ProjectSwitcher projects={projects} sessions={sessions} activeId={activeProjectId} onSelect={onSelectProject} onCreate={onCreateProject} onRename={onRenameProject} onDelete={onDeleteProject} />
        </div>
        {ram ? (
          <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
            RAM
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-pill">
              <span className="block h-full rounded-full bg-terracotta transition-[width] duration-700 ease-out" style={{ width: `${Math.min(100, Math.round((usedGb / totalGb) * 100))}%` }} />
            </span>
            {usedGb.toFixed(0)}/{totalGb.toFixed(0)} GB
          </div>
        ) : null}
      </div>
    </aside>
  );
}
