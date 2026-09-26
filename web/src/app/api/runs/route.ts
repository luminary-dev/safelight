import type { NextRequest } from "next/server";
import { listRuns } from "@/lib/agent/runs-store";

/** Persisted agent runs, newest first. */
export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? raw : 50;
  return Response.json({ runs: listRuns(limit) });
}
