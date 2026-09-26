"use client";

import { Download, KeyRound, Plug, Upload, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber, formatTime } from "@/lib/i18n-format";
import { applyTheme, clearTheme, type ThemeFonts } from "@/lib/theme/apply";
import type { ThemeColors } from "@/lib/theme/contrast";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "./shell";

interface ThemeRow {
  name: string;
  data?: { colors?: ThemeColors; description?: string; fonts?: ThemeFonts };
}

interface UsageSummary {
  totals?: { cost: number; inputTokens: number; outputTokens: number; images: number };
  byProvider?: Record<string, { cost: number }>;
}

// Field names match /api/runs (camelCase); the previous snake_case shape never
// matched the payload and rendered "Invalid Date" in the runs list.
interface RunRow {
  id: string;
  mode: string;
  provider: string;
  model: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
}

const LIMIT_FIELDS = [
  { key: "spendLimitDaySoft", labelKey: "limitDaySoft" },
  { key: "spendLimitDayHard", labelKey: "limitDayHard" },
  { key: "spendLimitMonthSoft", labelKey: "limitMonthSoft" },
  { key: "spendLimitMonthHard", labelKey: "limitMonthHard" },
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
  const t = useTranslations("settingsDialog");
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
  const cardRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, cardRef);

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
        setSavedNote(t("limitInvalid", { label: t(f.labelKey) }));
        return;
      }
    }
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    setSavedNote(res?.ok ? t("saved") : t("saveLimitsFailed"));
    setTimeout(() => setSavedNote(null), 2500);
  };

  const applyRow = async (row: ThemeRow) => {
    if (!row.data?.colors) return;
    await fetch(`/api/themes/${encodeURIComponent(row.name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply" }) }).catch(() => undefined);
    applyTheme(row.name, row.data.colors, row.data.fonts);
    setActiveTheme(row.name);
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
    setImportNote(res?.ok ? t("imported") : (body.error ?? t("importFailed")));
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 pt-[6vh] backdrop-blur-sm max-md:items-stretch max-md:p-0"
          onClick={onClose}
        >
          <motion.div
            ref={cardRef}
            initial={reduce ? false : { y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: reduce ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="card-raised flex max-h-[calc(94dvh-1rem)] w-full max-w-[620px] flex-col overflow-hidden max-md:max-h-dvh max-md:max-w-none max-md:rounded-none max-md:border-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6 pb-4">
              <div className="min-w-0">
                <span className="eyebrow text-terracotta">{t("eyebrow")}</span>
                <h2 id="settings-dialog-title" className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">{t("heading")}</h2>
              </div>
              <button type="button" className="btn-quiet grid size-9 shrink-0 place-items-center rounded-full p-0 max-lg:size-11" aria-label={t("close")} data-initial-focus onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <Section title={t("sectionProviders")}>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] max-lg:min-h-11" onClick={onOpenKeys}>
                  <KeyRound className="size-3.5" /> {t("apiKeys")}
                </button>
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] max-lg:min-h-11" onClick={onOpenMcp}>
                  <Plug className="size-3.5" /> {t("mcpServers")}
                </button>
              </div>
            </Section>

            <Section title={t("sectionAppearance")}>
              {themes.length === 0 ? <p className="text-[13px] text-placeholder">{t("noThemes")}</p> : null}
              <ul className="flex flex-col gap-1.5">
                {themes.map((row) => (
                  <li key={row.name} className="flex items-center gap-2.5">
                    <span className="flex gap-1">
                      {(["bg", "surface", "accent"] as const).map((c) => (
                        <span key={c} className="size-4 rounded-full border border-line" style={{ background: row.data?.colors?.[c] }} />
                      ))}
                    </span>
                    <span title={row.name} className={cn("min-w-0 flex-1 truncate text-[13.5px]", activeTheme === row.name ? "font-medium text-ink" : "text-ink-muted")}>{row.name}</span>
                    {activeTheme === row.name ? (
                      <button type="button" className="btn-quiet h-8 rounded-full px-3 text-[12px] max-lg:min-h-11" onClick={() => void clearRow(row.name)}>
                        {t("reset")}
                      </button>
                    ) : (
                      <button type="button" className="btn-quiet h-8 rounded-full px-3 text-[12px] max-lg:min-h-11" onClick={() => void applyRow(row)}>
                        {t("apply")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title={t("sectionLimits")}>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {LIMIT_FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-[12px] text-ink-muted">
                    {t(f.labelKey)}
                    <input
                      inputMode="decimal"
                      value={limits[f.key] ?? ""}
                      onChange={(e) => setLimits((l) => ({ ...l, [f.key]: e.target.value }))}
                      placeholder={t("limitOff")}
                      className="field font-mono text-xs max-lg:min-h-11"
                    />
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button type="button" className="btn-primary h-8 rounded-full px-4 text-[13px] max-lg:min-h-11" onClick={() => void saveLimits()}>
                  {t("saveLimits")}
                </button>
                {savedNote ? <span role="status" className="font-mono text-[11px] text-ink-muted">{savedNote}</span> : null}
              </div>
              {usage && usage !== "unavailable" && usage.totals ? (
                <p className="font-mono text-[12px] text-ink-muted">
                  {t("usageLine", {
                    cost: formatNumber(usage.totals.cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                    input: formatNumber(usage.totals.inputTokens),
                    output: formatNumber(usage.totals.outputTokens),
                    images: usage.totals.images,
                  })}
                </p>
              ) : (
                <p className="text-[12px] text-placeholder">{usage === "unavailable" ? t("usageUnavailable") : t("usageLoading")}</p>
              )}
            </Section>

            <Section title={t("sectionPrivacy")}>
              <div className="flex items-start justify-between gap-4">
                <p className="text-[13px] leading-relaxed text-ink-muted">
                  {t.rich("privacyBody", {
                    b: (chunks) => <span className="font-medium text-ink">{chunks}</span>,
                    code: (chunks) => <code className="code">{chunks}</code>,
                  })}
                </p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={localOnly}
                  aria-label={t("localOnlyAria")}
                  onClick={async () => {
                    const next = !localOnly;
                    const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ localOnly: next ? true : null }) }).catch(() => null);
                    if (res?.ok) {
                      setLocalOnly(next);
                      onLocalOnlyChange?.(next);
                    }
                  }}
                  className={cn("min-h-8 shrink-0 rounded-full px-3.5 py-1.5 font-mono text-[12px] transition-colors max-lg:min-h-11 max-lg:min-w-11", localOnly ? "bg-terracotta text-white" : "border border-line text-ink-muted hover:text-ink")}
                >
                  {localOnly ? t("on") : t("off")}
                </button>
              </div>
            </Section>

            <Section title={t("sectionRuns")}>
              {runs.length === 0 ? <p className="text-[13px] text-placeholder">{t("noRuns")}</p> : null}
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
                    <span title={r.model} className="min-w-0 flex-1 truncate">{r.model}</span>
                    <span className="shrink-0">{r.finishedAt ? t("runSeconds", { seconds: Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000)) }) : r.status}</span>
                    <span className="shrink-0 text-faint">{formatTime(r.startedAt)}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title={t("sectionLogs")}>
              {logLines === null ? (
                <button
                  type="button"
                  className="btn-quiet h-8 self-start rounded-full px-3.5 text-[13px] max-lg:min-h-11"
                  onClick={() => {
                    void fetch("/api/logs?lines=100")
                      .then((r) => r.json() as Promise<{ lines: string[] }>)
                      .then((d) => setLogLines(d.lines))
                      .catch(() => setLogLines([]));
                  }}
                >
                  {t("showLog")}
                </button>
              ) : (
                <pre className="max-h-[180px] overflow-auto rounded-[10px] bg-pill/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted">
                  {logLines.length ? logLines.join("\n") : t("logEmpty")}
                </pre>
              )}
              <p className="text-[12px] text-placeholder">
                {t.rich("logsNote", { code: (chunks) => <code className="code">{chunks}</code> })}
              </p>
            </Section>

            <Section title={t("sectionBackups")}>
              <p className="text-[13px] leading-relaxed text-ink-muted">
                {t.rich("backupsBody", { code: (chunks) => <code className="code">{chunks}</code> })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] max-lg:min-h-11" onClick={() => void exportAll()}>
                  <Download className="size-3.5" /> {t("exportAll")}
                </button>
                <button type="button" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] max-lg:min-h-11" onClick={() => fileRef.current?.click()}>
                  <Upload className="size-3.5" /> {t("import")}
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
                {importNote ? <span role="status" className="font-mono text-[11px] text-ink-muted">{importNote}</span> : null}
              </div>
            </Section>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
