import "server-only";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OUTPUT_DIR, safeJoin } from "@/lib/safelight-files";

/**
 * Resolves a library-relative path to an absolute file inside outputs/.
 * Lexically confined first (like api/view), then realpath-checked so a symlink
 * planted inside outputs cannot point the request somewhere else. Null means refuse.
 */
export async function resolveInOutputs(relPath: string, root: string = OUTPUT_DIR): Promise<string | null> {
  if (!relPath || relPath.includes("\0")) return null;
  const joined = safeJoin(root, relPath);
  if (!joined) return null;
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  const real = await realpath(joined).catch(() => null);
  if (!real) return null;
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  return joined;
}

/**
 * Validates a bulk-export destination: an absolute folder under the user's home.
 * Checked lexically before it is created, then realpath-checked afterwards so a
 * symlinked segment cannot land the copies outside home.
 */
export async function resolveExportDest(dest: string, home: string = os.homedir()): Promise<string | null> {
  if (!dest || !path.isAbsolute(dest) || dest.includes("\0")) return null;
  const resolved = path.resolve(dest);
  const within = (p: string, base: string) => p === base || p.startsWith(base + path.sep);
  if (!within(resolved, path.resolve(home))) return null;
  try {
    await mkdir(resolved, { recursive: true });
  } catch {
    return null;
  }
  const homeReal = await realpath(home).catch(() => null);
  const real = await realpath(resolved).catch(() => null);
  if (!homeReal || !real || !within(real, homeReal)) return null;
  return real;
}
