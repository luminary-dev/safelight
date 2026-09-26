"use client";

import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** How far the fade eats into each scrollable edge, in px. */
const FADE = 28;
/** One arrow-key press scrolls this many px. */
const STEP = 160;

/**
 * A deliberate horizontal scroll region (UI-RESPONSIVE-BRIEF §2): rows that must
 * stay one line (filmstrip, chips) scroll sideways instead of clipping. Edges
 * that hide content fade visibly, the strip is keyboard-focusable and scrolls
 * with the arrow keys, vertical wheel input is redirected sideways, and
 * `data-scroll-strip` + `tabindex` mark it for the audit tooling to whitelist.
 */
export function ScrollStrip({
  label,
  role = "region",
  step = STEP,
  className,
  children,
  ...rest
}: {
  /** Accessible name for the scroll region. */
  label: string;
  /** Landmark role; defaults to region. */
  role?: string;
  /** Arrow-key scroll distance in px. */
  step?: number;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-label" | "tabIndex" | "style" | "onScroll">) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Wheel must be a native non-passive listener so vertical spins can be
    // redirected sideways; React attaches wheel passively.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft = Math.max(0, el.scrollLeft + e.deltaY);
      e.preventDefault();
      measure();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      // Fires once on observe, then on every resize — keeps the fades honest.
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [measure]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? step : -step;
    if (typeof el.scrollBy === "function") el.scrollBy({ left: delta, behavior: "smooth" });
    else el.scrollLeft = Math.max(0, el.scrollLeft + delta);
    measure();
  };

  // Mask-based fades: content dims into the edge wherever more of it hides
  // beyond that edge, whatever the strip's background is.
  const mask =
    edges.start && edges.end
      ? `linear-gradient(to right, transparent, black ${FADE}px, black calc(100% - ${FADE}px), transparent)`
      : edges.start
        ? `linear-gradient(to right, transparent, black ${FADE}px)`
        : edges.end
          ? `linear-gradient(to right, black calc(100% - ${FADE}px), transparent)`
          : undefined;

  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={0}
      data-scroll-strip=""
      data-fade-start={edges.start ? "" : undefined}
      data-fade-end={edges.end ? "" : undefined}
      onScroll={measure}
      onKeyDown={onKeyDown}
      className={cn("flex overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta", className)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {children}
    </div>
  );
}
