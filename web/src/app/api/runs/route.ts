import type { NextRequest } from "next/server";
import { activeRunFor } from "@/lib/agent/run-registry";
import { getRunRow, listRuns } from "@/lib/agent/runs-store";

/**
 * Persisted agent runs, newest first — or, with ?activeFor=<clientId>, the
 * still-running run for that client id (what a reloaded page asks before
 * re-attaching via /api/runs/[id]/stream).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const activeFor = url.searchParams.get("activeFor");
  if (activeFor !== null) {
    const live = activeRunFor(activeFor);
    if (!live) return Response.json({ run: null });
    const row = getRunRow(live.id);
    return Response.json({ run: { id: live.id, startedAt: live.startedAt, seq: live.seq, provider: row?.provider, model: row?.model, mode: row?.mode } });
  }
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? raw : 50;
  return Response.json({ runs: listRuns(limit) });
}
