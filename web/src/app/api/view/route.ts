import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { fetchView } from "@/lib/comfy/client";
import { INPUT_DIR, OUTPUT_DIR, safeJoin } from "@/lib/safelight-files";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Serves an image from the output or input folders, falling back to ComfyUI's /view. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const filename = q.get("filename");
  if (!filename || filename.includes("..")) return new Response("Bad filename", { status: 400 });
  const subfolder = q.get("subfolder") ?? "";
  if (subfolder.includes("..")) return new Response("Bad subfolder", { status: 400 });
  const type = q.get("type") === "input" ? "input" : "output";
  // File names repeat after deletes (ComfyUI restarts its counter), so revalidate instead of caching forever.
  const cache = "private, max-age=0, must-revalidate";

  const local = safeJoin(type === "output" ? OUTPUT_DIR : INPUT_DIR, subfolder, filename);
  if (local) {
    try {
      const info = await stat(local);
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag, "cache-control": cache } });
      }
      const bytes = await readFile(local);
      return new Response(bytes, {
        headers: {
          "content-type": MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
          "cache-control": cache,
          etag,
          "last-modified": new Date(info.mtimeMs).toUTCString(),
        },
      });
    } catch {
      /* fall through to ComfyUI */
    }
  }
  const upstream = await fetchView({ filename, subfolder, type }).catch(() => null);
  if (!upstream?.ok) return new Response("Not found", { status: 404 });
  return new Response(upstream.body, { headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control": cache } });
}
