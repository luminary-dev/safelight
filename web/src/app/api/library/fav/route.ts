import type { NextRequest } from "next/server";
import { ensureIndex } from "@/lib/library";
import { setFavorite } from "@/lib/library/search";

/** Toggles the favorite flag on one library item. Body: { path, favorite }. */
export async function POST(request: NextRequest) {
  let body: { path?: unknown; favorite?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.path !== "string" || !body.path || typeof body.favorite !== "boolean") {
    return Response.json({ error: "Expected { path, favorite }." }, { status: 400 });
  }
  await ensureIndex();
  if (!setFavorite(body.path, body.favorite)) return Response.json({ error: "No such item." }, { status: 404 });
  return Response.json({ ok: true, favorite: body.favorite });
}
