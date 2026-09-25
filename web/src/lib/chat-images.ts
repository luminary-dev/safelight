import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatImage, ChatTurn } from "@/lib/providers/types";
import { parseImageRef, safeJoin } from "@/lib/studio-files";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export interface WireMessage {
  role: string;
  content: string;
  images?: { ref: string }[];
}

/** Loads attached images from the studio input/output folders and base64-encodes them for the providers. */
export async function toTurns(messages: WireMessage[], limit = 30): Promise<ChatTurn[]> {
  const turns: ChatTurn[] = [];
  for (const m of messages.slice(-limit)) {
    if (!(m.role === "user" || m.role === "assistant")) continue;
    if (typeof m.content !== "string") continue;
    let images: ChatImage[] | undefined;
    if (m.role === "user" && m.images?.length) {
      images = [];
      for (const att of m.images.slice(0, 6)) {
        const { dir, subfolder, filename } = parseImageRef(att.ref);
        const full = safeJoin(dir, subfolder, filename);
        if (!full) continue;
        try {
          const bytes = await readFile(full);
          images.push({ mime: MIME[path.extname(filename).toLowerCase()] ?? "image/png", data: bytes.toString("base64") });
        } catch {
          /* skip missing files */
        }
      }
    }
    if (!m.content.trim() && !images?.length) continue;
    turns.push({ role: m.role, content: m.content, images });
  }
  return turns;
}
