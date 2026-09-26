"use client";

import { Check, ChevronDown, Cloud, Cpu, KeyRound, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type PickerProvider = "local" | "ollama" | "openai" | "anthropic" | "gemini" | "openrouter" | "groq";

export interface PickerOption {
  /** Unique key across all groups. */
  key: string;
  label: string;
  tags?: string[];
  provider: PickerProvider;
  /** Secondary line, e.g. a file name or capability note. */
  hint?: string;
  disabled?: boolean;
}

export const PROVIDER_META: Record<PickerProvider, { label: string; short: string; group: string }> = {
  local: { label: "Local", short: "Local", group: "On this Mac" },
  ollama: { label: "Ollama", short: "Ollama", group: "On this Mac" },
  openai: { label: "OpenAI", short: "OpenAI", group: "OpenAI" },
  anthropic: { label: "Anthropic", short: "Anthropic", group: "Anthropic" },
  gemini: { label: "Gemini", short: "Gemini", group: "Gemini" },
  openrouter: { label: "OpenRouter", short: "OR", group: "OpenRouter" },
  groq: { label: "Groq", short: "Groq", group: "Groq" },
};

const GROUP_ORDER: PickerProvider[] = ["local", "ollama", "openai", "anthropic", "gemini", "openrouter", "groq"];

/** Small square mark that gives each row a visual anchor without borrowing brand logos. */
export function ProviderMark({ provider, className }: { provider: PickerProvider; className?: string }) {
  const isLocal = provider === "local" || provider === "ollama";
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[9px] border font-mono text-[11px] font-medium tracking-tight",
        isLocal ? "border-green/25 bg-green-wash text-green" : "border-terracotta/20 bg-terracotta-wash text-terracotta-deep",
        className,
      )}
    >
      {provider === "local" ? <Cpu className="size-4" /> : provider === "ollama" ? "OL" : provider === "openai" ? "OA" : provider === "anthropic" ? "AN" : "GE"}
    </span>
  );
}

export function ModelPicker({
  options,
  value,
  onChange,
  placeholder = "Choose a model",
  emptyHint,
  onAddKey,
  className,
  align = "start",
  size = "default",
  defaultOpen = false,
  side = "bottom",
}: {
  options: PickerOption[];
  value: string | null;
  onChange: (key: string) => void;
  placeholder?: string;
  /** Shown when there are no options at all. */
  emptyHint?: ReactNode;
  /** When provided, a footer action offers to add a cloud API key. */
  onAddKey?: () => void;
  className?: string;
  align?: "start" | "center" | "end";
  size?: "default" | "compact";
  defaultOpen?: boolean;
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const selected = options.find((o) => o.key === value) ?? null;
  const groups = useMemo(() => {
    const byProvider = new Map<PickerProvider, PickerOption[]>();
    for (const o of options) {
      if (!byProvider.has(o.provider)) byProvider.set(o.provider, []);
      byProvider.get(o.provider)!.push(o);
    }
    const merged = new Map<string, PickerOption[]>();
    for (const p of GROUP_ORDER) {
      const list = byProvider.get(p);
      if (!list) continue;
      const g = PROVIDER_META[p].group;
      merged.set(g, [...(merged.get(g) ?? []), ...list]);
    }
    return Array.from(merged.entries());
  }, [options]);
  const hasCloud = options.some((o) => o.provider !== "local" && o.provider !== "ollama");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-auto justify-start gap-3 rounded-[14px] border-line bg-paper-2 px-2.5 py-2 text-left shadow-[var(--shadow-hairline)] hover:border-faint hover:bg-paper-2 aria-expanded:border-faint aria-expanded:bg-paper-2",
            size === "compact" ? "rounded-full py-1.5 pl-1.5" : "min-w-[280px]",
            className,
          )}
        >
          {selected ? <ProviderMark provider={selected.provider} className={size === "compact" ? "size-6 rounded-full text-[9px] [&_svg]:size-3" : undefined} /> : <span className="grid size-8 place-items-center rounded-[9px] border border-dashed border-line text-faint"><Search className="size-4" /></span>}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className={cn("truncate font-display font-medium text-ink", size === "compact" ? "text-[13px]" : "text-sm")}>{selected?.label ?? placeholder}</span>
            {size !== "compact" ? (
              <span className="truncate font-mono text-[11px] text-ink-muted">
                {selected ? [PROVIDER_META[selected.provider].short, ...(selected.tags ?? [])].join(" · ") : options.length ? `${options.length} available` : "No models yet"}
              </span>
            ) : null}
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-faint transition-transform", open && "rotate-180")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} side={side} sideOffset={8} collisionPadding={12} className="glass w-[380px] gap-0 rounded-2xl p-0 ring-0">
        <Command className="rounded-2xl bg-transparent p-0" filter={(v, search, keywords) => ((v + " " + (keywords ?? []).join(" ")).toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <div className="border-b border-line p-2">
            <CommandInput placeholder="Search models" className="font-sans" />
          </div>
          <CommandList className="max-h-[360px] p-1.5">
            <CommandEmpty className="py-8 text-center text-sm text-ink-muted">{options.length === 0 ? emptyHint ?? "No models available." : "Nothing matches."}</CommandEmpty>
            {groups.map(([group, list], i) => (
              <div key={group}>
                {i > 0 ? <CommandSeparator className="my-1 bg-line" /> : null}
                <CommandGroup heading={group} className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-[10.5px] **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.12em] **:[[cmdk-group-heading]]:text-faint">
                  {list.map((o) => {
                    const on = o.key === value;
                    return (
                      <CommandItem
                        key={o.key}
                        value={o.key}
                        keywords={[o.label, PROVIDER_META[o.provider].label, ...(o.tags ?? []), o.hint ?? ""]}
                        disabled={o.disabled}
                        data-checked={on}
                        onSelect={() => {
                          onChange(o.key);
                          setOpen(false);
                        }}
                        className="group/row items-center gap-3 rounded-[10px] px-2 py-2 data-selected:bg-pill/70 [&>svg:last-child]:hidden"
                      >
                        <ProviderMark provider={o.provider} />
                        <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-display text-sm font-medium text-ink">{o.label}</span>
                            {o.provider !== "local" && o.provider !== "ollama" ? (
                              <Badge variant="outline" className="h-[18px] rounded-full border-line px-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">
                                <Cloud className="size-3" /> {PROVIDER_META[o.provider].short}
                              </Badge>
                            ) : null}
                          </span>
                          {(o.tags && o.tags.length > 0) || o.hint ? (
                            <span className="flex flex-wrap items-center gap-1">
                              {(o.tags ?? []).map((t) => (
                                <Badge key={t} variant="secondary" className="h-[18px] rounded-full bg-pill px-1.5 font-mono text-[10px] text-ink-muted">
                                  {t}
                                </Badge>
                              ))}
                              {o.hint ? <span className="truncate font-mono text-[10.5px] text-faint">{o.hint}</span> : null}
                            </span>
                          ) : null}
                        </span>
                        <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-green bg-green text-paper-2" : "border-line text-transparent group-data-selected/row:border-faint")}>
                          <Check className="size-3" />
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
          {onAddKey ? (
            <div className="border-t border-line p-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAddKey();
                }}
                className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-pill/70 hover:text-ink"
              >
                <span className="grid size-8 place-items-center rounded-[9px] border border-dashed border-line text-faint">
                  <KeyRound className="size-4" />
                </span>
                <span className="flex flex-col leading-tight">
                  <span className="font-display font-medium text-ink">{hasCloud ? "Manage API keys" : "Add a cloud provider"}</span>
                  <span className="font-mono text-[11px]">OpenAI, Anthropic, Gemini</span>
                </span>
              </button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
