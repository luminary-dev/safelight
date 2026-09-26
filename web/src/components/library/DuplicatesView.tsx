"use client";

/* eslint-disable @next/next/no-img-element */
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/i18n-format";
import { cn } from "@/lib/utils";
import { type DuplicateGroup, thumbUrl } from "./types";

/**
 * Near-duplicates, one group per row. Ticking prints feeds the shared selection,
 * so the normal bulk bar (export / delete) applies; "keep newest" ticks the rest.
 */
export function DuplicatesView({
  reloadKey,
  selected,
  onToggle,
  onSelectMany,
}: {
  reloadKey: number;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSelectMany: (paths: string[]) => void;
}) {
  const t = useTranslations("library.duplicates");
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let stale = false;
    Promise.resolve().then(() => !stale && setGroups(null));
    fetch("/api/library/duplicates")
      .then((r) => (r.ok ? (r.json() as Promise<{ groups: DuplicateGroup[] }>) : Promise.reject(new Error())))
      .then((d) => !stale && setGroups(d.groups))
      .catch(() => !stale && setError(true));
    return () => {
      stale = true;
    };
  }, [reloadKey]);

  if (error) return <p className="py-16 text-center font-mono text-xs text-danger">{t("scanFailed")}</p>;
  if (groups === null) return <p role="status" className="py-16 text-center text-[14px] text-ink-muted">{t("comparing")}</p>;
  if (groups.length === 0) return <p role="status" className="py-16 text-center text-[14px] text-ink-muted">{t("none")}</p>;

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4">
      {groups.map((g) => (
        <section key={g.items[0].path} className="rounded-[18px] border border-line bg-paper-2 p-4 shadow-[var(--shadow-hairline)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="font-mono text-[11px] text-faint">
              {t("groupSummary", { count: g.items.length, spread: g.spread })}
            </p>
            <button
              type="button"
              className="btn-quiet h-7 rounded-full px-3 font-mono text-[11px]"
              onClick={() => onSelectMany(g.items.slice(1).map((i) => i.path))}
            >
              {t("selectAllButNewest")}
            </button>
          </div>
          <div className="flex flex-wrap gap-3">
            {g.items.map((it) => {
              const on = selected.has(it.path);
              return (
                <button
                  key={it.path}
                  type="button"
                  onClick={() => onToggle(it.path)}
                  className={cn("group relative w-[140px] overflow-hidden rounded-[14px] border text-start transition-colors", on ? "border-terracotta" : "border-line")}
                  aria-pressed={on}
                  aria-label={t("selectAria", { path: it.path })}
                >
                  <img src={thumbUrl(it)} alt={it.path} loading="lazy" className="aspect-square w-full object-cover" />
                  <span className={cn("absolute start-2 top-2 grid size-5 place-items-center rounded-full border backdrop-blur", on ? "border-terracotta bg-terracotta text-paper-2" : "border-line bg-paper-2/90 text-transparent")}>
                    <Check className="size-3" />
                  </span>
                  <span className="block truncate px-2 py-1.5 font-mono text-[10px] text-ink-muted" title={it.path}>
                    {it.path.split("/").pop()} · {formatBytes(it.size)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
