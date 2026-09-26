"use client";

import { Download, Search, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KIND_LABEL, SELECTABLE_KINDS, folderForKind, formatBytes } from "@/lib/models/kinds";
import { STARTER_PICKS } from "@/lib/models/registry";
import type { DownloadProgress, FileKind, RemoteFile, SearchResult } from "@/lib/models/types";
import { cn } from "@/lib/utils";

type Tab = "starter" | "search";
type Source = "hf" | "civitai";

interface DownloadView extends DownloadProgress {
  fileName: string;
}

const STATE_LABEL: Record<DownloadProgress["state"], string> = { downloading: "Downloading", done: "Done", error: "Failed", cancelled: "Cancelled" };

/** Browse and download models from Hugging Face and Civitai into the right models subfolder. */
export function ModelManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Tab>("starter");
  const [source, setSource] = useState<Source>("hf");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // For files whose kind is unknown, the user picks a target folder here (keyed by downloadUrl).
  const [kindChoice, setKindChoice] = useState<Record<string, FileKind>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/models/download");
      const data = (await res.json()) as { root: string; downloads: DownloadProgress[] };
      setRoot(data.root);
      setDownloads(data.downloads.map((d) => ({ ...d, fileName: d.file.split("/").pop() ?? d.file })).reverse());
    } catch {
      // Polling is best effort; the next tick retries.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // First tick via setTimeout keeps every setState asynchronous relative to the effect body.
    const first = setTimeout(() => void poll(), 0);
    pollRef.current = setInterval(() => void poll(), 1000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(first);
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, poll]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/models/search?q=${encodeURIComponent(q)}&source=${source}`);
      const data = (await res.json()) as { root?: string; results?: SearchResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      if (data.root) setRoot(data.root);
      setResults(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const start = async (file: RemoteFile) => {
    const kind = file.kind === "unknown" ? kindChoice[file.downloadUrl] : file.kind;
    if (!kind || kind === "unknown") {
      setError(`Pick a folder for ${file.name.split("/").pop()} first.`);
      return;
    }
    setError(null);
    try {
      const res = await fetch("/api/models/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: file.downloadUrl, fileName: file.name.split("/").pop(), kind, sizeBytes: file.sizeBytes, sha256: file.sha256 }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not start the download.");
      void poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the download.");
    }
  };

  const cancel = async (id: string) => {
    await fetch(`/api/models/download?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    void poll();
  };

  const busyFiles = new Set(downloads.filter((d) => d.state === "downloading").map((d) => d.fileName));

  const fileRow = (file: RemoteFile) => {
    const kind = file.kind === "unknown" ? (kindChoice[file.downloadUrl] ?? "unknown") : file.kind;
    const folder = folderForKind(kind);
    const shortName = file.name.split("/").pop() ?? file.name;
    return (
      <div key={file.downloadUrl} className="flex items-center justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11.5px]" title={file.name}>
            {shortName}
          </p>
          <p className="font-mono text-[10.5px] text-faint">
            {formatBytes(file.sizeBytes)}
            {file.sha256 ? " · sha256 ✓" : ""}
            {folder ? ` · → ${folder}/` : ""}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {file.kind === "unknown" ? (
            <select
              aria-label={`Folder for ${shortName}`}
              className="field h-7 rounded-full px-2 font-mono text-[10.5px]"
              value={kindChoice[file.downloadUrl] ?? ""}
              onChange={(e) => setKindChoice((m) => ({ ...m, [file.downloadUrl]: e.target.value as FileKind }))}
            >
              <option value="" disabled>
                Folder…
              </option>
              {SELECTABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="btn-quiet inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11.5px]"
            disabled={busyFiles.has(shortName)}
            onClick={() => void start(file)}
          >
            <Download className="size-3" /> {busyFiles.has(shortName) ? "Downloading…" : "Download"}
          </button>
        </span>
      </div>
    );
  };

  const resultRow = (r: SearchResult, whatFor?: string, note?: string) => (
    <li key={`${r.source}:${r.id}`} className="flex flex-col gap-1 py-4">
      <div className="flex items-center gap-2">
        <span className="truncate font-display text-[15px] font-medium">{r.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-faint">{r.source === "hf" ? "Hugging Face" : r.source === "civitai" ? "Civitai" : "curated"}</span>
        {r.nsfw ? <span className="shrink-0 rounded-[6px] bg-pill px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">NSFW</span> : null}
      </div>
      {whatFor ? <p className="text-[12.5px] leading-relaxed text-ink">{whatFor}</p> : null}
      {r.description ? <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{r.description}</p> : null}
      {note ? <p className="font-mono text-[11px] text-placeholder">{note}</p> : <div className="mt-0.5 flex flex-col divide-y divide-line">{r.files.map(fileRow)}</div>}
    </li>
  );

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Model manager"
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
            className="card-raised w-full max-w-[640px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow text-terracotta">Model manager</span>
                <h2 className="mt-1.5 font-display text-2xl font-normal tracking-[-0.02em]">Get models</h2>
                <p className="mt-1.5 text-sm text-ink-muted">Downloads land in the right models folder automatically, with checksum verification and a disk-space check.</p>
              </div>
              <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className="flex gap-1.5">
              {(["starter", "search"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn("rounded-full px-3 py-1 font-mono text-[11px]", tab === t ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
                >
                  {t === "starter" ? "Starter picks" : "Search"}
                </button>
              ))}
            </div>

            {tab === "search" ? (
              <div className="mt-4 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void search()}
                    placeholder={source === "hf" ? "Search Hugging Face (GGUF)…" : "Search Civitai…"}
                    className="field flex-1 text-sm"
                    autoFocus
                  />
                  <button type="button" className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px]" disabled={searching || !query.trim()} onClick={() => void search()}>
                    <Search className="size-3.5" /> {searching ? "Searching…" : "Search"}
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {(["hf", "civitai"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setSource(s);
                        setResults(null);
                      }}
                      className={cn("rounded-full px-3 py-1 font-mono text-[11px]", source === s ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted")}
                    >
                      {s === "hf" ? "Hugging Face" : "Civitai"}
                    </button>
                  ))}
                </div>
                {results && results.length === 0 ? <p className="py-3 text-sm text-placeholder">Nothing found — try another spelling or the other source.</p> : null}
                <ul className="flex flex-col divide-y divide-line">{results?.map((r) => resultRow(r))}</ul>
              </div>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-line">{STARTER_PICKS.map((p) => resultRow(p, p.whatFor, p.note))}</ul>
            )}

            {downloads.length > 0 ? (
              <div className="mt-5 border-t border-line pt-4">
                <span className="eyebrow">Downloads</span>
                <ul className="mt-2 flex flex-col gap-3">
                  {downloads.map((d) => (
                    <li key={d.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-mono text-[11.5px]" title={d.file}>
                          {d.fileName}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className={cn("font-mono text-[10.5px]", d.state === "error" ? "text-danger" : "text-ink-muted")}>
                            {d.state === "downloading" ? `${formatBytes(d.received)} / ${formatBytes(d.total)}` : STATE_LABEL[d.state]}
                          </span>
                          <button type="button" aria-label={d.state === "downloading" ? `Cancel ${d.fileName}` : `Clear ${d.fileName}`} onClick={() => void cancel(d.id)} className="grid size-6 place-items-center rounded-full text-faint hover:bg-pill hover:text-danger">
                            <X className="size-3" />
                          </button>
                        </span>
                      </div>
                      {d.state === "downloading" ? (
                        <div className="h-1 overflow-hidden rounded-full bg-pill">
                          <div
                            className="h-full rounded-full bg-terracotta transition-[width] duration-300"
                            style={{ width: d.total ? `${Math.min(100, (d.received / d.total) * 100).toFixed(1)}%` : "100%" }}
                          />
                        </div>
                      ) : null}
                      {d.error ? <p className="font-mono text-[11px] text-danger">{d.error}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {error ? <p className="mt-3 font-mono text-xs text-danger">{error}</p> : null}
            <p className="mt-4 text-[12px] leading-relaxed text-placeholder">
              {root ? (
                <>
                  Models are saved under <span className="font-mono text-[11px]">{root}</span> where the render engine finds them.
                </>
              ) : (
                "Models are saved where the render engine finds them."
              )}
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
