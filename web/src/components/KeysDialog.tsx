"use client";

import { Check, Eye, EyeOff as EyeSlash, Trash2 as Trash, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export interface KeyStatus {
  provider:
    | "openai" | "anthropic" | "gemini" | "openrouter" | "groq" | "mistral" | "deepseek" | "xai" | "together" | "cerebras" | "gateway"
    | "brave" | "tavily" | "hf" | "civitai";
  label: string;
  configured: boolean;
  hint?: string;
  source?: "vault" | "env";
  baseUrl?: string;
  chat: boolean;
  images: boolean;
  kind: "model" | "search" | "downloads";
}

// Key-format hints and console URLs — not translatable copy.
const HELP: Record<KeyStatus["provider"], { placeholder: string; url: string }> = {
  openai: { placeholder: "sk-…", url: "https://platform.openai.com/api-keys" },
  anthropic: { placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys" },
  gemini: { placeholder: "AIza…", url: "https://aistudio.google.com/apikey" },
  openrouter: { placeholder: "sk-or-…", url: "https://openrouter.ai/settings/keys" },
  groq: { placeholder: "gsk_…", url: "https://console.groq.com/keys" },
  mistral: { placeholder: "…", url: "https://console.mistral.ai/api-keys" },
  deepseek: { placeholder: "sk-…", url: "https://platform.deepseek.com/api_keys" },
  xai: { placeholder: "xai-…", url: "https://console.x.ai" },
  together: { placeholder: "…", url: "https://api.together.ai/settings/api-keys" },
  cerebras: { placeholder: "csk-…", url: "https://cloud.cerebras.ai/platform" },
  gateway: { placeholder: "vck_…", url: "https://vercel.com/dashboard/ai-gateway" },
  brave: { placeholder: "BSA…", url: "https://api-dashboard.search.brave.com/app/keys" },
  tavily: { placeholder: "tvly-…", url: "https://app.tavily.com/home" },
  hf: { placeholder: "hf_…", url: "https://huggingface.co/settings/tokens" },
  civitai: { placeholder: "…", url: "https://civitai.com/user/account" },
};



export function KeysDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("keysDialog");
  const reduce = useReducedMotion();
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ provider: string; ok: boolean; message: string } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [urlOpen, setUrlOpen] = useState<Record<string, boolean>>({});

  /** Base-URL-only update: key null + baseUrl set keeps the stored key and changes the endpoint. */
  const saveUrl = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, key: null, baseUrl: urls[provider] ?? "" }) });
      const data = (await res.json()) as { keys?: KeyStatus[]; error?: string };
      if (!res.ok || !data.keys) throw new Error(data.error ?? t("failedSaveUrl"));
      setKeys(data.keys);
      setUrlOpen((o) => ({ ...o, [provider]: false }));
      setUrls((u) => ({ ...u, [provider]: "" }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedSaveUrl"));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    fetch("/api/keys")
      .then((r) => r.json() as Promise<{ keys: KeyStatus[] }>)
      .then((d) => setKeys(d.keys))
      .catch(() => setError(t("loadFailed")));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, t]);

  const submit = async (provider: string, key: string | null) => {
    // A saved custom base URL must survive a key replacement.
    const keptUrl = key ? keys.find((k) => k.provider === provider)?.baseUrl : undefined;
    setBusy(provider);
    setError(null);
    setChecked(null);
    try {
      const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, key, ...(keptUrl ? { baseUrl: keptUrl } : {}) }) });
      const data = (await res.json()) as { keys?: KeyStatus[]; error?: string; validation?: { ok: boolean; message: string } };
      if (!res.ok || !data.keys) throw new Error(data.error ?? t("failedSave"));
      setKeys(data.keys);
      setDrafts((d) => ({ ...d, [provider]: "" }));
      if (data.validation) setChecked({ provider, ...data.validation });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedSave"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t("ariaLabel")}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 pt-[8vh] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={reduce ? false : { y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="card-raised w-full max-w-[560px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow text-terracotta">{t("eyebrow")}</span>
                <h2 className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">{t("heading")}</h2>
                <p className="mt-1.5 text-sm text-ink-muted">
                  {t.rich("intro", { code: (chunks) => <code className="code">{chunks}</code> })}
                </p>
              </div>
              <button type="button" className="btn-quiet px-2" aria-label={t("close")} onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            {([
              { kind: "model" as const, title: t("sectionModels") },
              { kind: "search" as const, title: t("sectionSearch") },
              { kind: "downloads" as const, title: t("sectionDownloads") },
            ]).map(({ kind, title }) => (
            <section key={kind}>
            <h3 className="form-label mt-4 first:mt-0">{title}</h3>
            <ul className="flex flex-col divide-y divide-line">
              {keys.filter((k) => k.kind === kind).map((k) => (
                <li key={k.provider} className="flex flex-col gap-2.5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`h-[7px] w-[7px] rounded-full ${k.configured ? "bg-green" : "bg-line"}`} />
                      <span className="font-display text-[15px] font-medium">{k.label}</span>
                      <span className="font-mono text-[11px] text-faint">
                        {k.kind === "search" ? t("capSearch") : k.kind === "downloads" ? t("capDownloads") : [k.chat ? t("capChat") : null, k.images ? t("capImages") : null].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {k.configured ? (
                      <span className="font-mono text-[11px] text-ink-muted">
                        {k.source === "env" ? t("fromEnv") : t("keyHint", { hint: k.hint ?? "" })}
                      </span>
                    ) : (
                      <a href={HELP[k.provider].url} target="_blank" rel="noreferrer" className="font-mono text-[11px]">
                        {t("getKey")}
                      </a>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={show[k.provider] ? "text" : "password"}
                        value={drafts[k.provider] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [k.provider]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (drafts[k.provider] ?? "").trim()) void submit(k.provider, drafts[k.provider]);
                        }}
                        placeholder={k.configured ? t("replacePlaceholder") : HELP[k.provider].placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        className="field pe-9 font-mono text-xs"
                      />
                      <button
                        type="button"
                        aria-label={show[k.provider] ? t("hideKey") : t("showKey")}
                        onClick={() => setShow((s) => ({ ...s, [k.provider]: !s[k.provider] }))}
                        className="absolute end-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
                      >
                        {show[k.provider] ? <EyeSlash size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn-ink"
                      disabled={busy === k.provider || !(drafts[k.provider] ?? "").trim()}
                      onClick={() => void submit(k.provider, drafts[k.provider])}
                    >
                      <Check size={14} /> {t("save")}
                    </button>
                    {k.configured && k.source === "vault" ? (
                      <button type="button" className="btn-quiet px-2.5" title={t("removeKey")} disabled={busy === k.provider} onClick={() => void submit(k.provider, null)}>
                        <Trash size={14} />
                      </button>
                    ) : null}
                  </div>
                  {k.kind !== "model" ? null : urlOpen[k.provider] ? (
                    <div className="flex gap-2">
                      <input
                        value={urls[k.provider] ?? k.baseUrl ?? ""}
                        onChange={(e) => setUrls((u) => ({ ...u, [k.provider]: e.target.value }))}
                        placeholder={t("baseUrlPlaceholder")}
                        autoComplete="off"
                        spellCheck={false}
                        className="field flex-1 font-mono text-xs"
                        aria-label={t("baseUrlAria", { label: k.label })}
                      />
                      <button type="button" className="btn-ink" disabled={busy === k.provider || !k.configured || k.source !== "vault"} onClick={() => void saveUrl(k.provider)}>
                        {t("saveUrl")}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="self-start font-mono text-[11px] text-faint hover:text-ink" onClick={() => setUrlOpen((o) => ({ ...o, [k.provider]: true }))}>
                      {k.baseUrl ? t("customUrl", { url: k.baseUrl }) : t("customUrlOpen")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            </section>
            ))}
            {error ? <p className="mt-3 font-mono text-xs text-danger">{error}</p> : null}
            {checked ? <p className={`mt-3 font-mono text-xs ${checked.ok ? "text-green" : "text-danger"}`}>{checked.message}</p> : null}
            <p className="mt-4 text-[13px] leading-relaxed text-faint">
              {t("footer")}
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
