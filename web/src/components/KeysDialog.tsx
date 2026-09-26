"use client";

import { Check, Eye, EyeOff as EyeSlash, Trash2 as Trash, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

export interface KeyStatus {
  provider: "openai" | "anthropic" | "gemini";
  label: string;
  configured: boolean;
  hint?: string;
  source?: "file" | "env";
  chat: boolean;
  images: boolean;
}

const HELP: Record<KeyStatus["provider"], { placeholder: string; url: string }> = {
  openai: { placeholder: "sk-…", url: "https://platform.openai.com/api-keys" },
  anthropic: { placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys" },
  gemini: { placeholder: "AIza…", url: "https://aistudio.google.com/apikey" },
};

export function KeysDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const reduce = useReducedMotion();
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ provider: string; ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/keys")
      .then((r) => r.json() as Promise<{ keys: KeyStatus[] }>)
      .then((d) => setKeys(d.keys))
      .catch(() => setError("Could not load key status."));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = async (provider: string, key: string | null) => {
    setBusy(provider);
    setError(null);
    setChecked(null);
    try {
      const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, key }) });
      const data = (await res.json()) as { keys?: KeyStatus[]; error?: string; validation?: { ok: boolean; message: string } };
      if (!res.ok || !data.keys) throw new Error(data.error ?? "Failed to save");
      setKeys(data.keys);
      setDrafts((d) => ({ ...d, [provider]: "" }));
      if (data.validation) setChecked({ provider, ...data.validation });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
          aria-label="API keys"
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
                <span className="eyebrow text-terracotta">API keys</span>
                <h2 className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">Connect cloud models</h2>
                <p className="mt-1.5 text-sm text-ink-muted">
                  Keys are stored on this machine in <code className="code">safelight/data/keys.json</code> and never sent to the browser.
                </p>
              </div>
              <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <ul className="flex flex-col divide-y divide-line">
              {keys.map((k) => (
                <li key={k.provider} className="flex flex-col gap-2.5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`h-[7px] w-[7px] rounded-full ${k.configured ? "bg-green" : "bg-line"}`} />
                      <span className="font-display text-[15px] font-medium">{k.label}</span>
                      <span className="font-mono text-[11px] text-faint">
                        {[k.chat ? "chat" : null, k.images ? "images" : null].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {k.configured ? (
                      <span className="font-mono text-[11px] text-ink-muted">
                        {k.source === "env" ? "from environment" : `key ${k.hint}`}
                      </span>
                    ) : (
                      <a href={HELP[k.provider].url} target="_blank" rel="noreferrer" className="font-mono text-[11px]">
                        Get a key
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
                        placeholder={k.configured ? "Paste a new key to replace" : HELP[k.provider].placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        className="field pr-9 font-mono text-xs"
                      />
                      <button
                        type="button"
                        aria-label={show[k.provider] ? "Hide key" : "Show key"}
                        onClick={() => setShow((s) => ({ ...s, [k.provider]: !s[k.provider] }))}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
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
                      <Check size={14} /> Save
                    </button>
                    {k.configured && k.source === "file" ? (
                      <button type="button" className="btn-quiet px-2.5" title="Remove key" disabled={busy === k.provider} onClick={() => void submit(k.provider, null)}>
                        <Trash size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {error ? <p className="mt-3 font-mono text-xs text-danger">{error}</p> : null}
            {checked ? <p className={`mt-3 font-mono text-xs ${checked.ok ? "text-green" : "text-danger"}`}>{checked.message}</p> : null}
            <p className="mt-4 text-[13px] leading-relaxed text-faint">
              OpenAI and Gemini add image models to Image mode. All three add chat models. Local models keep working without any key.
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
