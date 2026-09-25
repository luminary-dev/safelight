"use client";

import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Project, Session } from "@/lib/session-types";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "./ConfirmDelete";

function summary(p: Project, sessions: Session[]): string {
  const chats = sessions.filter((s) => s.projectId === p.id && s.kind === "chat").length;
  const images = sessions.filter((s) => s.projectId === p.id && s.kind === "image").length;
  const parts = [chats ? `${chats} chat${chats === 1 ? "" : "s"}` : null, images ? `${images} image session${images === 1 ? "" : "s"}` : null].filter(Boolean);
  return parts.join(" · ") || "Empty";
}

/** Popover project switcher: scopes chats and image sessions to one project, or all of them. */
export function ProjectSwitcher({
  projects,
  sessions,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  projects: Project[];
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const active = projects.find((p) => p.id === activeId) ?? null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {editing && active ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(active.id, draft.trim() || active.title);
            setEditing(false);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(active.id, draft.trim() || active.title);
              setEditing(false);
            }}
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            className="field h-8 w-[200px] font-display text-[13px]"
            aria-label="Project title"
          />
        </form>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex min-w-0 max-w-[160px] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] font-medium text-ink-muted hover:bg-pill hover:text-ink">
              <span className="truncate">{active?.title ?? "All projects"}</span>
              <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-180")} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={8} onOpenAutoFocus={(e) => e.preventDefault()} className="glass w-[320px] gap-0 rounded-[16px] p-0 ring-0">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-3">
              <span className="form-label">Projects</span>
              <button
                type="button"
                onClick={() => {
                  onCreate();
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-ink hover:border-terracotta hover:text-terracotta"
              >
                <Plus className="size-3" /> New
              </button>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-1.5">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                  className={cn("flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors", activeId === null ? "bg-pill text-ink" : "hover:bg-pill/60")}
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", activeId === null ? "bg-terracotta" : "bg-line-strong")} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-display text-[13px] font-medium text-ink">All projects</span>
                    <span className="truncate font-mono text-[10.5px] text-faint">Everything, filed and unfiled</span>
                  </span>
                </button>
              </li>
              {projects.map((p) => (
                <li key={p.id} className="group/p relative">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(p.id);
                      setOpen(false);
                    }}
                    className={cn("flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 pr-16 text-left transition-colors", p.id === activeId ? "bg-pill text-ink" : "hover:bg-pill/60")}
                  >
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", p.id === activeId ? "bg-terracotta" : "bg-line-strong")} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate font-display text-[13px] font-medium text-ink">{p.title}</span>
                      <span className="truncate font-mono text-[10.5px] text-faint">{summary(p, sessions)}</span>
                    </span>
                  </button>
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-focus-within/p:opacity-100 group-hover/p:opacity-100">
                    <button
                      type="button"
                      aria-label="Rename"
                      onClick={() => {
                        onSelect(p.id);
                        setDraft(p.title);
                        setEditing(true);
                        setOpen(false);
                      }}
                      className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted hover:text-ink"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <ConfirmDelete
                      filename={p.title}
                      title="Delete this project?"
                      description={
                        <>
                          <span className="font-medium text-ink">{p.title}</span> is removed. Its chats and image sessions are kept and move to All projects.
                        </>
                      }
                      onConfirm={() => onDelete(p.id)}
                      trigger={
                        <button type="button" aria-label="Delete" className="grid size-6 place-items-center rounded-full bg-paper-2 text-ink-muted hover:text-danger">
                          <Trash2 className="size-3" />
                        </button>
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      {active && !editing ? (
        <button
          type="button"
          aria-label="Rename project"
          onClick={() => {
            setDraft(active.title);
            setEditing(true);
          }}
          className="grid size-7 place-items-center rounded-full text-faint hover:bg-pill hover:text-ink"
        >
          <Pencil className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
