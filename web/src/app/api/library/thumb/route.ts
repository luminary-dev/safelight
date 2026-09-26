import { readFile, stat } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { resolveInOutputs } from "@/lib/library/confine";
import { ensureThumb, thumbPathFor } from "@/lib/library/thumbs";

/** Serves the 384px webp generated at index time. Anything outside outputs/ is a 403. */
export async function GET(request: NextRequest) {
  const rel = request.nextUrl.searchParams.get("path") ?? "";
  const abs = await resolveInOutputs(rel);
  if (!abs) return new Response("Forbidden", { status: 403 });

  let file = thumbPathFor(rel);
  let info = await stat(file).catch(() => null);
  if (!info) {
    const made = await ensureThumb(abs, rel);
    if (!made) return new Response("Not found", { status: 404 });
    file = made;
    info = await stat(file).catch(() => null);
    if (!info) return new Response("Not found", { status: 404 });
  }

  // Thumb names are keyed by path, not content — revalidate like /api/view does.
  const cache = "private, max-age=0, must-revalidate";
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cache } });
  }
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/webp", "cache-control": cache, etag, "last-modified": new Date(info.mtimeMs).toUTCString() },
  });
}
