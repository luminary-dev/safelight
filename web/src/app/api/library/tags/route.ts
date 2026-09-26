import type { NextRequest } from "next/server";
import { ensureIndex } from "@/lib/library";
import { updateTags } from "@/lib/library/search";

const asList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Adds and/or removes tags on one item. Body: { path, add?, remove? } (string or string[]). */
export async function POST(request: NextRequest) {
  let body: { path?: unknown; add?: unknown; remove?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.path !== "string" || !body.path) return Response.json({ error: "Expected { path, add?, remove? }." }, { status: 400 });
  await ensureIndex();
  const tags = updateTags(body.path, asList(body.add), asList(body.remove));
  if (tags === null) return Response.json({ error: "No such item." }, { status: 404 });
  return Response.json({ ok: true, tags });
}
