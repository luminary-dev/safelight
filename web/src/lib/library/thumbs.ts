import "server-only";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { dataDir } from "@/lib/db";

export const THUMB_WIDTH = 384;

/** Where the 384px preview for one library path lives: data/thumbs/<sha1 of path>.webp. */
export function thumbPathFor(relPath: string): string {
  const sha = createHash("sha1").update(relPath).digest("hex");
  return path.join(dataDir(), "thumbs", `${sha}.webp`);
}

/**
 * Writes the webp thumbnail for one output file. `force` regenerates (the indexer
 * passes it when a file changed); otherwise an existing thumb is left alone.
 * Unreadable images resolve to null rather than throwing — the row still indexes.
 */
export async function ensureThumb(absPath: string, relPath: string, force = false): Promise<string | null> {
  const target = thumbPathFor(relPath);
  if (!force) {
    try {
      await stat(target);
      return target;
    } catch {
      /* build it */
    }
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toFile(target);
    return target;
  } catch {
    return null;
  }
}

export async function deleteThumb(relPath: string): Promise<void> {
  await rm(thumbPathFor(relPath), { force: true }).catch(() => undefined);
}
