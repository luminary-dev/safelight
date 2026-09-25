import "server-only";
import path from "node:path";

/** Shared on-disk locations. scripts/comfy.sh points ComfyUI at the same folders. */
export const OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR ?? path.resolve(process.cwd(), "..", "outputs");
export const INPUT_DIR = process.env.COMFY_INPUT_DIR ?? path.resolve(process.cwd(), "..", "inputs");

/** Joins under a root and refuses anything that escapes it. */
export function safeJoin(root: string, ...parts: string[]): string | null {
  const full = path.resolve(root, ...parts.filter(Boolean));
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

/** Parses a ComfyUI-style input reference like "studio/a.png" or "studio/qwen_0001.png [output]". */
export function parseImageRef(ref: string): { dir: string; subfolder: string; filename: string } {
  const m = ref.match(/^(.*?)(?:\s\[(input|output|temp)\])?$/);
  const rel = m?.[1] ?? ref;
  const type = m?.[2] ?? "input";
  const filename = path.basename(rel);
  const subfolder = path.dirname(rel) === "." ? "" : path.dirname(rel);
  return { dir: type === "output" ? OUTPUT_DIR : INPUT_DIR, subfolder, filename };
}
