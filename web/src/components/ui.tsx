"use client";

import type { ReactNode } from "react";
import { Select as ShadSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="font-display text-[13px] font-medium text-ink">{children}</span>
      {hint ? <span className="font-mono text-[11px] text-faint">{hint}</span> : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Safelight-styled shadcn Select. An empty value renders the placeholder; pass a "" option to allow clearing. */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const NONE = "__none__";
  return (
    <ShadSelect value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger aria-label={ariaLabel} className={`h-9 w-full rounded-[10px] border-line bg-paper-2 px-3 font-mono text-xs text-ink shadow-none hover:border-faint data-placeholder:text-placeholder ${className}`}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="rounded-[12px] border border-line bg-paper-2 shadow-[var(--shadow-raised)] ring-0">
        {options.map((o) => (
          <SelectItem key={o.value || NONE} value={o.value || NONE} className="rounded-[8px] py-1.5 pl-2 pr-8 font-mono text-xs focus:bg-pill/70">
            {o.label || placeholder}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadSelect>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-terracotta"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="field w-[76px] px-2 py-1 text-right font-mono text-xs"
      />
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm text-ink">
      <span>{label}</span>
      <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${checked ? "border-green bg-green" : "border-line bg-pill"}`}>
        <span className={`absolute left-0.5 h-3.5 w-3.5 rounded-full bg-paper-2 shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`} />
      </span>
    </button>
  );
}

export function Pill({ active, children, onClick, title, disabled }: { active?: boolean; children: ReactNode; onClick?: () => void; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className="pill" data-active={active ? "true" : "false"} aria-pressed={active} onClick={onClick} title={title} disabled={disabled}>
      {children}
    </button>
  );
}
