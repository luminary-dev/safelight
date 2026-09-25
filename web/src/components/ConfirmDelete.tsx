"use client";

import { Trash2 } from "lucide-react";
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
  title = "Delete this image?",
  description,
}: {
  trigger: ReactNode;
  filename: string;
  onConfirm: () => void | Promise<void>;
  title?: string;
  description?: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className="card-raised max-w-[420px] gap-4 border-line bg-paper-2 p-6">
        <AlertDialogHeader className="gap-1.5">
          <AlertDialogTitle className="font-display text-lg font-medium tracking-[-0.01em] text-ink">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-relaxed text-ink-muted">
            {description ?? (
              <>
                <span className="font-mono text-xs text-ink">{filename}</span> is removed from the outputs folder on disk. This cannot be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className="btn-quiet h-auto border-line">Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()} className="h-auto rounded-[10px] bg-danger px-4 py-2 font-display text-sm font-medium text-paper-2 hover:bg-danger/90">
            <Trash2 className="size-4" /> Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
