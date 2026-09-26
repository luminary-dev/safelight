import { cn } from "@/lib/utils";

export type TopMode = "chat" | "image" | "code" | "design" | "library" | "blueprints";
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

/** The Safelight mark: an ink tile holding a paper disc and an accent crescent. */
export function SafelightMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-ink", className)}>
      <span className="absolute size-3.5 -translate-x-[3px] rounded-full bg-paper-2" />
      <span className="absolute size-3.5 translate-x-[3px] rounded-full bg-terracotta mix-blend-multiply" />
    </span>
  );
}
