import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { takeToken } from "@/lib/db/rate-limit";

const SKIP = new Set(["node_modules", "Library", ".Trash"]);

/** Folders the picker may enter: the user's home subtree, plus SAFELIGHT_BROWSE_ROOTS entries. */
function browseRoots(): string[] {
  const extra = (process.env.SAFELIGHT_BROWSE_ROOTS ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p && path.isAbsolute(p))
    .map((p) => path.resolve(p));
  return [path.resolve(homedir()), ...extra];
}

function withinRoots(target: string): boolean {
  return browseRoots().some((root) => target === root || target.startsWith(root + path.sep));
}

/** Lists the folders inside a directory so the code workspace can browse to a project. Directories only, home-subtree only. */
export async function GET(request: NextRequest) {
  if (!takeToken("browse", 120, 40)) return Response.json({ error: "Slow down — too many folder listings." }, { status: 429 });
  const raw = request.nextUrl.searchParams.get("path")?.trim();
  const wanted = raw && path.isAbsolute(raw) ? path.resolve(raw) : homedir();
  const target = withinRoots(wanted) ? wanted : path.resolve(homedir());
  const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
  if (!entries) return Response.json({ error: "That folder cannot be opened." }, { status: 400 });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .filter((d) => withinRoots(d.path))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return Response.json({ path: target, parent: withinRoots(parent) && parent !== target ? parent : null, home: homedir(), dirs });
}
