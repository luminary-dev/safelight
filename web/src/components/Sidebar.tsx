"use client";

import { Code2, FolderInput, HardDriveDownload, Image as ImageIcon, KeyRound, LibraryBig, Menu, MessageSquare, Palette, Pencil, Plug, Plus, RefreshCw, Search, Settings2, Trash2, Workflow, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TruncatedText } from "@/components/ui/truncated-text";
import { formatNumber } from "@/lib/i18n-format";
import type { ChatSession, CodeSession, DesignSession, ImageSession, Project, Session } from "@/lib/session-types";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "./ConfirmDelete";
import { McpDialog } from "./McpDialog";
import { ModelManagerDialog } from "./ModelManagerDialog";
import { SettingsDialog } from "./SettingsDialog";
import { SafelightMark, ShellHeader, useDialogFocus, type StatusMessage, type SystemRow, type Tone, type TopMode } from "./shell";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "./ThemeToggle";

const TONE_DOT: Record<Tone, string> = { ok: "bg-green", warn: "bg-terracotta", down: "bg-danger", checking: "bg-faint pulse", off: "bg-line-strong" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-green", warn: "text-terracotta", down: "text-danger", checking: "text-ink-muted", off: "text-faint" };

type ListSession = ChatSession | ImageSession | CodeSession | DesignSession;

function group(sessions: ListSession[]): { key: "today" | "earlier"; items: ListSession[] }[] {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = sessions.filter((s) => s.updatedAt >= dayStart);
  const earlier = sessions.filter((s) => s.updatedAt < dayStart);
  return [
    { key: "today" as const, items: today },
    { key: "earlier" as const, items: earlier },
  ].filter((g) => g.items.length > 0);
}

/**
 * The soft-shell sidebar: wordmark, search, mode nav, the current mode's
 * sessions, and the status card. From the `compact` breakpoint (≥1024) it is
 * the fixed rail; below that it collapses into a sheet behind a trigger in the
 * stacked-layout header (UI-RESPONSIVE-BRIEF §5 Tier A item 3).
 */
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
  overall: { tone: Tone; label: StatusMessage };
  systems: SystemRow[];
  queueCount: number;
  onRefresh: () => void;
  onKeys: () => void;
}) {
  const t = useTranslations("sidebar");
  const tStatus = useTranslations("systemStatus");
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

  // The collapsible sheet that replaces the rail below the stacked breakpoint.
  const [navOpen, setNavOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  useDialogFocus(navOpen, sheetRef);

  // While the sheet is open: Escape closes it, and the body behind it cannot scroll.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  // The rail returns at ≥1024; a sheet left open there would duplicate it.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => mq.matches && setNavOpen(false);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // The Local only badge must be truthful on load, not only after the dialog was opened.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json() as Promise<{ settings?: { localOnly?: boolean } }>)
      .then((d) => setLocalOnly(d.settings?.localOnly === true))
      .catch(() => undefined);
  }, []);
  const railSearchRef = useRef<HTMLInputElement>(null);
  const sheetSearchRef = useRef<HTMLInputElement>(null);

  // ⌘K focuses whichever search field is actually visible (rail or sheet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const visible = [railSearchRef.current, sheetSearchRef.current].find((n) => n && n.offsetParent !== null);
        (visible ?? railSearchRef.current)?.focus();
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

  /** The rail's content, rendered in the fixed rail and again inside the sheet. Sheet picks also close the sheet. */
  const railInner = (inSheet: boolean) => {
    const closeNav = inSheet ? () => setNavOpen(false) : undefined;
    return (
      <>
        <div className="flex flex-col gap-1.5 px-2">
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <SafelightMark className="size-6 rounded-[8px]" />
              <span className="font-display text-[21px] font-extrabold tracking-[-0.02em] text-ink">
                Safelight<span className="text-terracotta">.</span>
              </span>
            </span>
            {inSheet ? (
              <button type="button" aria-label={t("closeNavigation")} onClick={closeNav} className="grid size-11 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
                <X className="size-4" />
              </button>
            ) : null}
          </span>
          <span className="flex items-center gap-1">
            <ThemeToggle className="size-7 rounded-full border-0 bg-transparent text-faint shadow-none hover:bg-pill hover:text-ink" />
            <button type="button" aria-label={t("apiKeys")} onClick={onKeys} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
              <KeyRound className="size-3.5" />
            </button>
            <button type="button" aria-label={t("mcpServers")} onClick={() => setMcpOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
              <Plug className="size-3.5" />
            </button>
            <button type="button" aria-label={t("modelManager")} onClick={() => setModelsOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
              <HardDriveDownload className="size-3.5" />
            </button>
            <button type="button" aria-label={t("settings")} onClick={() => setSettingsOpen(true)} className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink">
              <Settings2 className="size-3.5" />
            </button>
          </span>
        </div>

        {localOnly ? (
          <p className="flex items-center gap-2 rounded-[10px] bg-terracotta-wash px-3 py-1.5 font-mono text-[11px] font-medium text-terracotta">
            <span className="size-1.5 rounded-full bg-terracotta" /> {t("localOnlyBadge")}
          </p>
        ) : null}

        <label className="flex items-center gap-2.5 rounded-[12px] bg-paper-2 px-3 py-2.5 shadow-[var(--shadow-hairline)]">
          <Search className="size-3.5 shrink-0 text-placeholder" />
          <input
            ref={inSheet ? sheetSearchRef : railSearchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-placeholder"
          />
          <span className="rounded-[5px] bg-terracotta-wash px-1.5 py-0.5 font-mono text-[11px] font-medium text-terracotta">⌘K</span>
        </label>

        <nav className="flex flex-col gap-0.5">
          {(
            [
              ["chat", MessageSquare, null],
              ["image", ImageIcon, null],
              ["code", Code2, null],
              ["design", Palette, null],
              ["library", LibraryBig, galleryCount],
              ["blueprints", Workflow, null],
            ] as const
          ).map(([value, Icon, count]) => (
            <button
              key={value}
              type="button"
              aria-current={mode === value ? "page" : undefined}
              onClick={() => {
                onMode(value);
                closeNav?.();
              }}
              className={cn(
                "flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-start font-display text-[15px] transition-colors",
                mode === value ? "bg-paper-2 font-semibold text-ink shadow-[var(--shadow-hairline)]" : "font-medium text-ink-muted hover:bg-pill/60 hover:text-ink",
              )}
            >
              <Icon className="size-4" />
              {t(`nav.${value}`)}
              {count !== null ? <span className="ms-auto font-mono text-[12px] font-normal text-placeholder">{count}</span> : null}
            </button>
          ))}
        </nav>

        {mode !== "library" && mode !== "blueprints" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            <div className="flex items-center justify-between px-3 pb-1.5">
              <span className="text-[12px] font-medium text-placeholder">{mode === "chat" ? t("sectionConversations") : mode === "code" ? t("sectionCoding") : mode === "design" ? t("sectionDesign") : t("sectionSessions")}</span>
              <button type="button" onClick={() => onCreateSession(kind)} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] font-medium text-faint hover:bg-pill hover:text-ink">
                <Plus className="size-3" /> {t("new")}
              </button>
            </div>
            {filtered.length === 0 ? <p className="px-3 py-4 text-[13px] text-placeholder">{query ? t("emptyNoMatches") : mode === "chat" ? t("emptyChat") : mode === "code" ? t("emptyCode") : mode === "design" ? t("emptyDesign") : t("emptyImage")}</p> : null}
            {group(filtered).map((g) => (
              <div key={g.key} className="flex flex-col gap-0.5">
                <span className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-placeholder">{t(`group.${g.key}`)}</span>
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
                        aria-label={t("sessionTitleAria")}
                      />
                    </form>
                  ) : (
                    <div key={s.id} className="group/r relative">
                      <button
                        type="button"
                        aria-current={s.id === activeId ? "true" : undefined}
                        onClick={() => {
                          onSelectSession(s.id);
                          closeNav?.();
                        }}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 rounded-[10px] px-3 py-2 text-start text-[14px] transition-colors",
                          s.id === activeId ? "bg-terracotta-wash font-medium text-ink" : "text-ink-muted hover:bg-pill/60",
                        )}
                      >
                        {s.id === activeId ? <span className="size-1.5 shrink-0 rounded-full bg-terracotta" /> : null}
                        <TruncatedText text={s.title} className="flex-1" />
                      </button>
                      <span className="absolute end-1.5 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-focus-within/r:opacity-100 group-hover/r:opacity-100">
                        <Popover>
                          <PopoverTrigger asChild>
                            <button type="button" aria-label={t("moveToProject")} className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:text-ink">
                              <FolderInput className="size-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="start" sideOffset={6} className="glass w-[220px] gap-0 rounded-[14px] p-1.5 ring-0">
                            {[{ id: null as string | null, title: t("noProject") }, ...projects].map((p) => (
                              <button
                                key={p.id ?? "none"}
                                type="button"
                                onClick={() => onMoveSession(s.id, p.id)}
                                className={cn("flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-start text-[13px]", (s.projectId ?? null) === p.id ? "bg-terracotta-wash text-ink" : "text-ink-muted hover:bg-pill/60")}
                              >
                                {p.title}
                              </button>
                            ))}
                          </PopoverContent>
                        </Popover>
                        <button
                          type="button"
                          aria-label={t("rename")}
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
                          title={mode === "chat" ? t("deleteChatTitle") : t("deleteSessionTitle")}
                          description={t.rich(mode === "chat" ? "deleteChatDescription" : "deleteSessionDescription", {
                            title: s.title,
                            b: (chunks) => <span className="font-medium text-ink [overflow-wrap:anywhere]">{chunks}</span>,
                          })}
                          onConfirm={() => onDeleteSession(s.id)}
                          trigger={
                            <button type="button" aria-label={t("delete")} className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:text-danger">
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
                <button type="button" className="flex min-w-0 items-center gap-2 text-start font-display text-[13px] font-semibold text-ink" aria-label={t("systemStatusAria")}>
                  <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT[overall.tone])} style={overall.tone === "ok" ? { boxShadow: "0 0 0 3px var(--green-wash)" } : undefined} />
                  <span aria-live="polite" aria-atomic="true" className="truncate">
                    {queueCount > 0 ? t("rendering", { count: queueCount }) : tStatus(overall.label.key, overall.label.values)}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" sideOffset={8} className="glass w-[320px] max-w-[calc(100vw-32px)] gap-0 rounded-[16px] p-0 ring-0">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <span className="form-label">{t("systems")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSpinning(true);
                      onRefresh();
                      setTimeout(() => setSpinning(false), 900);
                    }}
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-ink"
                  >
                    <RefreshCw className={cn("size-3", spinning && "animate-spin")} /> {t("recheck")}
                  </button>
                </div>
                <ul className="p-1.5">
                  {systems.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 hover:bg-pill/60">
                      <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[s.tone])} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="font-display text-sm font-medium text-ink">{s.label}</span>
                        <span className={cn("truncate font-mono text-[11px]", TONE_TEXT[s.tone])}>{tStatus(s.detail.key, s.detail.values)}</span>
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
                          {tStatus(s.action.label.key, s.action.label.values)}
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
              {t("ram")}
              <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-pill">
                <span className="block h-full rounded-full bg-terracotta transition-[width] duration-700 ease-out" style={{ width: `${Math.min(100, Math.round((usedGb / totalGb) * 100))}%` }} />
              </span>
              {t("ramUsage", { used: formatNumber(usedGb, { maximumFractionDigits: 0 }), total: formatNumber(totalGb, { maximumFractionDigits: 0 }) })}
            </div>
          ) : null}
        </div>
      </>
    );
  };

  return (
    <>
      <ShellHeader>
        <button
          type="button"
          aria-label={t("openNavigation")}
          aria-expanded={navOpen}
          aria-haspopup="dialog"
          onClick={() => setNavOpen(true)}
          className="grid size-11 place-items-center rounded-full text-ink-muted hover:bg-pill hover:text-ink"
        >
          <Menu className="size-5" />
        </button>
      </ShellHeader>

      {/* Dialogs live outside the rail/sheet so each renders exactly once. */}
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

      <aside className="panel-side hidden min-h-0 flex-col gap-4 p-4 pt-5 lg:flex">{railInner(false)}</aside>

      {navOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/25" onClick={() => setNavOpen(false)} aria-hidden />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("navigation")}
            className="absolute inset-y-0 start-0 flex w-[min(320px,calc(100vw-48px))] flex-col gap-4 overflow-y-auto rounded-e-[22px] border-e border-line bg-paper p-4 pt-5 shadow-[var(--shadow-raised)]"
          >
            {railInner(true)}
          </div>
        </div>
      ) : null}
    </>
  );
}
