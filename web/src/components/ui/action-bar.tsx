"use client";

import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, type ReactElement, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** gap-2 between inline controls, in px — keep in sync with the bar's className. */
const GAP = 8;

export interface ActionBarAction {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Why the action is disabled — the title inline, and the menu item's title after collapse. */
  disabledReason?: string;
  /** Tooltip when enabled. */
  title?: string;
  /**
   * Destructive actions never render inline: they always live in the overflow
   * menu, behind whatever confirm flow `wrap` provides, and are never dropped.
   */
  destructive?: boolean;
  /** Collapse order: higher collapses sooner. Equal priorities collapse right-to-left. Defaults to the index. */
  priority?: number;
  /** Renders as a link instead of a button (downloads, open-in-new-tab). */
  href?: string;
  download?: string;
  /** Opens the link in a new tab. */
  external?: boolean;
  /** Icon-only inline (the label becomes the aria-label); the menu always shows the label. */
  iconOnly?: boolean;
  /** Extra classes for the inline control (danger tints and the like). */
  className?: string;
  /** Wraps the rendered control — inline or menu item — e.g. in a confirm-dialog trigger. */
  wrap?: (control: ReactElement) => ReactElement;
}

interface Layout {
  available: number;
  widths: Record<string, number>;
  more: number;
}

function sameLayout(a: Layout, b: Layout): boolean {
  if (a.available !== b.available || a.more !== b.more) return false;
  const ak = Object.keys(a.widths);
  return ak.length === Object.keys(b.widths).length && ak.every((k) => a.widths[k] === b.widths[k]);
}

/**
 * A responsive toolbar (UI-RESPONSIVE-BRIEF §2): it measures its container and
 * lays actions out inline while they fit; when they stop fitting it keeps the
 * highest-priority actions inline and collapses the rest into a "More" menu.
 * Destructive actions are always in the menu, the bar never clips (no shrink-0
 * anywhere), and every collapsed action stays reachable by keyboard.
 */
export function ActionBar({ actions, label, primaryCount, className }: { actions: ActionBarAction[]; label: string; primaryCount?: number; className?: string }) {
  const t = useTranslations("actionBar");
  const outerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Re-measure only when the rendered content can change size, not on every parent render.
  const signature = actions.map((a) => `${a.key}\u0000${a.label}\u0000${a.iconOnly ? 1 : 0}\u0000${a.destructive ? 1 : 0}`).join("\u0001");

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const ghost = ghostRef.current;
    if (!outer || !ghost || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const widths: Record<string, number> = {};
      let more = 0;
      for (const child of Array.from(ghost.children)) {
        const el = child as HTMLElement;
        const key = el.dataset.measureKey;
        if (!key) continue;
        if (key === "__more__") more = el.offsetWidth;
        else widths[key] = el.offsetWidth;
      }
      const next: Layout = { available: outer.clientWidth, widths, more };
      setLayout((prev) => (prev && sameLayout(prev, next) ? prev : next));
    };
    // ResizeObserver delivers an initial notification on observe (before first
    // paint), so this measures on mount and again on every resize.
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(ghost);
    return () => ro.disconnect();
  }, [signature]);

  const { inline, overflow } = useMemo(() => {
    const candidates = actions.filter((a) => !a.destructive);
    const destructive = actions.filter((a) => a.destructive);
    const split = (keptKeys: Set<string>) => ({
      inline: candidates.filter((a) => keptKeys.has(a.key)),
      overflow: [...candidates.filter((a) => !keptKeys.has(a.key)), ...destructive],
    });
    // Unmeasured (SSR, first frame): everything non-destructive inline — the
    // widest honest default; the first ResizeObserver tick corrects it pre-paint.
    if (!layout) return split(new Set(candidates.map((a) => a.key)));
    // Lowest priority value stays inline longest; ties collapse right-to-left.
    const order = candidates.map((a, i) => ({ a, i, p: a.priority ?? i })).sort((x, y) => x.p - y.p || x.i - y.i);
    const cap = primaryCount ?? order.length;
    for (let n = order.length; n >= 0; n--) {
      const kept = order.slice(0, n);
      const collapsed = order.length - n + destructive.length;
      const needMore = collapsed > 0;
      if (needMore && n > cap) continue;
      const width =
        kept.reduce((sum, k) => sum + (layout.widths[k.a.key] ?? 0), 0) + (needMore ? layout.more : 0) + Math.max(0, kept.length + (needMore ? 1 : 0) - 1) * GAP;
      if (width <= layout.available || n === 0) return split(new Set(kept.map((k) => k.a.key)));
    }
    return split(new Set<string>());
  }, [actions, layout, primaryCount]);

  // Arrow keys move focus through the menu, per the menu role's contract.
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1 + items.length) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={outerRef} data-action-bar="" role="toolbar" aria-label={label} className={cn("relative flex min-w-0 min-h-9 flex-1 items-center justify-end", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {inline.map((a) => (
          <InlineControl key={a.key} action={a} />
        ))}
        {overflow.length > 0 ? (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="btn-quiet px-2" aria-label={t("moreActionsAria")} aria-haspopup="menu" title={t("more")}>
                <MoreHorizontal className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} role="menu" aria-label={t("moreActionsAria")} onKeyDown={onMenuKeyDown} className="glass w-[240px] gap-0.5 rounded-[14px] p-1.5 ring-0">
              {overflow.map((a) => (
                <MenuItem key={a.key} action={a} onDone={() => setMenuOpen(false)} />
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {/* Invisible measurement row: the natural width of every candidate control plus the More trigger. */}
      <div ref={ghostRef} aria-hidden className="pointer-events-none invisible absolute end-0 top-0 -z-10 flex items-center gap-2 whitespace-nowrap">
        {actions
          .filter((a) => !a.destructive)
          .map((a) => (
            <span key={a.key} data-measure-key={a.key} className={cn("btn-quiet", a.iconOnly && "px-2", a.className)}>
              {a.icon}
              {a.iconOnly ? null : a.label}
            </span>
          ))}
        <span data-measure-key="__more__" className="btn-quiet px-2">
          <MoreHorizontal className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function InlineControl({ action }: { action: ActionBarAction }) {
  const title = (action.disabled ? action.disabledReason : undefined) ?? action.title;
  const cls = cn("btn-quiet no-underline", action.iconOnly && "px-2", action.className);
  const control = action.href ? (
    <a className={cls} href={action.href} download={action.download} target={action.external ? "_blank" : undefined} rel={action.external ? "noreferrer" : undefined} aria-label={action.iconOnly ? action.label : undefined} title={title} onClick={action.onSelect}>
      {action.icon}
      {action.iconOnly ? null : action.label}
    </a>
  ) : (
    <button type="button" className={cls} disabled={action.disabled} aria-label={action.iconOnly ? action.label : undefined} title={title} onClick={() => action.onSelect?.()}>
      {action.icon}
      {action.iconOnly ? null : action.label}
    </button>
  );
  return action.wrap ? action.wrap(control) : control;
}

function MenuItem({ action, onDone }: { action: ActionBarAction; onDone: () => void }) {
  const title = (action.disabled ? action.disabledReason : undefined) ?? action.title;
  const cls = cn(
    "flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-start font-display text-[13px] font-medium text-ink no-underline transition-colors hover:bg-pill/60 disabled:cursor-not-allowed disabled:opacity-50",
    action.destructive && "text-danger hover:bg-danger-wash",
  );
  const item = action.href ? (
    <a
      role="menuitem"
      className={cls}
      href={action.href}
      download={action.download}
      target={action.external ? "_blank" : undefined}
      rel={action.external ? "noreferrer" : undefined}
      title={title}
      onClick={() => {
        action.onSelect?.();
        onDone();
      }}
    >
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
    </a>
  ) : (
    <button
      type="button"
      role="menuitem"
      className={cls}
      disabled={action.disabled}
      title={title}
      onClick={() => {
        // A wrapped action (confirm flow) owns the click: closing the menu here
        // would unmount the confirm dialog with it.
        if (action.wrap) return;
        action.onSelect?.();
        onDone();
      }}
    >
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
    </button>
  );
  return action.wrap ? action.wrap(item) : item;
}
