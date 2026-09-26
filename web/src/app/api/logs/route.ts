import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { dataDir } from "@/lib/db";

export const runtime = "nodejs";

const MAX_LINES = 1000;

/** Tails the structured log (already secret-redacted at write time) for the Settings viewer. */
export async function GET(request: NextRequest) {
  const lines = Math.min(MAX_LINES, Math.max(1, Number(request.nextUrl.searchParams.get("lines")) || 200));
  const file = path.join(dataDir(), "logs", "safelight.log");
  const info = await stat(file).catch(() => null);
  if (!info) return Response.json({ lines: [], size: 0 });
  // Read only the tail: the last 256 KB is far more than MAX_LINES of pino output.
  const start = Math.max(0, info.size - 256 * 1024);
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(info.size - start);
    await handle.read(buf, 0, buf.length, start);
    const all = buf.toString("utf8").split("\n").filter(Boolean);
    return Response.json({ lines: all.slice(-lines), size: info.size });
  } finally {
    await handle.close();
  }
}
