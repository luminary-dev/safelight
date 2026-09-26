"use client";

import { type Ref, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Text that shrinks instead of widening its row (UI-RESPONSIVE-BRIEF §2).
 *
 * - `block` (default): `min-w-0` + `truncate` — a well-behaved flex child that
 *   ends in an ellipsis instead of pushing siblings off-screen.
 * - `inline-flex`: the same, for inline compositions (chips, labels next to icons).
 * - `wrap`: the multi-line variant — no ellipsis; instead `overflow-wrap:anywhere`
 *   gives auto-generated titles like `gemini_2026-09-24T20-23-56-06` a break
 *   opportunity so they can never widen the row.
 *
 * The full value is always exposed as `title`; when the visible text is actually
 * cut, it is also exposed as `aria-label` so the accessible name stays complete.
 */
export function TruncatedText({
  text,
  title,
  variant = "block",
  as,
  className,
}: {
  text: string;
  /** The full value for the tooltip; defaults to the text itself. */
  title?: string;
  variant?: "block" | "inline-flex" | "wrap";
  /** The rendered tag; defaults to span. */
  as?: "span" | "p" | "h1" | "h2" | "h3" | "div";
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);

  // Detect real truncation (scrollWidth beyond clientWidth) so aria-label only
  // appears when the visible text is actually cut. ResizeObserver fires once on
  // observe, so the initial state is measured without a synchronous setState.
  useEffect(() => {
    const el = ref.current;
    if (!el || variant === "wrap" || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const next = el.scrollWidth > el.clientWidth + 1;
      setCut((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, variant]);

  const full = title ?? text;
  const Tag = (as ?? "span") as "span";
  const shared = { title: full, "aria-label": cut ? full : undefined };

  if (variant === "inline-flex") {
    return (
      <Tag {...shared} className={cn("inline-flex min-w-0 max-w-full items-center", className)}>
        <span ref={ref as Ref<HTMLSpanElement>} className="min-w-0 truncate">
          {text}
        </span>
      </Tag>
    );
  }
  if (variant === "wrap") {
    return (
      <Tag {...shared} className={cn("block min-w-0 [overflow-wrap:anywhere]", className)}>
        {text}
      </Tag>
    );
  }
  return (
    <Tag ref={ref as Ref<HTMLSpanElement>} {...shared} className={cn("block min-w-0 truncate", className)}>
      {text}
    </Tag>
  );
}
