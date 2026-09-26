import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type TopMode = "chat" | "image" | "code" | "design" | "library" | "blueprints";

/**
 * The layout contract's named breakpoints (UI-RESPONSIVE-BRIEF §3) — named by
 * what changes, not by device. Each value is the range's lower bound in CSS px.
 */
export const SHELL_BREAKPOINTS = {
  /** ≥1440 — rail + composer + stage side by side, room for every inline action. */
  full: 1440,
  /** 1280–1439 — same three regions; toolbars may begin collapsing (measured, in <ActionBar>). */
  dense: 1280,
  /** 1024–1279 — narrower rail, tighter gutters; stage actions collapse to primary + More. */
  compact: 1024,
  /** 768–1023 — the rail becomes a sheet behind the header trigger; composer and stage stack. */
  stacked: 768,
  /** <768 — a single column, one region at a time. */
  single: 0,
} as const;

/**
 * The region grid implementing those breakpoints. Below `compact` (lg) the grid
 * is a single column of header-then-content rows and the rail lives in a sheet;
 * from `compact` the rail sits beside the main panel (248px, tight gutters);
 * from `dense` (xl) the rail and gutters return to their full measurements.
 */
export const shellGridClass = cn(
  "grid min-h-[100dvh] grid-cols-1 grid-rows-[auto_1fr] gap-3.5 bg-shell p-3.5 font-sans",
  "lg:h-[100dvh] lg:grid-cols-[248px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-3 lg:p-3",
  "xl:grid-cols-[268px_minmax(0,1fr)] xl:gap-3.5 xl:p-3.5",
);

/** The app shell: the region grid the Sidebar (rail/header/sheet) and main panel live in. */
export function Shell({ children }: { children: ReactNode }) {
  return <div className={shellGridClass}>{children}</div>;
}

/**
 * The stacked-layout header (visible below the `compact` breakpoint): the
 * wordmark plus whatever trigger the rail owner renders — the sheet toggle.
 */
export function ShellHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="panel-side flex items-center justify-between gap-3 px-4 py-2 lg:hidden">
      <span className="flex items-center gap-2">
        <SafelightMark className="size-6 rounded-[8px]" />
        <span className="font-display text-[19px] font-extrabold tracking-[-0.02em] text-ink">
          Safelight<span className="text-terracotta">.</span>
        </span>
      </span>
      {children}
    </header>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for the hand-rolled dialogs: on open, focus moves inside
 * (an element marked data-initial-focus, else the first focusable one — unless
 * an autoFocus field already claimed it); Tab is trapped within the container;
 * on close, focus returns to the element that opened the dialog.
 */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>) {
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Next tick, so a field with autoFocus mounts (and wins) first.
    const t = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && el.contains(active)) return;
      const first = el.querySelector<HTMLElement>("[data-initial-focus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== "Tab" || !el) return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const visible = all.filter((n) => n.offsetParent !== null || n === document.activeElement);
      const nodes = visible.length > 0 ? visible : all;
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && el.contains(active);
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      returnTo.current?.focus();
    };
  }, [open, ref]);
}
export type Tone = "ok" | "warn" | "down" | "checking" | "off";

/**
 * A message reference resolved at the render site: a key in the catalog's
 * "systemStatus" namespace plus its ICU values. Keeps deriveStatus pure while
 * the component tree owns translation.
 */
export interface StatusMessage {
  key: string;
  values?: Record<string, string | number>;
}

export interface SystemRow {
  id: string;
  /** Product/provider name (ComfyUI, Ollama, OpenAI, …) — never translated. */
  label: string;
  /** One line of detail, e.g. "1 model · live progress connected" or "key ends …NPoA". */
  detail: StatusMessage;
  tone: Tone;
  /** Optional action shown at the end of the row. */
  action?: { label: StatusMessage; onClick: () => void };
}

/** The Safelight mark: an ink tile holding a paper disc and an accent crescent. */
export function SafelightMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-ink", className)}>
      <span className="absolute size-3.5 -translate-x-[3px] rounded-full bg-paper-2" />
      <span className="absolute size-3.5 translate-x-[3px] rounded-full bg-terracotta mix-blend-multiply" />
    </span>
  );
}
