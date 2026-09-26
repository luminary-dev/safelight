import { type RefObject, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type TopMode = "chat" | "image" | "code" | "design" | "library" | "blueprints";

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
