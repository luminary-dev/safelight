import { copyFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { ensureIndex, forgetPaths } from "@/lib/library";
import { resolveExportDest, resolveInOutputs } from "@/lib/library/confine";

const MAX_PATHS = 1000;

/** Picks a collision-free name in dest: a.png, a-1.png, a-2.png… */
async function freeName(dest: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let n = 0; n < 100; n++) {
    const candidate = path.join(dest, n === 0 ? filename : `${stem}-${n}${ext}`);
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
  return path.join(dest, `${stem}-${Date.now()}${ext}`);
}

/**
 * Bulk actions on library items. Body: { paths, action: "export"|"delete", dest? }.
 * Export copies files (and their sidecars) to a folder under the user's home;
 * delete removes files, sidecars, thumbnails and index rows. The UI confirms
 * deletes before calling here.
 */
export async function POST(request: NextRequest) {
  let body: { paths?: unknown; action?: unknown; dest?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  if (paths.length === 0 || paths.length > MAX_PATHS) return Response.json({ error: "Expected 1–1000 paths." }, { status: 400 });
  const action = body.action;
  if (action !== "export" && action !== "delete") return Response.json({ error: "Action must be export or delete." }, { status: 400 });
  await ensureIndex();

  if (action === "export") {
    if (typeof body.dest !== "string") return Response.json({ error: "Export needs a dest folder." }, { status: 400 });
    const dest = await resolveExportDest(body.dest);
    if (!dest) return Response.json({ error: "Destination must be an absolute folder inside your home." }, { status: 403 });
    let exported = 0;
    const skipped: string[] = [];
    for (const rel of paths) {
      const abs = await resolveInOutputs(rel);
      if (!abs) {
        skipped.push(rel);
        continue;
      }
      try {
        const target = await freeName(dest, path.basename(rel));
        await copyFile(abs, target);
        await copyFile(`${abs}.json`, `${target}.json`).catch(() => undefined); // sidecar travels along when present
        exported++;
      } catch {
        skipped.push(rel);
      }
    }
    return Response.json({ ok: true, exported, skipped, dest });
  }

  // delete
  let deleted = 0;
  const skipped: string[] = [];
  const gone: string[] = [];
  for (const rel of paths) {
    const abs = await resolveInOutputs(rel);
    if (!abs) {
      skipped.push(rel);
      continue;
    }
    try {
      await rm(abs, { force: true });
      await rm(`${abs}.json`, { force: true });
      gone.push(rel);
      deleted++;
    } catch {
      skipped.push(rel);
    }
  }
  await forgetPaths(gone);
  return Response.json({ ok: true, deleted, skipped });
}
