import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const SKIP = new Set(["node_modules", "Library", ".Trash"]);

/** Lists the folders inside a directory so the code workspace can browse to a project. Directories only, no file contents. */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("path")?.trim();
  const target = raw && path.isAbsolute(raw) ? path.resolve(raw) : homedir();
  const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
  if (!entries) return Response.json({ error: "That folder cannot be opened." }, { status: 400 });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return Response.json({ path: target, parent: parent === target ? null : parent, home: homedir(), dirs });
}
