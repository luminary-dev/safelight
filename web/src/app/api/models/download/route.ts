import { cancelDownload, listDownloads, startDownload } from "@/lib/models/download";
import { SELECTABLE_KINDS } from "@/lib/models/kinds";
import { resolveModelPaths, targetDirForKind } from "@/lib/models/paths";
import type { FileKind } from "@/lib/models/types";

export const runtime = "nodejs";

/** GET /api/models/download — poll all download progress. */
export async function GET() {
  return Response.json({ root: resolveModelPaths().root, downloads: listDownloads() });
}

interface StartBody {
  url?: string;
  fileName?: string;
  kind?: FileKind;
  sizeBytes?: number | null;
  sha256?: string;
}

/** POST /api/models/download — start a download into the right models subfolder. */
export async function POST(req: Request) {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { url, fileName, kind } = body;
  if (!url || !fileName || !kind) return Response.json({ error: "url, fileName and kind are required." }, { status: 400 });
  if (!SELECTABLE_KINDS.includes(kind as Exclude<FileKind, "unknown">)) {
    return Response.json({ error: `Unknown kind "${kind}" — pick a target folder first.` }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "Invalid download URL." }, { status: 400 });
  }
  if (parsed.protocol !== "https:") return Response.json({ error: "Only https downloads are allowed." }, { status: 400 });

  const targetDir = targetDirForKind(kind);
  if (!targetDir) return Response.json({ error: "No target folder for that kind." }, { status: 400 });

  try {
    const { id } = startDownload({ url, targetDir, fileName, sizeBytes: body.sizeBytes ?? null, sha256: body.sha256 });
    return Response.json({ id, targetDir, root: resolveModelPaths().root });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not start the download." }, { status: 409 });
  }
}

/** DELETE /api/models/download?id=... — cancel (or clear) a download. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id." }, { status: 400 });
  if (!cancelDownload(id)) return Response.json({ error: "Unknown download id." }, { status: 404 });
  return Response.json({ ok: true });
}
