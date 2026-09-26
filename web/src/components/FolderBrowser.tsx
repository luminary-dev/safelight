"use client";

import { ArrowUp, Check, Folder, FolderOpen, Home, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

/** A server-backed folder picker: browse the machine's directories and choose one as the workspace. */
export function FolderBrowser({ start, onPick }: { start?: string; onPick: (path: string) => void }) {
  const t = useTranslations("folderBrowser");
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target?: string) => {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/code/browse${target ? `?path=${encodeURIComponent(target)}` : ""}`).catch(() => null);
      setLoading(false);
      if (!res?.ok) {
        setError(t("cannotOpen"));
        return;
      }
      setListing((await res.json()) as Listing);
    },
    [t],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load(start || undefined);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className="btn-quiet gap-1.5 whitespace-nowrap" aria-label={t("browseAria")}>
          <FolderOpen className="size-3.5" /> {t("browse")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="glass w-[380px] gap-0 rounded-[16px] p-0 ring-0">
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-2.5">
          <button type="button" aria-label={t("home")} onClick={() => void load()} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-pill hover:text-ink">
            <Home className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("up")}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
            className="grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-pill hover:text-ink disabled:opacity-40"
          >
            <ArrowUp className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-muted" title={listing?.path}>
            {listing?.path ?? "…"}
          </span>
          {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" /> : null}
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1.5">
          {error ? <p className="px-3 py-4 text-[13px] text-danger">{error}</p> : null}
          {listing && listing.dirs.length === 0 && !error ? <p className="px-3 py-4 text-[13px] text-placeholder">{t("noSubfolders")}</p> : null}
          {listing?.dirs.map((d) => (
            <button key={d.path} type="button" onClick={() => void load(d.path)} className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13.5px] text-ink-muted transition-colors hover:bg-pill/60 hover:text-ink">
              <Folder className="size-4 shrink-0 text-placeholder" />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-line p-2.5">
          <button
            type="button"
            disabled={!listing}
            onClick={() => {
              if (!listing) return;
              onPick(listing.path);
              setOpen(false);
            }}
            className="btn-primary h-9 w-full rounded-[10px] text-[13.5px]"
          >
            <Check className="size-4" /> {t("useFolder")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
