"use client";

import { Download, KeyRound, Plug, Upload, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, clearTheme } from "@/lib/theme/apply";
import type { ThemeColors } from "@/lib/theme/contrast";
import { cn } from "@/lib/utils";

interface ThemeRow {
  name: string;
  data?: { colors?: ThemeColors; description?: string };
}

interface UsageSummary {
  totals?: { cost: number; inputTokens: number; outputTokens: number; images: number };
  byProvider?: Record<string, { cost: number }>;
}

interface RunRow {
  id: string;
  mode: string;
  provider: string;
  model: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}

const LIMIT_FIELDS = [
  { key: "spendLimitDaySoft", label: "Daily warning ($)" },
  { key: "spendLimitDayHard", label: "Daily stop ($)" },
  { key: "spendLimitMonthSoft", label: "Monthly warning ($)" },
  { key: "spendLimitMonthHard", label: "Monthly stop ($)" },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line py-4 first:border-t-0 first:pt-0">
      <h3 className="form-label">{title}</h3>
      {children}
    </section>
  );
}

/** One place for everything: keys, MCP, themes, spend limits, usage, privacy, backups. */
export function SettingsDialog({
  open,
  onClose,
  onOpenKeys,
  onOpenMcp,
  onLocalOnlyChange,
}: {
  open: boolean;
  onClose: () => void;
  onOpenKeys: () => void;
  onOpenMcp: () => void;
  onLocalOnlyChange?: (on: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [activeTheme, setActiveTheme] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null | "unavailable">(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    () =>
      Promise.all([
        fetch("/api/themes")
          .then((r) => r.json() as Promise<{ themes?: ThemeRow[]; active?: string | null }>)
          .then((d) => {
            setThemes(d.themes ?? []);
            setActiveTheme(d.active ?? null);
          })
          .catch(() => undefined),
        fetch("/api/settings")
          .then((r) => r.json() as Promise<{ settings?: Record<string, number | boolean> }>)
          .then((d) => {
            const all = d.settings ?? {};
            setLocalOnly(all.localOnly === true);
            setLimits(Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("spendLimit")).map(([k, v]) => [k, String(v)])));
          })
          .catch(() => undefined),
        fetch("/api/usage?days=30")
          .then(async (r): Promise<UsageSummary | "unavailable"> => (r.ok ? ((await r.json()) as UsageSummary) : "unavailable"))
          .then((d) => setUsage(d))
          .catch(() => setUsage("unavailable")),
        fetch("/api/runs?limit=8")
          .then((r) => (r.ok ? (r.json() as Promise<{ runs: RunRow[] }>) : Promise.reject(new Error())))
          .then((d) => setRuns(d.runs))
          .catch(() => undefined),
      ]),
    [],
  );

  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, load]);

  const saveLimits = async () => {
    const patch: Record<string, number | null> = {};
    for (const f of LIMIT_FIELDS) {
      const raw = (limits[f.key] ?? "").trim();
      patch[f.key] = raw === "" ? null : Number(raw);
      if (raw !== "" && (!Number.isFinite(patch[f.key]) || (patch[f.key] as number) < 0)) {
        setSavedNote(`${f.label} must be a non-negative number.`);
        return;
      }
    }
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    setSavedNote(res?.ok ? "Saved." : "Could not save limits.");
    setTimeout(() => setSavedNote(null), 2500);
  };

  const applyRow = async (t: ThemeRow) => {
    if (!t.data?.colors) return;
    await fetch(`/api/themes/${encodeURIComponent(t.name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply" }) }).catch(() => undefined);
    applyTheme(t.name, t.data.colors);
    setActiveTheme(t.name);
  };
  const clearRow = async (name: string) => {
    await fetch(`/api/themes/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear" }) }).catch(() => undefined);
    clearTheme();
    setActiveTheme(null);
  };

  const exportAll = async () => {
    const res = await fetch("/api/export").catch(() => null);
    if (!res?.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `safelight-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importAll = async (file: File) => {
    setImportNote(null);
    const text = await file.text();
    const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: text }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
    setImportNote(res?.ok ? "Imported. Reload to see everything." : (body.error ?? "Import failed."));
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 pt-[6vh] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={reduce ? false : { y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="card-raised w-full max-w-[620px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow text-terracotta">Settings</span>
                <h2 className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">Everything in one place</h2>
              </div>
              <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <Section title="Providers & connections">
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px]" onClick={onOpenKeys}>
                  <KeyRound className="size-3.5" /> API keys
                </button>
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px]" onClick={onOpenMcp}>
                  <Plug className="size-3.5" /> MCP servers
                </button>
              </div>
            </Section>

            <Section title="Appearance & themes">
              {themes.length === 0 ? <p className="text-[13px] text-placeholder">No saved themes yet — ask Design mode for one.</p> : null}
              <ul className="flex flex-col gap-1.5">
                {themes.map((t) => (
                  <li key={t.name} className="flex items-center gap-2.5">
                    <span className="flex gap-1">
                      {(["bg", "surface", "accent"] as const).map((c) => (
                        <span key={c} className="size-4 rounded-full border border-line" style={{ background: t.data?.colors?.[c] }} />
                      ))}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", activeTheme === t.name ? "font-medium text-ink" : "text-ink-muted")}>{t.name}</span>
                    {activeTheme === t.name ? (
                      <button type="button" className="btn-quiet h-7 rounded-full px-3 text-[12px]" onClick={() => void clearRow(t.name)}>
                        Reset
                      </button>
                    ) : (
                      <button type="button" className="btn-quiet h-7 rounded-full px-3 text-[12px]" onClick={() => void applyRow(t)}>
                        Apply
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Limits & spend">
              <div className="grid grid-cols-2 gap-2.5">
                {LIMIT_FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-[12px] text-ink-muted">
                    {f.label}
                    <input
                      inputMode="decimal"
                      value={limits[f.key] ?? ""}
                      onChange={(e) => setLimits((l) => ({ ...l, [f.key]: e.target.value }))}
                      placeholder="off"
                      className="field font-mono text-xs"
                    />
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button type="button" className="btn-primary h-8 rounded-full px-4 text-[13px]" onClick={() => void saveLimits()}>
                  Save limits
                </button>
                {savedNote ? <span className="font-mono text-[11px] text-ink-muted">{savedNote}</span> : null}
              </div>
              {usage && usage !== "unavailable" && usage.totals ? (
                <p className="font-mono text-[12px] text-ink-muted">
                  Last 30 days: ${usage.totals.cost.toFixed(2)} · {usage.totals.inputTokens.toLocaleString()} in / {usage.totals.outputTokens.toLocaleString()} out tokens · {usage.totals.images} images
                </p>
              ) : (
                <p className="text-[12px] text-placeholder">{usage === "unavailable" ? "The usage ledger is not available yet." : "Loading usage…"}</p>
              )}
            </Section>

            <Section title="Privacy">
              <div className="flex items-start justify-between gap-4">
                <p className="text-[13px] leading-relaxed text-ink-muted">
                  <span className="font-medium text-ink">Local only</span> — hard-disables every outbound call: cloud models, web search, page fetches, model downloads, key checks, and remote MCP servers. Local renders and Ollama keep working. Blocked attempts are listed in <code className="code">data/logs/</code>.
                </p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={localOnly}
                  onClick={async () => {
                    const next = !localOnly;
                    const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ localOnly: next ? true : null }) }).catch(() => null);
                    if (res?.ok) {
                      setLocalOnly(next);
                      onLocalOnlyChange?.(next);
                    }
                  }}
                  className={cn("shrink-0 rounded-full px-3.5 py-1.5 font-mono text-[12px] transition-colors", localOnly ? "bg-terracotta text-white" : "border border-line text-ink-muted hover:text-ink")}
                >
                  {localOnly ? "On" : "Off"}
                </button>
              </div>
            </Section>

            <Section title="Agent runs">
              {runs.length === 0 ? <p className="text-[13px] text-placeholder">No agent runs recorded yet.</p> : null}
              <ul className="flex flex-col gap-1">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2.5 font-mono text-[11.5px] text-ink-muted">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        r.status === "done" ? "bg-green" : r.status === "running" ? "bg-terracotta" : r.status === "error" ? "bg-danger" : "bg-line-strong",
                      )}
                    />
                    <span className="w-[52px] shrink-0">{r.mode}</span>
                    <span className="min-w-0 flex-1 truncate">{r.model}</span>
                    <span className="shrink-0">{r.finished_at ? `${Math.max(1, Math.round((r.finished_at - r.started_at) / 1000))}s` : r.status}</span>
                    <span className="shrink-0 text-faint">{new Date(r.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Logs">
              {logLines === null ? (
                <button
                  type="button"
                  className="btn-quiet h-8 self-start rounded-full px-3.5 text-[13px]"
                  onClick={() => {
                    void fetch("/api/logs?lines=100")
                      .then((r) => r.json() as Promise<{ lines: string[] }>)
                      .then((d) => setLogLines(d.lines))
                      .catch(() => setLogLines([]));
                  }}
                >
                  Show recent log
                </button>
              ) : (
                <pre className="max-h-[180px] overflow-auto rounded-[10px] bg-pill/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted">
                  {logLines.length ? logLines.join("\n") : "The log is empty."}
                </pre>
              )}
              <p className="text-[12px] text-placeholder">
                Structured, secret-redacted, rotating at 10 MB in <code className="code">data/logs/</code>.
              </p>
            </Section>

            <Section title="Backups & data">
              <p className="text-[13px] leading-relaxed text-ink-muted">
                Sessions, projects, themes and settings live in <code className="code">data/safelight.db</code>; the last 7 daily backups sit beside it. Keys stay encrypted and are never exported.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px]" onClick={() => void exportAll()}>
                  <Download className="size-3.5" /> Export everything
                </button>
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px]" onClick={() => fileRef.current?.click()}>
                  <Upload className="size-3.5" /> Import
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importAll(f);
                    e.target.value = "";
                  }}
                />
                {importNote ? <span className="font-mono text-[11px] text-ink-muted">{importNote}</span> : null}
              </div>
            </Section>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
