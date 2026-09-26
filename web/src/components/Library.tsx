"use client";

/* eslint-disable @next/next/no-img-element */
import { Download, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GalleryItem, JobOutput } from "@/lib/comfy/types";
import { viewUrl } from "@/lib/safelight-state";
import { ConfirmDelete } from "./ConfirmDelete";

/** Everything ever rendered, as a calm grid. Click a print for the full-size viewer. */
export function Library({ gallery, onUseAsInput, onDelete }: { gallery: GalleryItem[]; onUseAsInput: (o: JobOutput) => void; onDelete: (o: JobOutput) => Promise<void> }) {
  const [viewer, setViewer] = useState<GalleryItem | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  return (
    <section className="flex min-h-0 flex-col gap-5 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-ink">Library</h1>
        <span className="font-mono text-[12px] text-faint">
          {gallery.length} image{gallery.length === 1 ? "" : "s"}
        </span>
      </div>
      {gallery.length === 0 ? (
        <p className="py-16 text-center text-[14px] text-ink-muted">Nothing here yet. Renders from Image mode and chat land in the library automatically.</p>
      ) : (
        <div className="grid min-h-0 grid-cols-2 gap-3.5 overflow-y-auto pb-4 sm:grid-cols-3 xl:grid-cols-4">
          {gallery.map((it, i) => (
            <div key={`${it.subfolder}/${it.filename}`} className="develop group/g relative" style={{ animationDelay: `${Math.min(i, 16) * 35}ms` }}>
              <button type="button" onClick={() => setViewer(it)} className="block w-full overflow-hidden rounded-[18px] border border-line" aria-label={`Open ${it.filename}`}>
                <img src={viewUrl(it)} alt={it.filename} loading="lazy" className="aspect-square w-full object-cover transition-transform duration-300 group-hover/g:scale-[1.02]" />
              </button>
              <span className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition-opacity group-focus-within/g:opacity-100 group-hover/g:opacity-100">
                <button type="button" aria-label="Edit in Image" onClick={() => onUseAsInput(it)} className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-terracotta">
                  <Pencil className="size-3.5" />
                </button>
                <a aria-label="Save" href={viewUrl(it)} download={it.filename} className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-terracotta">
                  <Download className="size-3.5" />
                </a>
                <ConfirmDelete
                  filename={it.filename}
                  onConfirm={() => onDelete(it)}
                  trigger={
                    <button type="button" aria-label="Delete" className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-danger">
                      <Trash2 className="size-3.5" />
                    </button>
                  }
                />
              </span>
            </div>
          ))}
        </div>
      )}
      {viewer ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md" onClick={() => setViewer(null)}>
          <div className="flex items-center justify-between gap-3 px-6 py-4" onClick={(e) => e.stopPropagation()}>
            <p className="min-w-0 truncate font-mono text-xs text-ink-muted">{viewer.filename}</p>
            <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={() => setViewer(null)}>
              <X className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <img src={viewUrl(viewer)} alt={viewer.filename} className="max-h-full max-w-full rounded-[12px] object-contain shadow-[var(--shadow-raised)]" onClick={(e) => e.stopPropagation()} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
