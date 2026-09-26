"use client";

import { ArrowLeft, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { BlueprintListEntry, BlueprintListResponse } from "@/lib/blueprints/types";
import { cn } from "@/lib/utils";
import { BlueprintRunner } from "./BlueprintRunner";

const CATEGORY_ORDER = ["image", "video", "audio", "3d", "utility"] as const;

/**
 * Every workflow the vendored ComfyUI ships, as a browsable catalog: what is ready to run
 * now, and exactly which models or nodes the rest are waiting on.
 */
export function BlueprintsWorkspace() {
  const t = useTranslations("blueprints");
  const [data, setData] = useState<BlueprintListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/blueprints")
      .then(async (r) => {
        const body = (await r.json()) as BlueprintListResponse & { error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(body.error ?? t("loadFailed"));
        setData(body);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : t("loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.blueprints ?? []).filter((b) => (!category || b.category === category) && (!q || b.name.toLowerCase().includes(q)));
  }, [data, query, category]);

  const grouped = useMemo(() => {
    const map = new Map<string, BlueprintListEntry[]>();
    for (const b of filtered) {
      const list = map.get(b.category) ?? [];
      list.push(b);
      map.set(b.category, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "ready" ? -1 : 1));
    return map;
  }, [filtered]);

  const open = openId ? (data?.blueprints ?? []).find((b) => b.id === openId) : null;
  const readyCount = data?.blueprints.filter((b) => b.status === "ready").length ?? 0;

  if (open) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <div className="mb-4 flex items-center gap-3">
          <button type="button" onClick={() => setOpenId(null)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px]">
            <ArrowLeft className="size-3.5" /> {t("back")}
          </button>
          <h1 className="font-display text-xl font-semibold tracking-[-0.01em] text-ink">{open.name}</h1>
          <span className="font-mono text-[11px] text-faint">{t(`category.${open.category}`)}</span>
        </div>
        <BlueprintRunner id={open.id} className="max-w-[720px]" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-1 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">{t("heading")}</h1>
          <p role="status" className="mt-1 text-sm text-ink-muted">
            {data ? t("summary", { count: data.blueprints.length, ready: readyCount }) : t("loading")}
            {data && !data.online ? t("offlineSuffix") : ""}
          </p>
        </div>
        <label className="flex w-[260px] items-center gap-2.5 rounded-[12px] bg-paper-2 px-3 py-2.5 shadow-[var(--shadow-hairline)]">
          <Search className="size-3.5 shrink-0 text-placeholder" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchAria")} className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-placeholder" />
        </label>
      </div>

      <div className="mb-4 mt-3 flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)} className={cn("rounded-full px-3 py-1 font-mono text-[11px]", category === null ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}>
          {t("all")}
        </button>
        {CATEGORY_ORDER.map((c) => (
          <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={cn("rounded-full px-3 py-1 font-mono text-[11px]", category === c ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink")}>
            {t(`category.${c}`)}
          </button>
        ))}
      </div>

      {error ? <p className="font-mono text-xs text-danger">{error}</p> : null}

      {[...grouped.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0] as (typeof CATEGORY_ORDER)[number]) - CATEGORY_ORDER.indexOf(b[0] as (typeof CATEGORY_ORDER)[number])).map(([cat, list]) => (
        <section key={cat} className="mb-6">
          <h2 className="form-label mb-2">{t(`category.${cat}`)}</h2>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {list.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(b.id)}
                  className="flex w-full flex-col gap-1.5 rounded-[14px] bg-paper-2 p-3.5 text-left shadow-[var(--shadow-hairline)] transition-colors hover:bg-pill/60"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-display text-[14.5px] font-medium text-ink">{b.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px]",
                        b.status === "ready" ? "bg-green-wash text-green" : b.status === "missing" ? "bg-pill text-ink-muted" : "bg-pill text-faint",
                      )}
                      style={b.status === "ready" ? { background: "var(--green-wash)" } : undefined}
                    >
                      {b.status === "ready" ? t("statusReady") : b.status === "missing" ? t("statusNeeds", { count: b.missingModels.length + b.missingNodeClasses.length }) : t("statusUnknown")}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-faint" title={b.status === "missing" ? [...b.missingModels, ...b.missingNodeClasses].join(", ") : undefined}>
                    {t("inputsSummary", { count: b.inputs.filter((i) => i.kind !== "number").length, outputs: b.outputTypes.join(", ").toLowerCase() || t("noOutput") })}
                    {b.status === "missing" && b.missingModels.length ? t("missingSuffix", { name: b.missingModels[0], more: b.missingModels.length - 1 }) : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data && filtered.length === 0 ? <p role="status" className="text-[13px] text-placeholder">{t("emptyFiltered")}</p> : null}
    </div>
  );
}
