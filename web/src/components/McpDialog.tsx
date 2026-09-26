"use client";

import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "./shell";

interface McpServerView {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  status: "ok" | "error" | "off";
  tools: { name: string; description: string; readOnly: boolean }[];
  error?: string;
}

const STATUS_DOT: Record<McpServerView["status"], string> = { ok: "bg-green", error: "bg-danger", off: "bg-line-strong" };

/** Add, enable and remove MCP servers whose tools join every agent mode. */
export function McpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("mcpDialog");
  const reduce = useReducedMotion();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", transport: "stdio" as "stdio" | "http", command: "", url: "" });
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, cardRef);

  // No synchronous setState here: all state lands from the fetch's continuations.
  const load = useCallback(
    () =>
      fetch("/api/mcp")
        .then((r) => r.json() as Promise<{ servers: McpServerView[] }>)
        .then((d) => {
          setServers(d.servers);
          setLoaded(true);
        })
        .catch(() => setError(t("loadFailed"))),
    [t],
  );

  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, load]);

  const recheck = () => {
    setSpinning(true);
    void load().finally(() => setSpinning(false));
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const [command, ...args] = draft.command.trim().split(/\s+/);
      const body = draft.transport === "stdio" ? { name: draft.name, transport: "stdio", command, args } : { name: draft.name, transport: "http", url: draft.url.trim() };
      const res = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("saveFailed"));
      setDraft({ name: "", transport: "stdio", command: "", url: "" });
      setAdding(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: McpServerView) => {
    await fetch("/api/mcp", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id, enabled: !s.enabled }) }).catch(() => undefined);
    void load();
  };

  const remove = async (id: string) => {
    await fetch(`/api/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    void load();
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mcp-dialog-title"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 pt-[8vh] backdrop-blur-sm max-md:items-stretch max-md:p-0"
          onClick={onClose}
        >
          <motion.div
            ref={cardRef}
            initial={reduce ? false : { y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: reduce ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="card-raised flex max-h-[calc(92dvh-1rem)] w-full max-w-[560px] flex-col overflow-hidden max-md:max-h-dvh max-md:max-w-none max-md:rounded-none max-md:border-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6 pb-4">
              <div className="min-w-0">
                <span className="eyebrow text-terracotta">{t("eyebrow")}</span>
                <h2 id="mcp-dialog-title" className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">{t("heading")}</h2>
                <p className="mt-1.5 text-sm text-ink-muted">{t("intro")}</p>
              </div>
              <button type="button" className="btn-quiet grid size-9 shrink-0 place-items-center rounded-full p-0 max-lg:size-11" aria-label={t("close")} data-initial-focus onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {!loaded && !error ? (
              <p role="status" className="py-3 text-sm text-placeholder">
                {t("loading")}
              </p>
            ) : null}
            {servers.length === 0 && loaded ? <p className="py-3 text-sm text-placeholder">{t("emptyList")}</p> : null}

            <ul className="flex flex-col divide-y divide-line">
              {servers.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", STATUS_DOT[s.status])} />
                      <span title={s.name} className="truncate font-display text-[15px] font-medium">{s.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-faint">{s.transport}</span>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={s.enabled}
                        aria-label={t("enabledAria", { name: s.name })}
                        onClick={() => void toggle(s)}
                        className={cn("min-h-8 rounded-full px-2.5 py-1 font-mono text-[11px] transition-colors max-lg:min-h-11 max-lg:min-w-11", s.enabled ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
                      >
                        {s.enabled ? t("on") : t("off")}
                      </button>
                      <button type="button" aria-label={t("removeServer", { name: s.name })} onClick={() => void remove(s.id)} className="grid size-8 place-items-center rounded-full text-faint hover:bg-pill hover:text-danger max-lg:size-11">
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-ink-muted" title={s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}>
                    {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}
                  </p>
                  {s.status === "error" ? <p className="font-mono text-[11px] text-danger">{s.error}</p> : null}
                  {s.tools.length > 0 ? (
                    <p className="flex flex-wrap gap-1">
                      {s.tools.map((t) => (
                        <span key={t.name} title={t.description} className="rounded-[6px] bg-pill px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
                          {t.name}
                          {t.readOnly ? "" : " ✳"}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>

            {adding ? (
              <div className="mt-4 flex flex-col gap-2 rounded-[14px] bg-paper-2 p-3 shadow-[var(--shadow-hairline)]">
                <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t("namePlaceholder")} className="field text-sm max-lg:min-h-11" autoFocus />
                <div className="flex gap-1.5">
                  {(["stdio", "http"] as const).map((transport) => (
                    <button
                      key={transport}
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, transport }))}
                      className={cn("min-h-8 rounded-full px-3 py-1 font-mono text-[11px] max-lg:min-h-11", draft.transport === transport ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted")}
                    >
                      {transport === "stdio" ? t("transportStdio") : t("transportHttp")}
                    </button>
                  ))}
                </div>
                {draft.transport === "stdio" ? (
                  <input value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="npx -y @modelcontextprotocol/server-filesystem /path" className="field font-mono text-xs max-lg:min-h-11" />
                ) : (
                  <input value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} placeholder="https://example.com/mcp" className="field font-mono text-xs max-lg:min-h-11" />
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-quiet h-8 rounded-full px-3.5 text-[13px] max-lg:min-h-11" onClick={() => setAdding(false)}>
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn-primary h-8 rounded-full px-4 text-[13px] max-lg:min-h-11" disabled={busy || !draft.name.trim() || (draft.transport === "stdio" ? !draft.command.trim() : !draft.url.trim())} onClick={() => void add()}>
                    {busy ? t("saving") : t("addServer")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] max-lg:min-h-11" onClick={() => setAdding(true)}>
                  <Plus className="size-3.5" /> {t("addServer")}
                </button>
                <button type="button" className="inline-flex min-h-8 items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-ink max-lg:min-h-11" onClick={recheck}>
                  <RefreshCw className={cn("size-3", spinning && "animate-spin")} /> {t("recheck")}
                </button>
              </div>
            )}

            {error ? <p className="mt-3 font-mono text-xs text-danger">{error}</p> : null}
            <p className="mt-4 text-[12px] leading-relaxed text-placeholder">{t("footnote")}</p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
