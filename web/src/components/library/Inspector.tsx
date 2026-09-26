"use client";

/* eslint-disable @next/next/no-img-element */
import { Download, Heart, Maximize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { formatBytes, formatDate } from "@/lib/i18n-format";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "../ConfirmDelete";
import { fullUrl, type LibraryItem } from "./types";

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
      <dd className="min-w-0 truncate text-end font-mono text-[11.5px] text-ink" title={value}>
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
  const t = useTranslations("library.inspector");
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
    // ≥1024: a side column. <1024 (max-lg): a bottom drawer over the grid
    // instead of a squeezed side column (UI-RESPONSIVE-BRIEF §5 item 9).
    <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto rounded-[18px] border border-line bg-paper-2 p-4 shadow-[var(--shadow-hairline)] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:max-h-[60dvh] max-lg:w-auto max-lg:rounded-b-none max-lg:shadow-[var(--shadow-raised)]">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-[11.5px] leading-snug text-ink" title={item.path}>
          {filename}
        </p>
        <button type="button" className="btn-quiet grid size-8 shrink-0 place-items-center rounded-full p-0 max-lg:size-11" aria-label={t("closeInspector")} onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </div>

      <button type="button" onClick={onOpenViewer} className="group relative block shrink-0 overflow-hidden rounded-[14px] border border-line max-lg:mx-auto max-lg:w-40" aria-label={t("openFullSize", { filename })}>
        <img src={fullUrl(item)} alt={filename} className="aspect-square w-full object-cover" />
        {/* Hover affordance with a touch equivalent (§8): always visible at coarse pointers. */}
        <span className="absolute end-2 top-2 grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink opacity-0 shadow-[var(--shadow-hairline)] backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100">
          <Maximize2 className="size-3.5" />
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleFavorite}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-mono text-[11px] transition-colors max-lg:min-h-11", item.favorite ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
        >
          <Heart className={cn("size-3.5", item.favorite && "fill-current")} /> {item.favorite ? t("favorited") : t("favorite")}
        </button>
        <button type="button" onClick={onUseAsInput} aria-label={t("editInImage")} className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-terracotta max-lg:size-11">
          <Pencil className="size-3.5" />
        </button>
        <a href={fullUrl(item)} download={filename} aria-label={t("save")} className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-terracotta max-lg:size-11">
          <Download className="size-3.5" />
        </a>
        <ConfirmDelete
          filename={filename}
          onConfirm={onDelete}
          trigger={
            <button type="button" aria-label={t("delete")} className="grid size-8 place-items-center rounded-full border border-line text-ink-muted hover:text-danger max-lg:size-11">
              <Trash2 className="size-3.5" />
            </button>
          }
        />
      </div>

      {item.prompt ? <p className="rounded-[12px] bg-pill px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]">{item.prompt}</p> : null}

      <dl className="divide-y divide-line">
        {item.width && item.height ? <Row label={t("rowSize")} value={t("sizeWithDimensions", { width: item.width, height: item.height, size: formatBytes(item.size) })} /> : <Row label={t("rowSize")} value={formatBytes(item.size)} />}
        <Row label={t("rowModified")} value={formatDate(item.mtime)} />
        {item.model ? <Row label={t("rowModel")} value={item.model} /> : null}
        {modelMeta?.provider ? <Row label={t("rowProvider")} value={modelMeta.provider} /> : null}
        {modelMeta?.folder ? <Row label={t("rowFolder")} value={modelMeta.folder} /> : null}
        {item.seed !== null ? <Row label={t("rowSeed")} value={String(item.seed)} /> : null}
        {META_FIELDS.map((f) => {
          const v = meta[f];
          if (v === undefined || v === null || v === "") return null;
          return <Row key={f} label={t(`meta.${f}`)} value={f === "createdAt" && typeof v === "number" ? formatDate(v) : String(v)} />;
        })}
        {typeof meta.width === "number" && typeof meta.height === "number" ? <Row label={t("rowRequested")} value={t("dimensions", { width: meta.width, height: meta.height })} /> : null}
        {images.length > 0 ? <Row label={t("rowReferences")} value={images.join(", ")} /> : null}
      </dl>

      <div>
        <p className="mb-1.5 font-mono text-[11px] text-faint">{t("tags")}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.tags.map((tag) => (
            <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-full bg-pill px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
              <span className="min-w-0 truncate" title={tag}>{tag}</span>
              <button type="button" aria-label={t("removeTag", { tag })} onClick={() => onRemoveTag(tag)} className="grid size-6 shrink-0 place-items-center text-faint hover:text-danger max-lg:size-8">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitTag()}
              placeholder={t("addTagPlaceholder")}
              className="field h-6 w-20 rounded-full px-2 font-mono text-[10.5px] max-lg:min-h-11"
              aria-label={t("addTag")}
            />
            <button type="button" aria-label={t("addTag")} onClick={submitTag} className="grid size-6 place-items-center rounded-full border border-line text-faint hover:text-terracotta max-lg:size-11">
              <Plus className="size-3" />
            </button>
          </span>
        </div>
      </div>
    </aside>
  );
}
