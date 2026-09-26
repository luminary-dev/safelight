"use client";

/* eslint-disable @next/next/no-img-element */
import { Download, Heart, Maximize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "../ConfirmDelete";
import { fmtDate, fmtSize, fullUrl, type LibraryItem } from "./types";

/** Every sidecar field the render wrote, in display order. */
const META_FIELDS = ["mode", "negativePrompt", "sampler", "scheduler", "steps", "cfg", "denoise", "createdAt"] as const;

function metaOf(item: LibraryItem): Record<string, unknown> {
  try {
    const parsed = item.meta ? (JSON.parse(item.meta) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 font-mono text-[11px] text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[11.5px] text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** Side panel: the print's full provenance, tags, and per-item actions. */
export function Inspector({
  item,
  onClose,
  onOpenViewer,
  onToggleFavorite,
  onAddTag,
  onRemoveTag,
  onUseAsInput,
  onDelete,
}: {
  item: LibraryItem;
  onClose: () => void;
  onOpenViewer: () => void;
  onToggleFavorite: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onUseAsInput: () => void;
  onDelete: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const meta = useMemo(() => metaOf(item), [item]);
  const filename = item.path.split("/").pop() ?? item.path;
  const modelMeta = meta.model as { name?: string; folder?: string; provider?: string } | undefined;
  const images = Array.isArray(meta.images) ? (meta.images as unknown[]).filter((i): i is string => typeof i === "string") : [];

  const submitTag = () => {
    const t = draft.trim();
    if (!t) return;
    onAddTag(t);
    setDraft("");
  };

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto rounded-[18px] border border-line bg-paper-2 p-4 shadow-[var(--shadow-hairline)]">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-[11.5px] leading-snug text-ink" title={item.path}>
          {filename}
        </p>
        <button type="button" className="btn-quiet px-1.5" aria-label="Close inspector" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </div>

      <button type="button" onClick={onOpenViewer} className="group relative block overflow-hidden rounded-[14px] border border-line" aria-label={`Open ${filename} full size`}>
        <img src={fullUrl(item)} alt={filename} className="aspect-square w-full object-cover" />
        <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink opacity-0 shadow-[var(--shadow-hairline)] backdrop-blur transition-opacity group-hover:opacity-100">
          <Maximize2 className="size-3.5" />
        </span>
      </button>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleFavorite}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-mono text-[11px] transition-colors", item.favorite ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
        >
          <Heart className={cn("size-3.5", item.favorite && "fill-current")} /> {item.favorite ? "Favorited" : "Favorite"}
        </button>
        <button type="button" onClick={onUseAsInput} aria-label="Edit in Image" className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-terracotta">
          <Pencil className="size-3.5" />
        </button>
        <a href={fullUrl(item)} download={filename} aria-label="Save" className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-terracotta">
          <Download className="size-3.5" />
        </a>
        <ConfirmDelete
          filename={filename}
          onConfirm={onDelete}
          trigger={
            <button type="button" aria-label="Delete" className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-danger">
              <Trash2 className="size-3.5" />
            </button>
          }
        />
      </div>

      {item.prompt ? <p className="rounded-[12px] bg-pill px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">{item.prompt}</p> : null}

      <dl className="divide-y divide-line">
        {item.width && item.height ? <Row label="size" value={`${item.width} × ${item.height} · ${fmtSize(item.size)}`} /> : <Row label="size" value={fmtSize(item.size)} />}
        <Row label="modified" value={fmtDate(item.mtime)} />
        {item.model ? <Row label="model" value={item.model} /> : null}
        {modelMeta?.provider ? <Row label="provider" value={modelMeta.provider} /> : null}
        {modelMeta?.folder ? <Row label="folder" value={modelMeta.folder} /> : null}
        {item.seed !== null ? <Row label="seed" value={String(item.seed)} /> : null}
        {META_FIELDS.map((f) => {
          const v = meta[f];
          if (v === undefined || v === null || v === "") return null;
          return <Row key={f} label={f} value={f === "createdAt" && typeof v === "number" ? fmtDate(v) : String(v)} />;
        })}
        {typeof meta.width === "number" && typeof meta.height === "number" ? <Row label="requested" value={`${meta.width} × ${meta.height}`} /> : null}
        {images.length > 0 ? <Row label="references" value={images.join(", ")} /> : null}
      </dl>

      <div>
        <p className="mb-1.5 font-mono text-[11px] text-faint">tags</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-pill px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
              {t}
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onRemoveTag(t)} className="text-faint hover:text-danger">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitTag()}
              placeholder="add tag"
              className="field h-6 w-20 rounded-full px-2 font-mono text-[10.5px]"
              aria-label="Add tag"
            />
            <button type="button" aria-label="Add tag" onClick={submitTag} className="grid size-6 place-items-center rounded-full border border-line text-faint hover:text-terracotta">
              <Plus className="size-3" />
            </button>
          </span>
        </div>
      </div>
    </aside>
  );
}
