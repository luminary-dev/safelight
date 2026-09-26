"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Destructive confirmation for removing a rendered image from disk. */
export function ConfirmDelete({
  trigger,
  filename,
  onConfirm,
  title,
  description,
}: {
  trigger: ReactNode;
  filename: string;
  onConfirm: () => void | Promise<void>;
  title?: string;
  description?: ReactNode;
}) {
  const t = useTranslations("confirmDelete");
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className="card-raised max-w-[420px] gap-4 border-line bg-paper-2 p-6">
        <AlertDialogHeader className="gap-1.5">
          <AlertDialogTitle className="font-display text-lg font-medium tracking-[-0.01em] text-ink">{title ?? t("defaultTitle")}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-relaxed text-ink-muted">
            {description ??
              t.rich("defaultDescription", {
                filename,
                file: (chunks) => <span className="font-mono text-xs text-ink">{chunks}</span>,
              })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className="btn-quiet h-auto border-line">{t("keep")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()} className="h-auto rounded-[10px] bg-danger px-4 py-2 font-display text-sm font-medium text-paper-2 hover:bg-danger/90">
            <Trash2 className="size-4" /> {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
