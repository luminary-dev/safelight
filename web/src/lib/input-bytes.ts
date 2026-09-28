import "server-only";
import { readFile } from "node:fs/promises";
import { fetchView } from "@/lib/comfy/client";
import { parseImageRef, safeJoin } from "@/lib/safelight-files";

/**
 * Reads an image reference's bytes for provider calls. The file is normally on
 * disk, but when the app attaches to an externally launched ComfyUI, uploads
 * land in THAT install's input directory rather than ours — so a local miss
 * falls back to ComfyUI's /view, the same way /api/view serves previews.
 */
export async function readImageBytesForRef(ref: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const { dir, subfolder, filename } = parseImageRef(ref);
  const full = safeJoin(dir, subfolder, filename);
  if (!full) throw new Error(`Bad input reference: ${ref}`);
  try {
    return { bytes: new Uint8Array(await readFile(full)), filename };
  } catch (err) {
    const type = /\[output\]\s*$/.test(ref) ? "output" : "input";
    const upstream = await fetchView({ filename, subfolder, type }).catch(() => null);
    if (!upstream?.ok) throw err;
    return { bytes: new Uint8Array(await upstream.arrayBuffer()), filename };
  }
}
