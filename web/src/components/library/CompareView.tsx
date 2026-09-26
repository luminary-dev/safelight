"use client";

/* eslint-disable @next/next/no-img-element */
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "../shell";
import { fullUrl, type LibraryItem } from "./types";

/**
 * Below 768 a two-up sweep cannot work (each half would be ~180 px), so the
 * compare becomes a stacked A/B toggle (UI-RESPONSIVE-BRIEF §5 item 10 — the
 * "toggle A/B" option): one full-width easel plus two switch buttons.
 * matchMedia-driven so it tracks live window resizes.
 */
function useNarrowViewport(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const m = window.matchMedia("(max-width: 767px)");
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  }, []);
  const getSnapshot = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767px)").matches : false);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Two prints on one easel: drag the divider to sweep between them (stacked A/B toggle below 768). */
export function CompareView({ a, b, onClose }: { a: LibraryItem; b: LibraryItem; onClose: () => void }) {
  const t = useTranslations("library.compare");
  const [pct, setPct] = useState(50);
  const [shown, setShown] = useState<"a" | "b">("a");
  const narrow = useNarrowViewport();
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const moveTo = useCallback((clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPct(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("ariaDialog")} className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <p className="min-w-0 truncate font-mono text-xs text-ink-muted" title={`${a.path} ${t("vs")} ${b.path}`}>
          <span className="text-ink">{a.path}</span> <span className="text-faint">{t("vs")}</span> <span className="text-ink">{b.path}</span>
        </p>
        <button type="button" className="btn-quiet grid size-9 shrink-0 place-items-center rounded-full p-0 max-lg:size-11" aria-label={t("closeCompare")} onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {narrow ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-0">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[18px] border border-line bg-shell">
            <img src={fullUrl(shown === "a" ? a : b)} alt={(shown === "a" ? a : b).path} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
            <span className="absolute left-3 top-3 rounded-full bg-paper-2/90 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted backdrop-blur">{shown === "a" ? t("badgeA") : t("badgeB")}</span>
          </div>
          <div role="group" aria-label={t("abToggleAria")} className="flex shrink-0 justify-center gap-1.5">
            {(["a", "b"] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={shown === side}
                title={side === "a" ? a.path : b.path}
                onClick={() => setShown(side)}
                className={cn(
                  "min-h-11 min-w-24 rounded-full px-4 font-mono text-[12px] transition-colors",
                  shown === side ? "bg-terracotta-wash text-terracotta" : "border border-line text-ink-muted hover:text-ink",
                )}
              >
                {side === "a" ? t("showA") : t("showB")}
              </button>
            ))}
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 p-6 pt-0">
        <div
          ref={ref}
          role="slider"
          aria-label={t("divider")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          tabIndex={0}
          className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-[18px] border border-line bg-shell"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            moveTo(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              setPct((p) => Math.max(0, p - 5));
            } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              setPct((p) => Math.min(100, p + 5));
            } else if (e.key === "Home") {
              e.preventDefault();
              setPct(0);
            } else if (e.key === "End") {
              e.preventDefault();
              setPct(100);
            }
          }}
        >
          <img src={fullUrl(b)} alt={b.path} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
            <img src={fullUrl(a)} alt={a.path} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
          </div>
          <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pct}%` }}>
            <div className="absolute inset-y-0 -ml-px w-0.5 bg-terracotta" />
            <div className="absolute top-1/2 -ml-3.5 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-paper-2 font-mono text-[10px] text-terracotta shadow-[var(--shadow-raised)]">
              ⇔
            </div>
          </div>
          {/* The A/B badges and divider are pointer-driven physical geometry (clientX / clip-path), so they intentionally stay left/right rather than start/end. */}
          <span className="absolute left-3 top-3 rounded-full bg-paper-2/90 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted backdrop-blur">{t("badgeA")}</span>
          <span className="absolute right-3 top-3 rounded-full bg-paper-2/90 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted backdrop-blur">{t("badgeB")}</span>
        </div>
      </div>
      )}
    </div>
  );
}
