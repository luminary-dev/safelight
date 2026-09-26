"use client";

import { ChevronDown, Image as ImageIcon, KeyRound, MessageSquare, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type TopMode = "chat" | "image" | "code" | "design" | "library";
export type Tone = "ok" | "warn" | "down" | "checking" | "off";

export interface SystemRow {
  id: string;
  label: string;
  /** One line of detail, e.g. "1 model · live progress connected" or "key ends …NPoA". */
  detail: string;
  tone: Tone;
  /** Optional action shown at the right of the row. */
  action?: { label: string; onClick: () => void };
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-green",
  warn: "bg-terracotta",
  down: "bg-danger",
  checking: "bg-faint pulse",
  off: "bg-line",
};

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-green",
  warn: "text-terracotta-deep",
  down: "text-danger",
  checking: "text-ink-muted",
  off: "text-faint",
};

/** A simple geometric mark: an ink tile with a paper disc and a terracotta crescent, no brand borrowing. */
export function StudioMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-ink", className)}>
      <span className="absolute size-3.5 -translate-x-[3px] rounded-full bg-paper-2" />
      <span className="absolute size-3.5 translate-x-[3px] rounded-full bg-terracotta mix-blend-multiply" />
    </span>
  );
}

function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span className={cn("relative grid size-2 place-items-center", className)}>
      {tone === "ok" ? <span className="absolute size-2 animate-ping rounded-full bg-green/40 [animation-duration:2.4s]" /> : null}
      <span className={cn("size-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

export function Header({
  mode,
  onMode,
  overall,
  systems,
  onRefresh,
  onKeys,
  defaultOpen = false,
}: {
  mode: TopMode;
  onMode: (m: TopMode) => void;
  overall: { tone: Tone; label: string };
  systems: SystemRow[];
  onRefresh: () => void;
  onKeys: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [spinning, setSpinning] = useState(false);
  const recheck = () => {
    setSpinning(true);
    onRefresh();
    setTimeout(() => setSpinning(false), 900);
  };

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-[clamp(20px,5vw,56px)] py-[18px]">
      <div className="flex items-center gap-2.5">
        <StudioMark />
        <span className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Safelight<span className="text-terracotta">.</span>
        </span>
      </div>

      <ToggleGroup type="single" value={mode} onValueChange={(v) => v && onMode(v as TopMode)} spacing={0} className="rounded-full bg-pill p-[3px]" aria-label="Mode">
        {(
          [
            ["chat", "Chat", MessageSquare],
            ["image", "Image", ImageIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="h-8 gap-1.5 rounded-full! px-4 font-display text-sm font-medium text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgba(35,33,29,0.12)]"
          >
            <Icon className="size-3.5" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center justify-end gap-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              aria-label="System status"
              className="h-8 gap-2 rounded-full border-line bg-paper-2 pl-2.5 pr-2 font-sans text-[13px] font-medium text-ink shadow-[var(--shadow-hairline)] hover:border-faint hover:bg-paper-2 aria-expanded:border-faint aria-expanded:bg-paper-2"
            >
              <Dot tone={overall.tone} />
              <span className={cn(overall.tone === "checking" && "text-ink-muted")}>{overall.label}</span>
              <ChevronDown className={cn("size-3.5 text-faint transition-transform", open && "rotate-180")} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="w-[340px] gap-0 rounded-2xl border border-line bg-paper-2 p-0 shadow-[var(--shadow-raised)] ring-0"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="eyebrow text-faint">Systems</span>
              <button type="button" onClick={recheck} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted hover:text-ink">
                <RefreshCw className={cn("size-3", spinning && "animate-spin")} /> Re-check
              </button>
            </div>
            <ul className="p-1.5">
              {systems.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 hover:bg-pill/60">
                  <Dot tone={s.tone} className="size-2.5" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="font-display text-sm font-medium text-ink">{s.label}</span>
                    <span className={cn("truncate font-mono text-[11px]", TONE_TEXT[s.tone])}>{s.detail}</span>
                  </span>
                  {s.action ? (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        s.action!.onClick();
                      }}
                      className="shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-faint hover:text-ink"
                    >
                      {s.action.label}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" aria-label="API keys" onClick={onKeys} className="size-8 rounded-full border-line bg-paper-2 text-ink-muted shadow-[var(--shadow-hairline)] hover:border-faint hover:bg-paper-2 hover:text-ink">
              <KeyRound className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
            API keys
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
