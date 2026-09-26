"use client";

/* eslint-disable @next/next/no-img-element */
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fullUrl, type LibraryItem } from "./types";

/** Two prints on one easel: drag the divider to sweep between them. */
export function CompareView({ a, b, onClose }: { a: LibraryItem; b: LibraryItem; onClose: () => void }) {
  const [pct, setPct] = useState(50);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

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
    <div role="dialog" aria-modal="true" aria-label="Compare images" className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <p className="min-w-0 truncate font-mono text-xs text-ink-muted">
          <span className="text-ink">{a.path}</span> <span className="text-faint">vs</span> <span className="text-ink">{b.path}</span>
        </p>
        <button type="button" className="btn-quiet px-2" aria-label="Close compare" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 p-6 pt-0">
        <div
          ref={ref}
          className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-[18px] border border-line bg-shell"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            moveTo(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
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
          <span className="absolute left-3 top-3 rounded-full bg-paper-2/90 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted backdrop-blur">A</span>
          <span className="absolute right-3 top-3 rounded-full bg-paper-2/90 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted backdrop-blur">B</span>
        </div>
      </div>
    </div>
  );
}
