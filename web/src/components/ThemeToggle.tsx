"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ThemePref = "light" | "dark";
const KEY = "safelight.theme";

function apply(pref: ThemePref) {
  document.documentElement.classList.toggle("dark", pref === "dark");
}

/** Two states only, light by default. The layout script applies the saved choice before hydration. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("themeToggle");
  const [pref, setPref] = useState<ThemePref>(() => {
    if (typeof window === "undefined") return "light";
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("theme") as ThemePref | null;
      if (fromUrl === "light" || fromUrl === "dark") return fromUrl;
      const saved = localStorage.getItem(KEY) ?? localStorage.getItem("studio.theme");
      return saved === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });

  const toggle = useCallback(() => {
    setPref((p) => {
      const next: ThemePref = p === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* ignore */
      }
      apply(next);
      return next;
    });
  }, []);

  const Icon = pref === "light" ? Sun : Moon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" aria-label={pref === "light" ? t("switchToDark") : t("switchToLight")} onClick={toggle} className={className}>
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
        {pref === "light" ? t("tooltipLight") : t("tooltipDark")}
      </TooltipContent>
    </Tooltip>
  );
}
