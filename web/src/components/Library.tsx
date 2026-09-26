"use client";

/* eslint-disable @next/next/no-img-element */
import { Check, Columns, Copy, Download, FolderOutput, Heart, Pencil, Search, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GalleryItem, JobOutput } from "@/lib/comfy/types";
import { cn } from "@/lib/utils";
import { ConfirmDelete } from "./ConfirmDelete";
import { CompareView } from "./library/CompareView";
import { DuplicatesView } from "./library/DuplicatesView";
import { Inspector } from "./library/Inspector";
import { LibraryGrid } from "./library/LibraryGrid";
import { fullUrl, type LibraryFacets, type LibraryItem, type LibraryResponse, thumbUrl, toJobOutput } from "./library/types";
import { useDialogFocus } from "./shell";

const PAGE = 120;
const SORTS = [
  { id: "newest", labelKey: "sortNewest" },
  { id: "oldest", labelKey: "sortOldest" },
  { id: "largest", labelKey: "sortLargest" },
] as const;
type Sort = (typeof SORTS)[number]["id"];

/**
 * The asset manager over everything ever rendered: indexed search, filters,
 * favorites, tags, compare, duplicates and bulk actions — reading the SQLite
 * index instead of walking outputs/ per request.
 */
export function Library({ gallery, onUseAsInput, onDelete }: { gallery: GalleryItem[]; onUseAsInput: (o: JobOutput) => void; onDelete: (o: JobOutput) => Promise<void> }) {
  const t = useTranslations("library");
  // ---------- filters ----------
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [tag, setTag] = useState("");
  const [fav, setFav] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [view, setView] = useState<"grid" | "duplicates">("grid");

  // ---------- data ----------
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<LibraryFacets>({ models: [], tags: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const reqSeq = useRef(0);
  const [dupReload, setDupReload] = useState(0);

  // ---------- selection & panels ----------
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [inspectPath, setInspectPath] = useState<string | null>(null);
  const [viewer, setViewer] = useState<LibraryItem | null>(null);
  const [comparing, setComparing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDest, setExportDest] = useState("");
  const [busy, setBusy] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  useDialogFocus(viewer !== null, viewerRef);
  useDialogFocus(exportOpen, exportRef);

  const inspect = useMemo(() => (inspectPath ? (items.find((i) => i.path === inspectPath) ?? null) : null), [items, inspectPath]);
  const comparePair = useMemo(() => {
    if (selected.length !== 2) return null;
    const a = items.find((i) => i.path === selected[0]);
    const b = items.find((i) => i.path === selected[1]);
    return a && b ? ([a, b] as const) : null;
  }, [selected, items]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => clearTimeout(t);
  }, [queryInput]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (model) p.set("model", model);
    if (tag) p.set("tag", tag);
    if (fav) p.set("fav", "1");
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("sort", sort);
    return p.toString();
  }, [query, model, tag, fav, from, to, sort]);

  const load = useCallback(
    async (offset: number) => {
      if (loadingRef.current && offset > 0) return;
      loadingRef.current = true;
      const seq = ++reqSeq.current;
      try {
        const res = await fetch(`/api/library?${params}&offset=${offset}&limit=${PAGE}`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as LibraryResponse;
        if (seq !== reqSeq.current) return;
        setItems((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
        setTotal(data.total);
        setFacets(data.facets);
        setError(null);
      } catch {
        if (seq === reqSeq.current) setError(t("loadFailed"));
      } finally {
        loadingRef.current = false;
      }
    },
    [params, t],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), 0);
    return () => clearTimeout(t);
  }, [load]);

  // New renders land via Safelight's gallery refresh — use it as an invalidation signal.
  const galleryStamp = `${gallery.length}:${gallery[0]?.mtime ?? 0}`;
  const stampRef = useRef(galleryStamp);
  useEffect(() => {
    if (stampRef.current === galleryStamp) return;
    stampRef.current = galleryStamp;
    // Give the debounced indexer a beat to pick the change up.
    const t = setTimeout(() => void load(0), 1200);
    return () => clearTimeout(t);
  }, [galleryStamp, load]);

  const onNeedMore = useCallback(() => {
    if (!loadingRef.current && items.length < total) void load(items.length);
  }, [items.length, total, load]);

  // ---------- item mutations ----------
  const patchItem = useCallback((path: string, patch: Partial<LibraryItem>) => {
    setItems((list) => list.map((i) => (i.path === path ? { ...i, ...patch } : i)));
  }, []);

  const toggleFavorite = useCallback(
    (item: LibraryItem) => {
      const next = item.favorite ? 0 : 1;
      patchItem(item.path, { favorite: next });
      void fetch("/api/library/fav", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: item.path, favorite: next === 1 }),
      }).catch(() => patchItem(item.path, { favorite: item.favorite }));
    },
    [patchItem],
  );

  const changeTags = useCallback(
    async (path: string, add?: string, remove?: string) => {
      const res = await fetch("/api/library/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, add, remove }),
      }).catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json()) as { tags: string[] };
      patchItem(path, { tags: data.tags });
    },
    [patchItem],
  );

  const removeLocal = useCallback((paths: string[]) => {
    const gone = new Set(paths);
    setItems((list) => list.filter((i) => !gone.has(i.path)));
    setTotal((t) => Math.max(0, t - paths.length));
    setSelected((s) => s.filter((p) => !gone.has(p)));
    setInspectPath((p) => (p && gone.has(p) ? null : p));
    setViewer((v) => (v && gone.has(v.path) ? null : v));
  }, []);

  const deleteOne = useCallback(
    async (item: LibraryItem) => {
      await onDelete(toJobOutput(item)); // Safelight also scrubs sessions referencing it
      removeLocal([item.path]);
      setDupReload((n) => n + 1);
    },
    [onDelete, removeLocal],
  );

  const toggleSelect = useCallback((path: string) => {
    setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));
  }, []);

  const selectMany = useCallback((paths: string[]) => {
    setSelected((s) => [...s, ...paths.filter((p) => !s.includes(p))]);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected([]);
    setSelecting(false);
  }, []);

  // ---------- bulk ----------
  const bulk = useCallback(
    async (action: "export" | "delete", dest?: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/library/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: selected, action, dest }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; exported?: number; deleted?: number; dest?: string };
        if (!res.ok) throw new Error(data.error ?? t("bulkFailed"));
        if (action === "export") {
          setNotice(t("exportedNotice", { count: data.exported ?? 0, dest: data.dest ?? "" }));
          setExportOpen(false);
        } else {
          setNotice(t("deletedNotice", { count: data.deleted ?? 0 }));
          removeLocal(selected);
          setDupReload((n) => n + 1);
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : t("bulkFailed"));
      } finally {
        setBusy(false);
      }
    },
    [selected, removeLocal, t],
  );

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExportOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportOpen]);

  // ---------- tiles ----------
  const renderTile = useCallback(
    (item: LibraryItem) => {
      const on = selectedSet.has(item.path);
      const open = () => (selecting ? toggleSelect(item.path) : setInspectPath(item.path));
      return (
        <div className={cn("group/g relative h-full w-full overflow-hidden rounded-[18px] border transition-colors", on ? "border-terracotta" : "border-line", inspectPath === item.path && !selecting && "border-line-strong")}>
          <button type="button" onClick={open} className="block h-full w-full" aria-label={selecting ? t("selectAria", { path: item.path }) : t("inspectAria", { path: item.path })} aria-pressed={selecting ? on : undefined}>
            <img src={thumbUrl(item)} alt={item.prompt ?? item.path} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover/g:scale-[1.02]" />
          </button>
          {selecting || on ? (
            <span className={cn("pointer-events-none absolute start-2.5 top-2.5 grid size-6 place-items-center rounded-full border backdrop-blur", on ? "border-terracotta bg-terracotta text-paper-2" : "border-line bg-paper-2/90 text-transparent")}>
              <Check className="size-3.5" />
            </span>
          ) : null}
          {item.favorite ? (
            <span className="pointer-events-none absolute bottom-2.5 start-2.5 grid size-6 place-items-center rounded-full bg-paper-2/90 text-terracotta backdrop-blur">
              <Heart className="size-3.5 fill-current" />
            </span>
          ) : null}
          {!selecting ? (
            <span className="absolute end-2.5 top-2.5 flex gap-1 opacity-0 transition-opacity group-focus-within/g:opacity-100 group-hover/g:opacity-100">
              <button
                type="button"
                aria-label={item.favorite ? t("unfavorite") : t("favorite")}
                onClick={() => toggleFavorite(item)}
                className={cn("grid size-7 place-items-center rounded-full bg-paper-2/90 shadow-[var(--shadow-hairline)] backdrop-blur", item.favorite ? "text-terracotta" : "text-ink hover:text-terracotta")}
              >
                <Heart className={cn("size-3.5", item.favorite && "fill-current")} />
              </button>
              <button type="button" aria-label={t("editInImage")} onClick={() => onUseAsInput(toJobOutput(item))} className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-terracotta">
                <Pencil className="size-3.5" />
              </button>
              <a aria-label={t("save")} href={fullUrl(item)} download={item.path.split("/").pop()} className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-terracotta">
                <Download className="size-3.5" />
              </a>
              <ConfirmDelete
                filename={item.path.split("/").pop() ?? item.path}
                onConfirm={() => deleteOne(item)}
                trigger={
                  <button type="button" aria-label={t("delete")} className="grid size-7 place-items-center rounded-full bg-paper-2/90 text-ink shadow-[var(--shadow-hairline)] backdrop-blur hover:text-danger">
                    <Trash2 className="size-3.5" />
                  </button>
                }
              />
            </span>
          ) : null}
        </div>
      );
    },
    [selectedSet, selecting, inspectPath, toggleSelect, toggleFavorite, onUseAsInput, deleteOne, t],
  );

  const topTags = facets.tags.slice(0, 10);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-ink">{t("heading")}</h1>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px] text-faint">
            {t("imageCount", { count: total })}
          </span>
          <div className="flex gap-1.5">
            {(["grid", "duplicates"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn("rounded-full px-3 py-1 font-mono text-[11px] transition-colors", view === v ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
              >
                {v === "grid" ? t("viewAll") : t("viewDuplicates")}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => (selecting ? clearSelection() : setSelecting(true))}
            className={cn("rounded-full px-3 py-1 font-mono text-[11px] transition-colors", selecting ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
          >
            {selecting ? t("done") : t("select")}
          </button>
        </div>
      </div>

      {view === "grid" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <input value={queryInput} onChange={(e) => setQueryInput(e.target.value)} placeholder={t("searchPlaceholder")} className="field h-9 w-[240px] rounded-full ps-8 text-[13px]" aria-label={t("searchAria")} />
          </span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="field h-9 w-auto max-w-[220px] rounded-full text-[12.5px]" aria-label={t("modelFilterAria")}>
            <option value="">{t("allModels")}</option>
            {facets.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.value} ({m.count})
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="field h-9 w-auto rounded-full text-[12.5px]" aria-label={t("sortAria")}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setFav((f) => !f)}
            className={cn("inline-flex h-9 items-center gap-1.5 rounded-full px-3 font-mono text-[11px] transition-colors", fav ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}
            aria-pressed={fav}
          >
            <Heart className={cn("size-3.5", fav && "fill-current")} /> {t("favorites")}
          </button>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field h-9 w-auto rounded-full text-[11.5px]" aria-label={t("fromDateAria")} />
            –
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field h-9 w-auto rounded-full text-[11.5px]" aria-label={t("toDateAria")} />
          </span>
          {topTags.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {topTags.map((tg) => (
                <button
                  key={tg.value}
                  type="button"
                  onClick={() => setTag((cur) => (cur === tg.value ? "" : tg.value))}
                  className={cn("rounded-full px-2.5 py-1 font-mono text-[10.5px] transition-colors", tag === tg.value ? "bg-terracotta-wash text-terracotta" : "bg-pill text-ink-muted hover:text-ink")}
                >
                  {t("tagWithCount", { tag: tg.value, count: tg.count })}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="font-mono text-xs text-danger">{error}</p> : null}
      {notice ? (
        <p role="status" className="flex items-center justify-between rounded-[12px] bg-pill px-3 py-2 font-mono text-[11.5px] text-ink-muted">
          {notice}
          <button type="button" aria-label={t("dismiss")} onClick={() => setNotice(null)} className="text-faint hover:text-ink">
            <X className="size-3.5" />
          </button>
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4">
        {view === "duplicates" ? (
          <DuplicatesView reloadKey={dupReload} selected={selectedSet} onToggle={(p) => { setSelecting(true); toggleSelect(p); }} onSelectMany={(p) => { setSelecting(true); selectMany(p); }} />
        ) : total === 0 && !error ? (
          <p className="flex-1 py-16 text-center text-[14px] text-ink-muted">
            {query || model || tag || fav || from || to ? t("emptyFiltered") : t("emptyNone")}
          </p>
        ) : (
          <LibraryGrid items={items} total={total} onNeedMore={onNeedMore} renderTile={renderTile} />
        )}
        {inspect && view === "grid" ? (
          <Inspector
            item={inspect}
            onClose={() => setInspectPath(null)}
            onOpenViewer={() => setViewer(inspect)}
            onToggleFavorite={() => toggleFavorite(inspect)}
            onAddTag={(t) => void changeTags(inspect.path, t)}
            onRemoveTag={(t) => void changeTags(inspect.path, undefined, t)}
            onUseAsInput={() => onUseAsInput(toJobOutput(inspect))}
            onDelete={() => deleteOne(inspect)}
          />
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-[16px] border border-line bg-paper-2 px-4 py-2.5 shadow-[var(--shadow-hairline)]">
          <span role="status" aria-live="polite" className="font-mono text-[12px] text-ink-muted">
            {t("selectedCount", { count: selected.length })}
          </span>
          <span className="flex items-center gap-1.5">
            <button type="button" disabled={selected.length !== 2 || !comparePair} onClick={() => setComparing(true)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] disabled:opacity-40">
              <Columns className="size-3.5" /> {t("compare")}
            </button>
            <button type="button" disabled={busy} onClick={() => setExportOpen(true)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] disabled:opacity-40">
              <FolderOutput className="size-3.5" /> {t("export")}
            </button>
            <ConfirmDelete
              filename={`${selected.length} images`}
              title={t("deleteManyTitle", { count: selected.length })}
              description={t("deleteManyDescription")}
              onConfirm={() => bulk("delete")}
              trigger={
                <button type="button" disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] text-danger hover:bg-danger-wash disabled:opacity-40">
                  <Trash2 className="size-3.5" /> {t("delete")}
                </button>
              }
            />
            <button type="button" onClick={clearSelection} className="inline-flex h-8 items-center gap-1 rounded-full px-3 font-mono text-[11px] text-faint hover:text-ink">
              <X className="size-3.5" /> {t("clear")}
            </button>
          </span>
        </div>
      ) : null}

      {viewer ? (
        <div ref={viewerRef} role="dialog" aria-modal="true" aria-label={t("viewerAria")} className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md" onClick={() => setViewer(null)}>
          <div className="flex items-center justify-between gap-3 px-6 py-4" onClick={(e) => e.stopPropagation()}>
            <p className="min-w-0 truncate font-mono text-xs text-ink-muted">{viewer.path}</p>
            <button type="button" className="btn-quiet px-2" aria-label={t("close")} onClick={() => setViewer(null)}>
              <X className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <img src={fullUrl(viewer)} alt={viewer.prompt ?? viewer.path} className="max-h-full max-w-full rounded-[12px] object-contain shadow-[var(--shadow-raised)]" onClick={(e) => e.stopPropagation()} />
          </div>
        </div>
      ) : null}

      {comparing && comparePair ? <CompareView a={comparePair[0]} b={comparePair[1]} onClose={() => setComparing(false)} /> : null}

      {exportOpen ? (
        <div role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 pt-[16vh] backdrop-blur-sm" onClick={() => setExportOpen(false)}>
          <div ref={exportRef} className="card-raised w-full max-w-[460px] p-6" onClick={(e) => e.stopPropagation()}>
            <span className="eyebrow text-terracotta">{t("exportEyebrow")}</span>
            <h2 id="export-dialog-title" className="mt-1.5 font-display text-xl font-normal tracking-[-0.02em]">
              {t("exportTitle", { count: selected.length })}
            </h2>
            <p className="mt-1.5 text-sm text-ink-muted">{t("exportBody")}</p>
            <input
              value={exportDest}
              onChange={(e) => setExportDest(e.target.value)}
              placeholder="/Users/you/Desktop/safelight-export"
              aria-label={t("destinationAria")}
              className="field mt-3 w-full font-mono text-xs"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && exportDest.trim() && void bulk("export", exportDest.trim())}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-quiet h-8 rounded-full px-3.5 text-[13px]" onClick={() => setExportOpen(false)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn-primary h-8 rounded-full px-4 text-[13px]" disabled={busy || !exportDest.trim()} onClick={() => void bulk("export", exportDest.trim())}>
                {busy ? t("copying") : <><Copy className="size-3.5" /> {t("export")}</>}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
