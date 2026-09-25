import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import type { GalleryItem } from "@/lib/comfy/types";
import { safeJoin } from "@/lib/studio-files";

/** Where ComfyUI writes results. scripts/comfy.sh points it at <studio>/outputs. */
import { OUTPUT_DIR } from "@/lib/studio-files";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

async function walk(dir: string, rel = ""): Promise<GalleryItem[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items: GalleryItem[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push(...(await walk(full, rel ? `${rel}/${entry.name}` : entry.name)));
    } else if (IMAGE_EXT.test(entry.name)) {
      const s = await stat(full);
      items.push({ filename: entry.name, subfolder: rel, type: "output", mtime: s.mtimeMs, size: s.size });
    }
  }
  return items;
}

export async function GET() {
  const items = await walk(OUTPUT_DIR);
  items.sort((a, b) => b.mtime - a.mtime);
  return Response.json({ items: items.slice(0, 400), dir: OUTPUT_DIR });
}

/** Deletes one rendered image from the outputs folder. Body: { filename, subfolder }. */
export async function DELETE(request: NextRequest) {
  let body: { filename?: string; subfolder?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const filename = body.filename ?? "";
  const subfolder = body.subfolder ?? "";
  if (!filename || !IMAGE_EXT.test(filename) || filename.includes("/") || filename.includes("..") || subfolder.includes("..")) {
    return Response.json({ error: "Bad file reference." }, { status: 400 });
  }
  const full = safeJoin(OUTPUT_DIR, subfolder, filename);
  if (!full) return Response.json({ error: "Bad file reference." }, { status: 400 });
  try {
    await unlink(full);
    return Response.json({ ok: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return Response.json({ error: code === "ENOENT" ? "Already gone." : "Could not delete the file." }, { status: code === "ENOENT" ? 404 : 500 });
  }
}
